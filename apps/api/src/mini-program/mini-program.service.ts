import { Inject, Injectable, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { BaseClient, toText, type BaseRecord } from '@acms/base-adapter';
import { TABLES } from '@acms/contracts';
import { REDIS } from '../redis.provider.js';
import { BASE_CLIENT } from '../base.provider.js';
import { SessionService } from '../auth/session.service.js';
import { buildFilter } from '../shared/record.util.js';
import type { WechatLoginDto, ZoneQueryDto } from './mini-program.dto.js';

const STUDENT_TABLE = TABLES.studentProfile.tableId;
const ZONE_TABLE = TABLES.attendanceZone.tableId;

/** 按换行 / 逗号（含中文逗号）切分文本为去空白列表 */
function splitList(v: unknown): string[] {
  if (v == null) return [];
  const s = typeof v === 'string' ? v : String(v);
  return s.split(/[\n,，]/).map((x) => x.trim()).filter(Boolean);
}

export interface WechatLoginResult {
  /** 是否还需要绑定学号（true 时未签发会话） */
  needBind: boolean;
  sessionId?: string;
  studentId?: string;
  name?: string;
  campus?: string;
  roles?: string[];
}

/**
 * 微信小程序端服务（P0 登录绑定 + P2 区域拉取）。
 * 设计要点：
 *  - openid ↔ 学生档案的绑定以 Redis（wxbind:<openid> → record_id）为权威，
 *    避免依赖飞书 Base 是否含有「微信 Open ID」字段；同时最佳努力回写该字段。
 *  - 会话复用现有 SessionService（Redis + SessionUser 结构），角色为 ['student']，
 *    并写入 studentId（学生档案 record_id，同时作为关联学生编号的 link 值）。
 */
@Injectable()
export class MiniProgramService {
  private readonly bindTtl = 60 * 60 * 24 * 180; // 180 天

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(BASE_CLIENT) private readonly base: BaseClient,
    private readonly sessions: SessionService,
  ) {}

  // ── P0 微信登录 + 学号绑定 ─────────────────────────────────────────────
  async login(dto: WechatLoginDto): Promise<WechatLoginResult> {
    const openid = await this.resolveOpenid(dto);

    let studentId = await this.getBinding(openid);
    if (!studentId) {
      if (dto.studentNo && dto.name) {
        studentId = await this.bind(openid, dto.studentNo, dto.name);
      }
      if (!studentId) return { needBind: true };
    }

    const stu = await this.loadStudent(studentId);
    if (!stu) throw new UnauthorizedException('STUDENT_NOT_FOUND');

    const campus = toText(stu.fields['校区']) ?? '';
    const name = toText(stu.fields['学生姓名']) ?? '';
    // 刷新绑定 TTL
    await this.redis.expire(`wxbind:${openid}`, this.bindTtl);

    const session = await this.sessions.create({
      openId: openid,
      name,
      roles: ['student'],
      campuses: campus ? [campus] : [],
      maxDataLevel: 'L1',
      studentId,
    });
    return {
      needBind: false,
      sessionId: session.sessionId,
      studentId,
      name,
      campus,
      roles: session.roles,
    };
  }

  /** 从系统配置表读取配置值（配置键命中且状态=启用），否则 null。
   *  配置键约定：wechat_mini_appid / wechat_mini_secret（管理员在「系统设置」维护）。 */
  private async getConfigValue(key: string): Promise<string | null> {
    try {
      const res = await this.base.search(TABLES.systemConfig.tableId, {
        pageSize: 10,
        filter: buildFilter([{ field: '配置键', value: [key] }]),
      });
      const rec = res.items[0];
      if (!rec) return null;
      const status = toText(rec.fields['状态']);
      if (status && status !== '启用') return null;
      return toText(rec.fields['配置值']) || null;
    } catch {
      return null;
    }
  }

  /** code2Session 换 openid；优先系统配置表，回退 env；都无则开发模式 */
  private async resolveOpenid(dto: WechatLoginDto): Promise<string> {
    const appid = (await this.getConfigValue('wechat_mini_appid')) ?? process.env.WECHAT_MINI_APPID;
    const secret = (await this.getConfigValue('wechat_mini_secret')) ?? process.env.WECHAT_MINI_SECRET;
    if (appid && secret) {
      const url =
        `https://api.weixin.qq.com/sns/jscode2session?appid=${encodeURIComponent(appid)}` +
        `&secret=${encodeURIComponent(secret)}&js_code=${encodeURIComponent(dto.code)}&grant_type=authorization_code`;
      const res = await fetch(url);
      const data = (await res.json()) as { errcode?: number; errmsg?: string; openid?: string };
      if (data.errcode) throw new UnauthorizedException(`WECHAT_CODE2SESSION_FAILED:${data.errcode}:${data.errmsg}`);
      if (!data.openid) throw new UnauthorizedException('WECHAT_NO_OPENID');
      return data.openid;
    }
    // 本地/未配置凭证：开发模式。仅当未配置真实凭证时生效，避免生产环境被冒用。
    if (dto.devCode) return `dev_${dto.devCode}`;
    throw new UnauthorizedException('WECHAT_NOT_CONFIGURED');
  }

  private async getBinding(openid: string): Promise<string | null> {
    const v = await this.redis.get(`wxbind:${openid}`);
    return v || null;
  }

  /** 用学号 + 姓名绑定 openid ↔ 学生档案，返回学生 record_id 或 null */
  private async bind(openid: string, studentNo: string, name: string): Promise<string | null> {
    const res = await this.base.search(STUDENT_TABLE, {
      pageSize: 50,
      filter: buildFilter([{ field: '学生姓名', value: [name] }]),
    });
    const no = String(studentNo).trim();
    const rec = res.items.find((r) => {
      const f = r.fields;
      const nameOk = toText(f['学生姓名']) === name.trim();
      if (!nameOk) return false;
      const noOk =
        String(toText(f['学生编号']) ?? '').trim() === no ||
        String(toText(f['学籍号（脱敏）']) ?? '').trim() === no;
      return noOk;
    });
    if (!rec) return null;
    const id = rec.recordId;
    await this.redis.set(`wxbind:${openid}`, id, 'EX', this.bindTtl);
    // 最佳努力回写「微信 Open ID」字段（若 Base 已加该字段；否则忽略）
    try {
      await this.base.update(STUDENT_TABLE, id, { '微信 Open ID': openid } as Record<string, unknown>);
    } catch {
      /* 字段不存在则跳过，绑定以 Redis 为准 */
    }
    return id;
  }

  private async loadStudent(id: string): Promise<BaseRecord | null> {
    try {
      return await this.base.get(STUDENT_TABLE, id);
    } catch {
      return null;
    }
  }

  // ── P2 学生可读围栏（按校区拉取） ─────────────────────────────────────
  /** 读取启用中的围栏，按校区过滤（可选），返回小程序判定所需的精简字段 */
  async listZones(query: ZoneQueryDto): Promise<{ items: Array<Record<string, unknown>> }> {
    const res = await this.base.search(ZONE_TABLE, {
      pageSize: 100,
      filter: buildFilter([{ field: '状态', value: ['启用'] }]),
    });
    const items = res.items
      .map((r) => {
        const f = r.fields;
        const lat = Number(f['围栏中心(纬度)']);
        const lng = Number(f['围栏中心(经度)']);
        if (Number.isNaN(lat) || Number.isNaN(lng)) return null;
        return {
          id: r.recordId,
          校区: toText(f['校区']) ?? '',
          lat,
          lng,
          radius: Number(f['围栏半径(米)']) || 200,
          ssid: splitList(f['WiFi_SSID列表']).map((s) => s.toLowerCase()),
          bssid: splitList(f['WiFi_BSSID列表']).map((s) => s.toLowerCase().replace(/[:-]/g, '').toUpperCase()),
        };
      })
      .filter(
        (z): z is { id: string; 校区: string; lat: number; lng: number; radius: number; ssid: string[]; bssid: string[] } =>
          z !== null,
      )
      .filter((z) => !query.campus || z['校区'] === query.campus);
    return { items };
  }
}
