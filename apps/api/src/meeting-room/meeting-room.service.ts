/**
 * 会议室助手（组织管理）服务。
 *
 * 数据分工（峰哥 2026-09-21 定的口径）：
 *   - **房间 / 楼栋层级 / 容纳人数 / 设备** ← 飞书 `vc/v1/rooms` + `vc/v1/room_levels`，
 *     点「同步飞书会议室」落到本地表（照「部门管理」的模式）；页面读本地，不打上游。
 *   - **占用时段** ← 飞书实时查，**不落库**：占用是每分钟都在变的数据，
 *     存下来只会让人看着过期数据开会。内存缓存 2 分钟（并把 `fetchedAt` 回显到界面）。
 *
 * 🔴 降级语义（本模块最要紧的一条）：飞书权限未开通 / 调用失败时，
 *    返回体里 **必须** 带 `degraded`，而 `busy` 一律为空。
 *    界面看到 degraded 会整体灰显 + 写明原因 ——
 *    否则「读不到」和「今天没人用」在界面上长得一模一样，有人会照着绿格去开会。
 *
 * 不分校区/部门：会议室是全校公共资源，不做行级隔离（与「部门管理」一致）。
 */
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  TABLES,
  dayWindow,
  hhmmToMs,
  isSlotFree,
  meetingRoomAuthUrl,
  mergeBusySpans,
  resolveLevelNames,
  todayKey,
  type FindFreeParams,
  type FindFreeResult,
  type MeetingRoomInfo,
  type MeetingRoomLevel,
  type RoomAvailability,
  type RoomAvailabilityItem,
  type SessionUser,
} from '@acms/contracts';
import { getSqlStore } from '../base.provider.js';
import { requireModule } from '../shared/require-module.js';
import { runAs, systemActor } from '../shared/actor-context.js';
import {
  freebusyBatch,
  listRoomLevels,
  listRooms,
  reservationList,
  type SpansByRoom,
} from '../ai/lib/feishu/room-api.js';

/** 占用缓存时长：2 分钟（界面上回显抓取时间，用户知道自己在看什么时候的数据） */
const BUSY_TTL_MS = 2 * 60 * 1000;
/** 飞书 freebusy 一次最多 20 个房间 */
const ROOM_BATCH = 20;

/** 自建表字段类型（与 SqlStore 的约定一致） */
const FT = { TEXT: 1, NUMBER: 2 } as const;

interface BusyResult {
  at: number;
  spans: SpansByRoom;
  /** 有值 ⇒ 本次占用数据不可信，界面必须灰显 */
  degraded?: string;
  warnings: string[];
}

function feishuCreds(): { appId: string; appSecret: string } {
  return {
    appId: process.env.FEISHU_APP_ID ?? '',
    appSecret: process.env.FEISHU_APP_SECRET ?? '',
  };
}

function joinList(v: string[]): string {
  return (v ?? []).join('、');
}
function splitList(v: unknown): string[] {
  const s = String(v ?? '').trim();
  return s ? s.split(/[、,，]/).map((x) => x.trim()).filter(Boolean) : [];
}

@Injectable()
export class MeetingRoomService {
  private readonly logger = new Logger('MeetingRoom');

  /** 已建表标记（建表只做一次） */
  private tablesReady = false;

  /** 占用缓存：key = date（占用按房间查，与楼栋/容量筛选无关，所以可以按天缓存） */
  private readonly busyCache = new Map<string, BusyResult>();

  /** 并发去重：同一时刻多个人打开页面，只打一次飞书 */
  private readonly busyInFlight = new Map<string, Promise<BusyResult>>();

  // ─────────────────────────── 建表 ───────────────────────────

