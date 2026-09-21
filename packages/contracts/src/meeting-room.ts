/**
 * 会议室助手（组织管理）的前后端共用口径与判据。
 *
 * 🔴 为什么必须放 contracts：**时间轴的着色**与**「找空闲」的命中判据**必须是同一份实现。
 *    前端画格子、服务端算「哪些房间可用」如果各写一遍，必然出现
 *    「格子看着是空的、点查找却说没有可用会议室」这类对不上的问题 ——
 *    而且这类不一致在联调时几乎发现不了（两处各自都"没错"）。
 *
 * 数据来源（都是飞书只读接口，房间清单同步落库、占用实时查）：
 *   - 房间 / 楼栋层级 / 容量 / 设备 ← `vc/v1/rooms` + `vc/v1/room_levels`
 *   - 占用时段 ← `vc/v1/resource_reservation_list`（备选 `meeting_room/freebusy/batch_get`）
 */

/** 一天里的默认展示时段（本地时间，含头不含尾）：08:00 — 22:00 */
export const MEETING_DAY_START_HOUR = 8;
export const MEETING_DAY_END_HOUR = 22;
/** 时间轴一格的粒度：1 小时。改这里等于改界面格数（两端同时生效） */
export const MEETING_BUCKET_MS = 60 * 60 * 1000;
/** 时间轴格数（14 格，每格 1 小时） */
export const MEETING_BUCKET_COUNT = MEETING_DAY_END_HOUR - MEETING_DAY_START_HOUR;

/** 一个忙碌片段（来自飞书的预订单/忙闲） */
export interface BusySpan {
  startMs: number;
  endMs: number;
}

/** 会议室层级（飞书 room_levels）—— 顶层即「楼栋」 */
export interface MeetingRoomLevel {
  levelId: string;
  name: string;
  parentId: string;
  /** 从根到本级的 id 路径（飞书 `path`），用于判断层级归属 */
  path: string[];
}

/** 会议室（飞书 `vc/v1/rooms` 的字段 + 本地补充） */
export interface MeetingRoomInfo {
  roomId: string;
  name: string;
  /** 所属层级 id（一级 = 楼栋） */
  levelId: string;
  /** 展示用的楼栋名（一级层级名；拿不到时退回本级名） */
  levelName: string;
  /** 楼层（飞书灵活层级下才能精确到层，可能是空串） */
  floor: string;
  capacity: number;
  /** 设备标签（飞书 `device[]`；为空时由管理员在本地补） */
  devices: string[];
  description: string;
  /** 维护中/停用（飞书 `room_status.status === false`）—— 不该出现在「找空闲」结果里 */
  disabled: boolean;
  displayId?: string;
  customRoomId?: string;
}

/** 单个会议室的忙闲 */
export interface RoomBusy {
  roomId: string;
  spans: BusySpan[];
}

/** 可用度查询结果里的一行 */
export interface RoomAvailabilityItem extends MeetingRoomInfo {
  busy: BusySpan[];
}

/** 可用度接口的返回体 */
export interface RoomAvailability {
  /** 查询的日期（YYYY-MM-DD，本地时区） */
  date: string;
  /** 展示窗口 [startMs, endMs) */
  window: { startMs: number; endMs: number };
  rooms: RoomAvailabilityItem[];
  /** 占用数据的抓取时间（界面要回显「数据截至 14:32」） */
  fetchedAt: number;
  /**
   * 降级说明：飞书权限未开通 / 调用失败时**必须有值**。
   *
   * 🔴 此时 `busy` 一律为空数组，但界面**不能**把它画成一片空闲 ——
   *    「读不到」与「今天没人用」在界面上长得一模一样，有人会照着绿格去开会。
   *    所以前端看到 degraded 必须整体灰显 + 显示原因。
   */
  degraded?: string;
  /** 非致命提示（如「有 3 个房间没返回容纳人数」） */
  warnings: string[];
}

/** 「找空闲」的入参（服务端算，前端不重算） */
export interface FindFreeParams {
  date: string;
  /** HH:MM（本地） */
  from: string;
  to: string;
  minCapacity?: number;
  levelId?: string;
}

