import { Inject, Injectable, ForbiddenException, BadRequestException, NotFoundException } from '@nestjs/common';
import type { SessionUser } from '@acms/contracts';
import { authorize, type Principal } from '@acms/domain';
import { BaseClient, type BaseRecord } from '@acms/base-adapter';
import { TABLES } from '@acms/contracts';
import { BASE_CLIENT } from '../base.provider.js';
import { buildFilter, toFlatRecord } from '../shared/record.util.js';
import { SignDto } from './sign.dto.js';

const ATTENDANCE_TABLE = TABLES.attendance.tableId; // 考勤记录表 (tblUkd1JKi4T7XQb)
const ZONE_TABLE = TABLES.attendanceZone.tableId; // 考勤围栏表 (tbloFq0XJKpObwxQ)
const EARTH_RADIUS = 6371000; // 米

const READONLY = new Set<string>(['创建时间', '更新时间']);
const NUMBERS = new Set<string>(['签到距离(米)']);

function toPrincipal(user: SessionUser): Principal {
  return { roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel };
}

/** 把 "纬度,经度" 或 "纬度, 经度" 解析为 [lat, lng]（gcj02），非法返回 null */
function parseGps(gps?: string): [number, number] | null {
  if (!gps) return null;
  const parts = gps.split(',').map((s) => Number(s.trim()));
  if (parts.length !== 2) return null;
  const a = parts[0];
  const b = parts[1];
  if (typeof a !== 'number' || typeof b !== 'number' || Number.isNaN(a) || Number.isNaN(b)) return null;
  const out: [number, number] = [a, b];
  return out;
}

/** haversine 距离（米） */
function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.sqrt(a));
}