  async ensureTables(): Promise<void> {
    if (this.tablesReady) return;
    const sql = getSqlStore();
    if (!sql) {
      this.logger.warn('[meeting-room] 未配置 DATABASE_URL，跳过建表');
      return;
    }
    await sql.ensureTable(TABLES.meetingRoomLevels.tableId, '会议室层级表', [
      { name: '层级ID', type: FT.TEXT },
      { name: '名称', type: FT.TEXT },
      { name: '父层级ID', type: FT.TEXT },
      { name: '层级路径', type: FT.TEXT },
      { name: '同步时间', type: FT.NUMBER },
    ]);
    await sql.ensureTable(TABLES.meetingRooms.tableId, '会议室表', [
      { name: '名称', type: FT.TEXT },
      { name: '层级ID', type: FT.TEXT },
      { name: '楼栋', type: FT.TEXT },
      { name: '楼层', type: FT.TEXT },
      { name: '容纳人数', type: FT.NUMBER },
      { name: '设备', type: FT.TEXT },
      { name: '描述', type: FT.TEXT },
      // 维护中/停用（飞书 room_status.status === false）。存文本「是/否」而不是复选框：
      // 与全站既有习惯一致，且空值天然等同于「否」
      { name: '维护中', type: FT.TEXT },
      { name: '显示编号', type: FT.TEXT },
      { name: '同步时间', type: FT.NUMBER },
    ]);
    this.tablesReady = true;
    this.logger.log('会议室表 / 会议室层级表已就绪');
  }

  /** 给前端的「去开通权限」链接 */
  authUrl(): string {
    return meetingRoomAuthUrl(process.env.FEISHU_APP_ID ?? '');
  }

  // ─────────────────────────── 同步（管理员）───────────────────────────

  /**
   * 同步飞书会议室 + 层级到本地表。
   *
   * ⚠️ 权限：`module:meetingRooms:update`（只有系统管理员持有 —— 见 contracts 的 v5 说明）。
   * ⚠️ 写库走 `runAs(systemActor(...))`：这是后台任务身份，审计里能看出是同步写的
   *    （与「部门管理」一致）。
   */
  async sync(user: SessionUser): Promise<{
    ok: boolean;
    error?: string;
    denied?: boolean;
    authUrl?: string;
    levels?: number;
    rooms?: number;
    syncedAt?: number;
  }> {
    requireModule(user, 'meetingRooms', 'update');
    await this.ensureTables();
    const sql = getSqlStore();
    if (!sql) return { ok: false, error: '未配置数据库（DATABASE_URL），无法保存会议室' };

    const creds = feishuCreds();
    const [lv, rm] = await Promise.all([listRoomLevels(creds), listRooms(creds)]);
    if (!lv.ok || !lv.data) {
      return {
        ok: false,
        error: lv.error ?? '读取会议室层级失败',
        denied: lv.denied,
        authUrl: lv.denied ? this.authUrl() : undefined,
      };
    }
    if (!rm.ok || !rm.data) {
      return {
        ok: false,
        error: rm.error ?? '读取会议室列表失败',
        denied: rm.denied,
        authUrl: rm.denied ? this.authUrl() : undefined,
      };
    }

    const syncedAt = Date.now();
    const levels = lv.data.levels;
    const rooms = rm.data.rooms;
    const levelNames = resolveLevelNames(
      levels.map((l) => ({ levelId: l.level_id, name: l.name, parentId: l.parent_id, path: l.path })),
    );

    await runAs(systemActor('meeting-room-sync', '系统 · 会议室同步'), async () => {
      for (const l of levels) {
        const fields = {
          层级ID: l.level_id,
          名称: l.name,
          父层级ID: l.parent_id,
          层级路径: joinList(l.path),
          同步时间: syncedAt,
        };
        const exist = await sql.get(TABLES.meetingRoomLevels.tableId, l.level_id);
        if (exist) await sql.update(TABLES.meetingRoomLevels.tableId, l.level_id, fields);
        else await sql.createWithId(TABLES.meetingRoomLevels.tableId, l.level_id, fields);
      }
      for (const r of rooms) {
        const names = levelNames.get(r.room_level_id);
        const fields = {
          名称: r.name,
          层级ID: r.room_level_id,
          // 楼栋名从层级树解析（房间里只有 level_id）；解析不到就留空，
          // 界面会退回显示「未归属楼栋」而不是显示一个假楼栋
          楼栋: names?.rootName ?? '',
          楼层: names?.floorName ?? '',
          容纳人数: r.capacity,
          设备: joinList(r.devices),
          描述: r.description,
          维护中: r.disabled ? '是' : '否',
          显示编号: r.display_id || r.custom_room_id || '',
          同步时间: syncedAt,
        };
        const exist = await sql.get(TABLES.meetingRooms.tableId, r.room_id);
        if (exist) await sql.update(TABLES.meetingRooms.tableId, r.room_id, fields);
        else await sql.createWithId(TABLES.meetingRooms.tableId, r.room_id, fields);
      }
    });

    // 房间/层级变了 ⇒ 清占用缓存（否则新房间会带着旧缓存被渲染）
    this.busyCache.clear();
    this.logger.log(`会议室同步完成：层级 ${levels.length} 个、会议室 ${rooms.length} 个`);
    return { ok: true, levels: levels.length, rooms: rooms.length, syncedAt };
  }