export interface FindFreeResult {
  fromMs: number;
  toMs: number;
  minCapacity: number;
  levelId: string;
  /** 命中的会议室（已按容纳人数升序，最省的排前面） */
  matches: RoomAvailabilityItem[];
  /** 候选池大小（过滤楼栋/人数后、判空闲前），用于区分「没有合适的房间」与「有房间但都占用了」 */
  candidates: number;
  degraded?: string;
}

/** 飞书会议室只读权限（缺了就读不到房间与占用；界面据此给「去开通」的链接） */
export const MEETING_ROOM_SCOPES: readonly string[] = [
  'vc:room:readonly',
  'vc:rooms.room.basicinfo:read',
  'vc:rooms.roomlevel:read',
  'vc:rooms.room.detailinfo:read',
];

/** 开放平台的权限申请链接（点进去一键勾选） */
export function meetingRoomAuthUrl(appId: string): string {
  const q = MEETING_ROOM_SCOPES.join(',');
  return `https://open.feishu.cn/app/${appId}/auth?q=${q}&op_from=openapi&token_type=tenant`;
}

/**
 * 层级树 → 每个层级对应的「楼栋 / 楼层」。
 *
 * 飞书会议室挂在**某个层级**上，而界面上的副标题是「教学楼 · 60 人」（楼栋）+
 * 筛选按钮也是楼栋 —— 层级可能是两层（楼栋 → 楼层）也可能只有一层，
 * 而房间的 `room_level_id` 指向的是**最细的那一级**。所以必须上溯到根才能拿到楼栋名。
 *
 * 判定「根」的规则（两条都要，缺一个就会漏）：`parent_id` 为空，**或** `parent_id`
 * 指向一个不在列表里的层级（飞书只返回有权限看到的层级，父级可能缺失）。
 *
 * 返回 `{ rootName, floorName }`：`floorName` 仅当该层级不是根时才有值
 * （房间直接挂在一级层级上时，副标题不该显示「教学楼 · 教学楼」）。
 */
export function resolveLevelNames(
  levels: readonly MeetingRoomLevel[],
): Map<string, { rootName: string; floorName: string }> {
  const byId = new Map(levels.map((l) => [l.levelId, l]));
  const isRoot = (l: MeetingRoomLevel) => !l.parentId || !byId.has(l.parentId);
  const rootCache = new Map<string, string>();
  const rootOf = (levelId: string, guard = 0): string => {
    if (rootCache.has(levelId)) return rootCache.get(levelId) as string;
    const l = byId.get(levelId);
    if (!l || guard > 20) return '';
    const name = isRoot(l) ? l.name : rootOf(l.parentId, guard + 1);
    rootCache.set(levelId, name);
    return name;
  };
  const out = new Map<string, { rootName: string; floorName: string }>();
  for (const l of levels) {
    const rootName = rootOf(l.levelId);
    out.set(l.levelId, { rootName, floorName: isRoot(l) ? '' : l.name });
  }
  return out;
}

// ─────────────────────────── 时间/区间判据 ───────────────────────────
const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * 解析 `YYYY-MM-DD` —— 非法/缺失时**回退到今天**。
 *
 * 单独抽出来是因为 tsconfig 开了 `noUncheckedIndexedAccess`：直接解构
 * `split('-').map(Number)` 得到的是 `number | undefined`，每个使用点都要判一次；
 * 集中在这里兜底，调用方拿到的就是确定的数字。
 */
function dateParts(dateKey: string): { y: number; m: number; d: number } {
  const [a, b, c] = String(dateKey ?? '').split('-');
  const now = new Date();
  const y = Number(a);
  const m = Number(b);
  const d = Number(c);
  return {
    y: Number.isFinite(y) && y > 1900 ? y : now.getFullYear(),
    m: Number.isFinite(m) && m >= 1 && m <= 12 ? m : now.getMonth() + 1,
    d: Number.isFinite(d) && d >= 1 && d <= 31 ? d : now.getDate(),
  };
}