/** 按换行 / 逗号（含中文逗号）切分文本为去空白列表 */
function splitList(v: unknown): string[] {
  if (v == null) return [];
  const s = typeof v === 'string' ? v : String(v);
  return s
    .split(/[\n,，]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** 本地日期 YYYY-MM-DD（与飞书 fromReadFields 一致，取年月日） */
function localDate(at?: string): string {
  const d = at ? new Date(at) : new Date();
  if (Number.isNaN(d.getTime())) return localDate();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

interface Zone {
  id: string;
  校区: string;
  lat: number;
  lng: number;
  radius: number;
  ssid: string[];
  bssid: string[];
}

@Injectable()
export class SignService {
  constructor(@Inject(BASE_CLIENT) private readonly base: BaseClient) {}

  /** 读取所有启用的围栏配置 */
  private async loadZones(): Promise<Zone[]> {
    const res = await this.base.search(ZONE_TABLE, {
      pageSize: 100,
      filter: buildFilter([{ field: '状态', value: ['启用'] }]),
    });
    const zones: Zone[] = [];
    for (const r of res.items) {
      const f = r.fields;
      const lat = Number(f['围栏中心(纬度)']);
      const lng = Number(f['围栏中心(经度)']);
      if (Number.isNaN(lat) || Number.isNaN(lng)) continue; // 缺少中心点坐标的围栏跳过
      zones.push({
        id: r.recordId,
        校区: (f['校区'] as string) ?? '',
        lat,
        lng,
        radius: Number(f['围栏半径(米)']) || 200,
        ssid: splitList(f['WiFi_SSID列表']).map((s) => s.toLowerCase()),
        bssid: splitList(f['WiFi_BSSID列表'])
          .map((s) => s.toLowerCase())
          .map((s) => s.replace(/[:-]/g, '').toUpperCase()),
      });
    }
    return zones;
  }

  /** 取某学生某日已有的签到记录（按方向索引） */
  private async existingByDirection(studentId: string, dateStr: string): Promise<Map<string, BaseRecord>> {
    const res = await this.base.search(ATTENDANCE_TABLE, {
      pageSize: 100,
      filter: buildFilter([{ field: '关联学生编号', value: [studentId] }]),
    });
    const map = new Map<string, BaseRecord>();
    for (const r of res.items) {
      const f = r.fields;
      // 考勤日期为 datetime，取前 10 位 YYYY-MM-DD
      const d = typeof f['考勤日期'] === 'string' ? (f['考勤日期'] as string).slice(0, 10) : '';
      const dir = f['方向'] as string | undefined;
      if (d === dateStr && dir) map.set(dir, r);
    }
    return map;
  }

  async sign(user: SessionUser, dto: SignDto) {
    if (!authorize(toPrincipal(user), 'attendance:write').allowed)
      throw new ForbiddenException('FORBIDDEN:attendance:write');

    const gps = parseGps(dto.gps);
    const ssid = dto.ssid?.trim().toLowerCase() || '';
    const bssid = dto.bssid?.trim().replace(/[:-]/g, '').toUpperCase() || '';

    if (dto.mode === 'gps' && !gps) throw new BadRequestException('VALIDATION:gps 方式需提供合法 gps=纬度,经度');
    if (dto.mode === 'wifi' && !ssid && !bssid) throw new BadRequestException('VALIDATION:wifi 方式需提供 ssid 或 bssid');

    const dateStr = localDate(dto.at);
    const at = dto.at && !Number.isNaN(new Date(dto.at).getTime()) ? new Date(dto.at) : new Date();

    // 去重：先判定本应写入的方向（无到达则到达，已有到达则离开）
    const existing = await this.existingByDirection(dto.studentId, dateStr);
    const direction = existing.has('到达') ? '离开' : '到达';
    const dup = existing.get(direction);
    if (dup) {
      // 重复打卡：返回已有记录，不重复写
      return { duplicated: true, record: toFlatRecord(dup, READONLY, NUMBERS) };
    }

    // 围栏校验（GPS OR WiFi）
    const zones = await this.loadZones();
    let gpsMatch = false;
    let wifiMatch = false;
    let minDist = Number.POSITIVE_INFINITY;
    let matchedCampus = dto.campus ?? '';

    if (gps) {
      for (const z of zones) {
        const dist = haversine(gps[0], gps[1], z.lat, z.lng);
        if (dist < minDist) minDist = dist;
        if (dist <= z.radius) {
          gpsMatch = true;
          if (!matchedCampus) matchedCampus = z.校区;
        }
      }
    }
    if (ssid || bssid) {
      for (const z of zones) {
        if ((ssid && z.ssid.includes(ssid)) || (bssid && z.bssid.includes(bssid))) {
          wifiMatch = true;
          if (!matchedCampus) matchedCampus = z.校区;
        }
      }
    }
    const passed = gpsMatch || wifiMatch;

    const fields: Record<string, unknown> = {
      关联学生编号: [dto.studentId],
      考勤日期: dateStr,
      方向: direction,
      考勤状态: passed ? '正常' : '异常',
      签到方式: dto.mode,
      校区: matchedCampus,
    };
    if (direction === '到达') fields['到校时间'] = at.toISOString();
    else fields['离校时间'] = at.toISOString();

    if (dto.mode === 'wifi' && ssid) fields['签到WiFi_SSID'] = dto.ssid!.trim();
    if (gps) fields['签到GPS'] = dto.gps!.trim();
    if (gps && Number.isFinite(minDist)) fields['签到距离(米)'] = Math.round(minDist);
    // 校验通过记出勤；异常（未到围栏内）留待教师后续标记
    if (passed) fields['考勤结果'] = '出勤';

    const recordId = await this.base.create(ATTENDANCE_TABLE, fields);
    const rec = await this.base.get(ATTENDANCE_TABLE, recordId);
    if (!rec) throw new NotFoundException('NOT_FOUND');

    return {
      duplicated: false,
      passed,
      direction,
      method: dto.mode,
      distanceMeters: gps && Number.isFinite(minDist) ? Math.round(minDist) : null,
      matchedCampus,
      record: toFlatRecord(rec, READONLY, NUMBERS),
    };
  }
}
