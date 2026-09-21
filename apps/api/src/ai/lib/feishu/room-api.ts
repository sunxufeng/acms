/**
 * 飞书会议室只读接口（组织管理 / 会议室助手，2026-09-21）。
 *
 * 为什么单独成文件而不是塞进 `client.ts`：那份 640 行的文件是「IM / 通讯录 / 文档」的
 * 通用客户端（且带 `@ts-nocheck`），会议室这组接口有明确的**权限降级语义**与
 * **两套互备的占用查询**，独立出来才能带类型、才能被单测覆盖。
 *
 * 只读：房间清单、层级（楼栋）、占用时段。**不接预订** —— 峰哥 2026-09-21 定的口径：
 * 预订要在飞书里创建真实日程、且只能以应用身份创建，误操作成本高，第一期只做查询。
 *
 * 🔴 这几个接口都需要应用级权限（`vc:room:readonly` 一类）。**实测当前应用未开通**
 *    （返回 code 99991672 + 「应用尚未开通所需的应用身份权限」），所以每个函数都返回
 *    `{ ok: false, denied: true }`，调用方据此给「去开通」的降级提示 ——
 *    **绝不能**把读不到当成「没有会议室」或「全空闲」（后者会让人照着空表去开会）。
 */

import { parseFeishuDateTime } from '@acms/contracts';
import { getTenantToken } from './client.js';

const FEISHU_HOST = 'https://open.feishu.cn';

/** 飞书统一的「缺 scope」错误码 */
const SCOPE_DENIED_CODES: readonly number[] = [99991672, 99991673];

export interface FeishuResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
  /** 明确是「应用权限未开通」——页面要显示开通入口，而不是「暂时没有数据」 */
  denied?: boolean;
}

export interface FeishuRoomLevel {
  level_id: string;
  name: string;
  parent_id: string;
  path: string[];
}

export interface FeishuRoom {
  room_id: string;
  name: string;
  capacity: number;
  description: string;
  room_level_id: string;
  path: string[];
  devices: string[];
  display_id: string;
  custom_room_id: string;
  /** room_status.status === false ⇒ 维护中/停用，不该出现在「找空闲」结果里 */
  disabled: boolean;
}

/** 毫秒区间（占用片段） */
export interface MsSpan {
  startMs: number;
  endMs: number;
}

/** roomId → 占用片段 */
export type SpansByRoom = Record<string, MsSpan[]>;

interface FeishuCreds {
  appId?: string;
  appSecret?: string;
}

function isScopeDenied(code: unknown, msg: unknown): boolean {
  if (SCOPE_DENIED_CODES.includes(Number(code))) return true;
  const m = String(msg ?? '');
  return /scope|权限/i.test(m) && /未开通|required|denied/i.test(m);
}

/** 统一 GET：飞书有些接口用 HTTP 400 + code 表达「没权限」，不能只看 HTTP 状态 */
async function getJson(url: string, token: string): Promise<FeishuResult<Record<string, unknown>>> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  } catch (e) {
    return { ok: false, error: `请求飞书失败：${(e as Error).message}` };
  }
  let body: Record<string, unknown> | null = null;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    return { ok: false, error: `飞书返回非 JSON（HTTP ${res.status}）` };
  }
  if (Number(body.code) === 0) return { ok: true, data: body };
  const msg = String(body.msg ?? `HTTP ${res.status}`);
  if (isScopeDenied(body.code, msg)) {
    return { ok: false, error: '飞书应用未开通会议室只读权限', denied: true };
  }
  return { ok: false, error: `飞书接口失败：${msg}` };
}