  // ─────────────────────────── 本地读 ───────────────────────────

  /**
   * 翻页读全表。
   *
   * ⚠️ `SqlStore.search` 的 pageSize 会被夹到 **500**（`Math.min(..., 500)`），
   *    传 2000 不会报错、只会静默只给 500 条 —— 会议室超 500 个时就会少数据。
   *    所以这里显式翻页（同 `fetchAll` 的既有约定）。
   */
  private async readAll(tableId: string): Promise<{ recordId?: string; fields?: Record<string, unknown> }[]> {
    const sql = getSqlStore();
    if (!sql) return [];
    const out: { recordId?: string; fields?: Record<string, unknown> }[] = [];
    let token: string | undefined;
    for (let i = 0; i < 20; i += 1) {
      const res = await sql.search(tableId, { pageSize: 500, pageToken: token });
      out.push(...((res.items ?? []) as { recordId?: string; fields?: Record<string, unknown> }[]));
      if (!res.hasMore || !res.pageToken) break;
      token = res.pageToken;
    }
    return out;
  }

  /** 本地会议室 + 层级 + 最近同步时间 + 开通链接（页面首屏与筛选下拉都用它） */
  async listLocal(user: SessionUser): Promise<{
    levels: MeetingRoomLevel[];
    rooms: MeetingRoomInfo[];
    syncedAt: number;
    authUrl: string;
  }> {
    requireModule(user, 'meetingRooms', 'read');
    await this.ensureTables();
    const sql = getSqlStore();
    const authUrl = this.authUrl();
    if (!sql) return { levels: [], rooms: [], syncedAt: 0, authUrl };

    const [lvItems, rmItems] = await Promise.all([
      this.readAll(TABLES.meetingRoomLevels.tableId),
      this.readAll(TABLES.meetingRooms.tableId),
    ]);

    const levels: MeetingRoomLevel[] = lvItems.map((r) => {
      const f = (r.fields ?? {}) as Record<string, unknown>;
      return {
        levelId: String(f['层级ID'] ?? ''),
        name: String(f['名称'] ?? ''),
        parentId: String(f['父层级ID'] ?? ''),
        path: splitList(f['层级路径']),
      };
    });

    let syncedAt = 0;
    const rooms: MeetingRoomInfo[] = rmItems.map((r) => {
      const f = (r.fields ?? {}) as Record<string, unknown>;
      syncedAt = Math.max(syncedAt, Number(f['同步时间'] ?? 0) || 0);
      return {
        roomId: String(r.recordId ?? ''),
        name: String(f['名称'] ?? ''),
        levelId: String(f['层级ID'] ?? ''),
        levelName: String(f['楼栋'] ?? ''),
        floor: String(f['楼层'] ?? ''),
        capacity: Number(f['容纳人数'] ?? 0) || 0,
        devices: splitList(f['设备']),
        description: String(f['描述'] ?? ''),
        disabled: String(f['维护中'] ?? '') === '是',
        displayId: String(f['显示编号'] ?? ''),
      };
    });

    return { levels, rooms, syncedAt, authUrl };
  }