/** Date → 本地时区的 YYYY-MM-DD */
export function dateKeyOf(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 今天（本地）的 YYYY-MM-DD */
export function todayKey(now: Date = new Date()): string {
  return dateKeyOf(now);
}

/** YYYY-MM-DD 加减天数（本地时区，跨月/跨年安全 —— 交给 Date 算，不做手写进位） */
export function shiftDateKey(dateKey: string, days: number): string {
  const { y, m, d } = dateParts(dateKey);
  const base = new Date(y, m - 1, d, 12, 0, 0, 0);
  base.setDate(base.getDate() + days);
  return dateKeyOf(base);
}

/** 展示窗口 [startMs, endMs)：某天的 08:00 — 22:00（本地时区） */
export function dayWindow(dateKey: string): { startMs: number; endMs: number } {
  const { y, m, d } = dateParts(dateKey);
  const startMs = new Date(y, m - 1, d, MEETING_DAY_START_HOUR, 0, 0, 0).getTime();
  const endMs = new Date(y, m - 1, d, MEETING_DAY_END_HOUR, 0, 0, 0).getTime();
  return { startMs, endMs };
}

/** 毫秒 → 本地 HH:MM */
export function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * 某天的 "HH:MM" → 毫秒。
 *
 * 非法输入（时间或日期格式不对）返回 **NaN**，调用方据此报 400 ——
 * 🔴 **不静默回退**：回退到 0 点会让「14:00 打错了」变成「查了 00:00 的可用度」，
 *    用户看到的是"全空闲"；回退到"今天"则会让写错的日期查出一个看似正常的结果。
 *    （`dayWindow` / `shiftDateKey` 的日期兜底是给展示用的另一回事 ——
 *     它们的输入来自内部，而这里的输入直接来自用户。）
 */
export function hhmmToMs(dateKey: string, hhmmStr: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey ?? '').trim())) return NaN;
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmmStr ?? '').trim());
  if (!m) return NaN;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(mi) || h > 23 || mi > 59) return NaN;
  const { y, m: mo, d } = dateParts(dateKey);
  return new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
}

/**
 * 两个区间是否真的冲突。
 *
 * 🔴 **相邻不算冲突**：13:00–14:00 的会开完，14:00 就能用同一个房间。
 *    写成 `a.start <= b.end`（带等号）会把这种情况判成冲突，
 *    症状是「明明上一场刚结束，却说没有可用会议室」。
 */
export function spanOverlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return bStart < aEnd && bEnd > aStart;
}

/** 合并重叠或相邻的片段（**仅用于渲染**，不参与是否冲突的判据） */
export function mergeBusySpans(spans: readonly BusySpan[]): BusySpan[] {
  const clean = spans
    .map((s) => ({ startMs: Number(s.startMs), endMs: Number(s.endMs) }))
    .filter((s) => Number.isFinite(s.startMs) && Number.isFinite(s.endMs) && s.endMs > s.startMs)
    .sort((a, b) => a.startMs - b.startMs);
  const out: BusySpan[] = [];
  for (const s of clean) {
    const last = out[out.length - 1];
    if (last && s.startMs <= last.endMs) {
      if (s.endMs > last.endMs) last.endMs = s.endMs;
      continue;
    }
    out.push({ ...s });
  }
  return out;
}

/** [fromMs, toMs) 是否完全空闲（无任何片段相交） */
export function isSlotFree(busy: readonly BusySpan[], fromMs: number, toMs: number): boolean {
  return !busy.some((b) => spanOverlaps(fromMs, toMs, b.startMs, b.endMs));
}

/**
 * 把一天切成若干格，逐格标注是否被占用。
 *
 * 判据与「找空闲」同源：格与片段**有交集**即占用（相邻不算）。
 * 长度固定为 (endMs-startMs)/bucketMs —— 前端据此渲染，不会出现「格数与数据对不上」。
 */
export function bucketize(
  busy: readonly BusySpan[],
  startMs: number,
  endMs: number,
  bucketMs: number = MEETING_BUCKET_MS,
): boolean[] {
  if (!(bucketMs > 0) || endMs <= startMs) return [];
  const n = Math.ceil((endMs - startMs) / bucketMs);
  const out: boolean[] = [];
  for (let i = 0; i < n; i += 1) {
    const s = startMs + i * bucketMs;
    const e = Math.min(s + bucketMs, endMs);
    out.push(!isSlotFree(busy, s, e));
  }
  return out;
}

/** 当前时刻在展示窗口里的进度（0–1）；不在窗口内返回 null（不画"现在"竖线） */
export function nowProgress(startMs: number, endMs: number, now: number = Date.now()): number | null {
  if (now < startMs || now > endMs) return null;
  return (now - startMs) / (endMs - startMs);
}