/** 毫秒 → RFC3339（带本地时区偏移，如 2026-09-21T08:00:00+08:00） */
export function toRfc3339(ms: number): string {
  const d = new Date(ms);
  const offMin = -d.getTimezoneOffset();
  const sign = offMin >= 0 ? '+' : '-';
  const two = (n: number) => String(Math.abs(n)).padStart(2, '0');
  const date = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
  const time = `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
  return `${date}T${time}${sign}${two(Math.floor(Math.abs(offMin) / 60))}:${two(Math.abs(offMin) % 60)}`;
}

/** 秒 / 毫秒 / 数字字符串都归一成毫秒（飞书两套占用接口的时间单位不一致） */
export function anyToMs(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return NaN;
  return n < 1e12 ? n * 1000 : n;
}

/** 设备标签归一：飞书的 device[] 可能是字符串，也可能是 { name } / { device_name } 对象 */
export function deviceLabels(device: unknown): string[] {
  if (!Array.isArray(device)) return [];
  const out: string[] = [];
  for (const d of device) {
    if (d == null) continue;
    if (typeof d === 'string') {
      const s = d.trim();
      if (s) out.push(s);
      continue;
    }
    const rec = d as Record<string, unknown>;
    const s = String(rec.name ?? rec.device_name ?? rec.label ?? rec.id ?? '').trim();
    if (s) out.push(s);
  }
  return [...new Set(out)];
}

/**
 * 递归收集「同时带起止时间」的对象。
 *
 * ⚠️ **已不再用于预订单解析**（那条路已按实测结构写成精确解析：键名
 * `room_reservation_list` + 字段 `event_start_time`，见 `reservationList`）。
 * 保留它只为排查时打印未预期的响应结构 —— 不要再拿它当解析器：
 * 「按任意 key 猜」正是当初 9 条真实预定全解析失败的原因。
 */
export function collectTimeRanges(node: unknown, out: Record<string, unknown>[] = [], depth = 0): Record<string, unknown>[] {
  if (depth > 6 || node == null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const x of node) collectTimeRanges(x, out, depth + 1);
    return out;
  }
  const rec = node as Record<string, unknown>;
  const hasStart = rec.start_time !== undefined || rec.startTime !== undefined || rec.start !== undefined;
  const hasEnd = rec.end_time !== undefined || rec.endTime !== undefined || rec.end !== undefined;
  if (hasStart && hasEnd) out.push(rec);
  for (const v of Object.values(rec)) {
    if (v && typeof v === 'object') collectTimeRanges(v, out, depth + 1);
  }
  return out;
}

/**
 * 会议室层级列表（楼栋 / 楼层）。
 *
 * 🔴 两个实测校正（2026-09-21，靠生产真实数据才发现）：
 *   ① 返回项里层级 id 的字段名是 **`room_level_id`**（不是 `level_id`）——
 *      用错字段名会让 `levels` 恒为空数组，症状是「同步报『未返回任何层级』」；
 *   ② **不传 `room_level_id` 只返回部分层级**，要拿全树必须按 `has_child` **递归展开**
 *      （真实结构：中国学区 → 上海学区 → 申昆路总部 → 合一楼/19号楼/行知楼，共 6 个）。
 *
 * 顶层请求失败 ⇒ 整体失败（返回 error/denied）；子层级失败只跳过该分支，
 * 已拿到的层级照常返回（不因为一个分支坏了就整件事做不成）。
 */
export async function listRoomLevels(creds?: FeishuCreds): Promise<FeishuResult<{ levels: FeishuRoomLevel[] }>> {
  const token = await getTenantToken(creds);
  if (!token) return { ok: false, error: '未配置飞书应用凭据' };

  const levels: FeishuRoomLevel[] = [];
  const seen = new Set<string>();
  let topError: FeishuResult<{ levels: FeishuRoomLevel[] }> | null = null;

  const walk = async (parentId: string, depth: number): Promise<void> => {
    if (depth > 6) return;
    let pageToken = '';
    for (let i = 0; i < 20; i += 1) {
      let url = `${FEISHU_HOST}/open-apis/vc/v1/room_levels?page_size=100`;
      if (parentId) url += `&room_level_id=${encodeURIComponent(parentId)}`;
      if (pageToken) url += `&page_token=${encodeURIComponent(pageToken)}`;
      const r = await getJson(url, token);
      if (!r.ok) {
        // 顶层的失败就是整件事失败；子层级失败只是这条分支没拿到
        if (!parentId) topError = r as unknown as FeishuResult<{ levels: FeishuRoomLevel[] }>;
        return;
      }
      const d = r.data as { data?: { items?: Record<string, unknown>[]; page_token?: string } };
      const items = d.data?.items ?? [];
      for (const it of items) {
        const id = String(it.room_level_id ?? it.level_id ?? '').trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        levels.push({
          level_id: id,
          name: String(it.name ?? '').trim(),
          parent_id: String(it.parent_id ?? '').trim(),
          path: Array.isArray(it.path) ? (it.path as unknown[]).map(String) : [],
        });
      }
      // 递归展开子层级（不递归就只能拿到"中国学区"一个）
      for (const it of items) {
        const id = String(it.room_level_id ?? '').trim();
        if (it.has_child && id) await walk(id, depth + 1);
      }
      // ⚠️ 分页：同一层级的 page_token 翻页（与子层级递归不是一回事）
      pageToken = String(d.data?.page_token ?? '');
      if (!pageToken) break;
    }
  };

  await walk('', 0);
  if (topError) return topError;
  if (!levels.length) return { ok: false, error: '飞书未返回任何会议室层级（可能还没在飞书里建楼栋/会议室）' };
  return { ok: true, data: { levels } };
}

/** 会议室列表（含容纳人数、设备、维护状态）。不传 room_level_id = 租户下全部。 */
export async function listRooms(creds?: FeishuCreds): Promise<FeishuResult<{ rooms: FeishuRoom[] }>> {
  const token = await getTenantToken(creds);
  if (!token) return { ok: false, error: '未配置飞书应用凭据' };

  const rooms: FeishuRoom[] = [];
  let pageToken = '';
  for (let i = 0; i < 50; i += 1) {
    let url = `${FEISHU_HOST}/open-apis/vc/v1/rooms?page_size=100`;
    if (pageToken) url += `&page_token=${encodeURIComponent(pageToken)}`;
    const r = await getJson(url, token);
    if (!r.ok) return r as FeishuResult<{ rooms: FeishuRoom[] }>;
    const d = r.data as { data?: { items?: Record<string, unknown>[]; rooms?: Record<string, unknown>[]; page_token?: string } };
    const items = d.data?.items ?? d.data?.rooms ?? [];
    for (const it of items) {
      const id = String(it.room_id ?? '').trim();
      if (!id) continue;
      const status = it.room_status as Record<string, unknown> | undefined;
      rooms.push({
        room_id: id,
        name: String(it.name ?? '').trim(),
        capacity: Number(it.capacity) || 0,
        description: String(it.description ?? '').trim(),
        room_level_id: String(it.room_level_id ?? '').trim(),
        path: Array.isArray(it.path) ? (it.path as unknown[]).map(String) : [],
        devices: deviceLabels(it.device),
        display_id: String(it.display_id ?? '').trim(),
        custom_room_id: String(it.custom_room_id ?? '').trim(),
        // room_status.status === false ⇒ 会议室不可用（维护/停用）
        disabled: status ? status.status === false : false,
      });
    }
    pageToken = String(d.data?.page_token ?? '');
    if (!pageToken || !items.length) break;
  }
  if (!rooms.length) return { ok: false, error: '飞书未返回任何会议室（可能还没在飞书里配置会议室）' };
  return { ok: true, data: { rooms } };
}

/**
 * 会议室忙闲（`meeting_room/freebusy/batch_get`）—— 主用。
 *
 * ⚠️ 一次最多 20 个 room_ids（文档硬限制），超出部分由调用方分批。
 * ⚠️ 官方建议查询窗口 30 天以内；我们查单日，天然满足。
 */
export async function freebusyBatch(
  creds: FeishuCreds | undefined,
  roomIds: readonly string[],
  startMs: number,
  endMs: number,
): Promise<FeishuResult<{ spans: SpansByRoom }>> {
  const token = await getTenantToken(creds);
  if (!token) return { ok: false, error: '未配置飞书应用凭据' };
  const ids = roomIds.slice(0, 20);
  if (!ids.length) return { ok: true, data: { spans: {} } };

  const qs = ids.map((id) => `room_ids=${encodeURIComponent(id)}`).join('&');
  const url =
    `${FEISHU_HOST}/open-apis/meeting_room/freebusy/batch_get?${qs}` +
    `&time_min=${encodeURIComponent(toRfc3339(startMs))}&time_max=${encodeURIComponent(toRfc3339(endMs))}`;
  const r = await getJson(url, token);
  if (!r.ok) return r as FeishuResult<{ spans: SpansByRoom }>;

  const d = r.data as { data?: { free_busy?: Record<string, unknown>[] } };
  const spans: SpansByRoom = {};
  for (const it of d.data?.free_busy ?? []) {
    const roomId = String(it.room_id ?? '').trim();
    if (!roomId) continue;
    const s = anyToMs(it.start_time);
    const e = anyToMs(it.end_time);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue;
    (spans[roomId] ??= []).push({ startMs: s, endMs: e });
  }
  return { ok: true, data: { spans } };
}

/**
 * 会议室预订单（`vc/v1/resource_reservation_list`）—— freebusy 的兜底。
 *
 * 🔴 真实响应结构（2026-09-21 实测，**文档里没写全**）：
 *    `data.room_reservation_list = [{ room_id, event_start_time, event_end_time,
 *      event_duration, reserver, department_of_reserver, reservation_status, ... }]`
 *    时间是**带时区后缀的墙钟字符串**：`"2026.09.21 09:00:00 (GMT+08:00)"`。
 *    （早期实现按"任意带 start_time/end_time 的对象"容错解析 ⇒ 一条都匹配不到 ⇒
 *     当天 9 条真实预定全被当成空闲。这条就是靠"先拿真实数据试一次"才发现的。）
 *
 * 🔴 只能查**当天**：`start_time` 不能大于当前时间（未来日期报 `126005`），
 *    窗口最长 24 小时。调用方必须用 `reservationWindowAllowed()` 提前拦住未来日期。
 *
 * ⚠️ `room_level_id` 必填；传非 `omb_` 前缀的值时飞书按**租户层级**处理（文档原文），
 *    所以传 'tenant' —— 实测有效且能一次拿到全部房间的预定。
 */
export async function reservationList(
  creds: FeishuCreds | undefined,
  roomIds: readonly string[],
  startMs: number,
  endMs: number,
): Promise<FeishuResult<{ spans: SpansByRoom }>> {
  const token = await getTenantToken(creds);
  if (!token) return { ok: false, error: '未配置飞书应用凭据' };
  if (!roomIds.length) return { ok: true, data: { spans: {} } };

  const startSec = String(Math.floor(startMs / 1000));
  const endSec = String(Math.floor(endMs / 1000));
  const spans: SpansByRoom = {};
  let pageToken = '';
  for (let i = 0; i < 20; i += 1) {
    const qs = roomIds.map((id) => `room_ids=${encodeURIComponent(id)}`).join('&');
    let url =
      `${FEISHU_HOST}/open-apis/vc/v1/resource_reservation_list?room_level_id=tenant` +
      `&start_time=${startSec}&end_time=${endSec}&page_size=100&need_topic=false&${qs}`;
    if (pageToken) url += `&page_token=${encodeURIComponent(pageToken)}`;
    const r = await getJson(url, token);
    if (!r.ok) return r as FeishuResult<{ spans: SpansByRoom }>;
    const d = r.data as { data?: { room_reservation_list?: Record<string, unknown>[]; page_token?: string } };
    const list = d.data?.room_reservation_list ?? [];
    for (const it of list) {
      const roomId = String(it.room_id ?? '').trim();
      if (!roomId) continue;
      // 只算「真占着」的：已取消/被拒的预定不该把房间画成占用
      const status = String(it.reservation_status ?? '').trim();
      if (status && !/预定成功|已通过|成功/.test(status)) continue;
      const s = parseFeishuDateTime(it.event_start_time);
      const e = parseFeishuDateTime(it.event_end_time);
      if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue;
      (spans[roomId] ??= []).push({ startMs: s, endMs: e });
    }
    pageToken = String(d.data?.page_token ?? '');
    if (!pageToken) break;
  }
  return { ok: true, data: { spans } };
}