  // ─────────────────────────── 占用（实时 + 缓存）───────────────────────────

  /**
   * 取某天全天（08:00–22:00 之外也含，因为要判断 7:30 的会是否占用）的占用情况。
   *
   * 查询窗口取**整天 00:00–24:00**，这样时间轴两端（8:00 之前开始、22:00 之后结束的会）
   * 也能正确判占用 —— 只查 08:00–22:00 的话，7:00–9:00 的会会被截断成"9:00 才开始"，
   * 时间轴第一格会错误地显示为空闲。
   */
  private async busyFor(dateKey: string, roomIds: string[]): Promise<BusyResult> {
    const key = `busy:${dateKey}`;
    const hit = this.busyCache.get(key);
    if (hit && Date.now() - hit.at < BUSY_TTL_MS) return hit;
    const inflight = this.busyInFlight.get(key);
    if (inflight) return inflight;

    const task = (async (): Promise<BusyResult> => {
      const { startMs, endMs } = dayWindow(dateKey);
      const dayStart = startMs - 8 * 3600_000;
      const dayEnd = dayStart + 24 * 3600_000;
      const spans: SpansByRoom = {};
      const warnings: string[] = [];
      let used = '';

      for (let i = 0; i < roomIds.length; i += ROOM_BATCH) {
        const batch = roomIds.slice(i, i + ROOM_BATCH);
        let r = await freebusyBatch(feishuCreds(), batch, dayStart, dayEnd);
        used = 'freebusy';
        if (!r.ok && !r.denied) {
          // 忙闲接口失败（结构/限制问题）⇒ 回退预订单接口，别让用户看到"全空闲"
          const alt = await reservationList(feishuCreds(), batch, dayStart, dayEnd);
          if (alt.ok) {
            r = alt;
            used = 'reservation_list';
          } else {
            r = alt.denied ? alt : r;
          }
        }
        if (!r.ok || !r.data) {
          return {
            at: Date.now(),
            spans: {},
            degraded: r.denied
              ? '飞书应用未开通会议室只读权限，暂时读不到占用情况'
              : `读取会议室占用失败：${r.error ?? '未知原因'}`,
            warnings,
          };
        }
        for (const [roomId, list] of Object.entries(r.data.spans)) {
          (spans[roomId] ??= []).push(...list);
        }
      }

      if (!roomIds.length) warnings.push('没有可查询的会议室（请先同步）');
      this.logger.log(`占用数据已更新（${used}，房间 ${roomIds.length} 个，日期 ${dateKey}）`);
      return { at: Date.now(), spans, warnings };
    })();

    this.busyInFlight.set(key, task);
    try {
      const out = await task;
      // 失败结果**也缓存**：否则飞书挂了的时候每个用户刷新都会再打一次上游，
      // 把"上游有问题"放大成"我们的接口也卡住"
      this.busyCache.set(key, out);
      return out;
    } finally {
      this.busyInFlight.delete(key);
    }
  }

  private filterRooms(
    rooms: MeetingRoomInfo[],
    levelId?: string,
    minCapacity?: number,
  ): MeetingRoomInfo[] {
    return rooms.filter((r) => {
      if (levelId && r.levelId !== levelId) return false;
      if (minCapacity && r.capacity < minCapacity) return false;
      return true;
    });
  }

  // ─────────────────────────── 可用度 ───────────────────────────

  async availability(
    user: SessionUser,
    params: { date?: string; levelId?: string; minCapacity?: number },
  ): Promise<RoomAvailability> {
    requireModule(user, 'meetingRooms', 'read');
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(params.date ?? '')) ? String(params.date) : todayKey();
    const { startMs, endMs } = dayWindow(date);
    const local = await this.listLocalRoomsOnly();
    const base: RoomAvailability = {
      date,
      window: { startMs, endMs },
      rooms: [],
      fetchedAt: 0,
      warnings: [],
    };

    if (!local.length) {
      return {
        ...base,
        degraded: '还没有会议室数据。请在飞书里配好会议室后，点右上角「同步飞书会议室」。',
      };
    }

    const picked = this.filterRooms(local, params.levelId, params.minCapacity);
    const busy = await this.busyFor(date, local.map((r) => r.roomId));
    const rooms: RoomAvailabilityItem[] = picked.map((r) => ({
      ...r,
      busy: mergeBusySpans(busy.spans[r.roomId] ?? []),
    }));

    return {
      ...base,
      rooms,
      fetchedAt: busy.at,
      degraded: busy.degraded,
      warnings: busy.warnings,
    };
  }

  /** 内部用：只读房间（不再触发权限检查，避免 availability/findFree 里重复判） */
  private async listLocalRoomsOnly(): Promise<MeetingRoomInfo[]> {
    await this.ensureTables();
    const items = await this.readAll(TABLES.meetingRooms.tableId);
    return items.map((r) => {
      const f = (r.fields ?? {}) as Record<string, unknown>;
      return {
        roomId: String(r.recordId ?? ''),
        name: String(f['名称'] ?? ''),
        levelId: String(f['层级ID'] ?? ''),
        levelName: String(f['楼栋'] ?? ''),
        floor: String(f['楼层'] ?? ''),
        capacity: Number(f['容纳人数'] ?? 0) || 0,
        devices: splitList(f['设备']),
        description: String(f['描述'] ?? ''),
        disabled: String(f['维护中'] ?? '') === '是',
        displayId: String(f['显示编号'] ?? ''),
      };
    });
  }

  // ─────────────────────────── 找空闲 ───────────────────────────

  /**
   * 找空闲会议室。
   *
   * **服务端算**（不在前端重算）：判据与时间轴共用 `isSlotFree`。
   * 前端若自己实现一遍，迟早出现「格子看着是空的、点查找却说没有」。
   *
   * `candidates` 单独返回：用来区分「没有这么大的房间」（候选=0）与
   * 「有房间但这段时间都占着」（候选>0、命中=0）—— 两种情况的下一步动作完全不同。
   */
  async findFree(user: SessionUser, params: FindFreeParams): Promise<FindFreeResult> {
    requireModule(user, 'meetingRooms', 'read');
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(params.date ?? '')) ? String(params.date) : todayKey();
    const fromMs = hhmmToMs(date, params.from);
    const toMs = hhmmToMs(date, params.to);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
      throw new BadRequestException('VALIDATION:起止时段格式应为 HH:MM');
    }
    if (toMs <= fromMs) {
      throw new BadRequestException('VALIDATION:结束时间要晚于开始时间');
    }
    const minCapacity = Number(params.minCapacity) || 0;
    const levelId = String(params.levelId ?? '');

    const avail = await this.availability(user, { date, levelId, minCapacity: minCapacity || undefined });
    const pool = avail.rooms.filter((r) => !r.disabled);
    const result: FindFreeResult = {
      fromMs,
      toMs,
      minCapacity,
      levelId,
      matches: [],
      candidates: pool.length,
      degraded: avail.degraded,
    };
    if (avail.degraded) return result;

    result.matches = pool
      .filter((r) => isSlotFree(r.busy, fromMs, toMs))
      // 能装下就尽量用小的（省资源，也避免"一个 4 人会在 60 人教室开"）
      .sort((a, b) => (a.capacity || 0) - (b.capacity || 0) || a.name.localeCompare(b.name, 'zh-CN'));
    return result;
  }
}
