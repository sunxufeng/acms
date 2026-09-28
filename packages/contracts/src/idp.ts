/**
 * IDP（个人发展计划）重构 —— 纯函数层（2026-09-26 峰哥需求）。
 *
 * ## 为什么单独一个文件
 *
 * 「沟通次数」这类口径要被**三处**共用：后端重算、后端聚合接口、前端展示文案。
 * 各写一份必然漂移（本项目最贵的 bug 类型），所以判据一律收在这里当纯函数，配单测。
 *
 * ## 数据模型（两段式，详见 tables.ts 的 idpConfig / idpStudent）
 *
 * ```
 * IDP配置（一行 = 一个「学年 × 学期」批次）
 *   └── IDP学生（一行 = 配置 × 学生，含该生这一期的 IDP 老师 + 沟通次数缓存）
 *         └── 沟通记录 = 「学生记录」里 记录类型=IDP沟通 的那批（不另建表）
 * ```
 *
 * 🔴 沟通记录**不落新表**是刻意的：学生记录里那批已经带附件、录音、AI 总结、关联笔记。
 *    新建一张沟通表 ⇒ 必须迁移 + 双向同步，而「学生记录里已关联的 IDP 记录自动出现在这里」
 *    本来就是一个池子，天生成立。
 */
import {
  STUDENT_RECORD_ENTRY_KEY,
  STUDENT_RECORD_LEGACY_MENU_KEYS,
  STUDENT_RECORD_TYPE_FIELD,
} from './student-records.js';
import { modulePermission } from './module-permissions.js';

// ─────────────────────────────────────────────────────────────
// 字段名（写库/读库都用这一份，别在别处硬写字符串）
// ─────────────────────────────────────────────────────────────

/** `IDP配置` 表字段 */
export const IDP_CONFIG_FIELDS = {
  配置名称: '配置名称',
  学年: '学年',
  学期: '学期',
  状态: '状态',
  学生范围: '学生范围',
  说明: '说明',
  创建人: '创建人',
  创建时间: '创建时间',
} as const;

/** `IDP学生` 表字段 */
export const IDP_STUDENT_FIELDS = {
  所属配置: '所属配置',
  学生: '学生',
  学生姓名: '学生姓名',
  班级: '班级',
  当前年级: '当前年级',
  IDP老师: 'IDP老师',
  状态: '状态',
  备注: '备注',
  沟通次数: '沟通次数',
  最近沟通时间: '最近沟通时间',
  最近沟通摘要: '最近沟通摘要',
} as const;

/** 配置状态（三档；不再用旧的「IDP状态」字典四档，避免"草稿/待确认/已确认/已关闭"与批次语义混） */
export const IDP_CONFIG_STATUSES = ['草稿', '进行中', '已归档'] as const;
export type IdpConfigStatus = (typeof IDP_CONFIG_STATUSES)[number];

/** 归档态：**不可写**（不给新增沟通、不给改老师、不给重算） */
export const IDP_ARCHIVED = '已归档';

/** 学生明细状态（可留空 = 未标记；不参与任何自动流转，纯人工标记） */
export const IDP_STUDENT_STATUSES = ['', '待沟通', '进行中', '已完成'] as const;

/** 「全部在校生」这个范围的显示名（创建配置时留痕用，也作为默认值） */
export const IDP_SCOPE_ALL = '全部在校生';

/** 拉学生的三种范围（创建配置时选） */
export type IdpScope =
  | { kind: 'all' }
  | { kind: 'grades'; values: string[] }
  | { kind: 'classes'; values: string[] };

/**
 * 「算不算在校」的判据 —— 与成绩册班级名单同口径（`markbook.service` 的 `BAD`）。
 *
 * ⚠️ **不用 `=== '在校'`**：生产有一批学生「当前状态」为空，按严格等值会被静默排除，
 *    而他们实际是在校的（"读不到 ≠ 0"）。所以用「**排除法**」——只要不是
 *    毕业 / 离校 / 流失 / 退学，就算在校。
 */
export function idpIsEnrolled(status: unknown): boolean {
  return !/毕业|离校|流失|退学/.test(String(status ?? ''));
}

// ─────────────────────────────────────────────────────────────
// 幂等键
// ─────────────────────────────────────────────────────────────

/** 配置幂等键：同一「学年 + 学期」只允许一个批次 */
export function idpConfigKey(yearId: string, term: string): string {
  return `${String(yearId ?? '').trim()}__${String(term ?? '').trim()}`;
}

/** 明细幂等键：同一配置内一个学生只允许一行（拉学生重复跑不会产生重复行） */
export function idpStudentKey(configId: string, studentId: string): string {
  return `${String(configId ?? '').trim()}__${String(studentId ?? '').trim()}`;
}

// ─────────────────────────────────────────────────────────────
// 时间
// ─────────────────────────────────────────────────────────────

/**
 * 时间字段宽容解析（四种形态：ms 数 / 秒数 / ISO 串 / 数字串）→ 毫秒；解析不出返回 0。
 *
 * 🔴 别用 `Number(v)`：`Number('2026-09-01')` 是 **NaN**，而 NaN 参与比较恒 false —
 *    整批记录会被当成"没有时间"静默跳过（套件里记过这个坑）。
 */
export function idpTimeMs(v: unknown): number {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v > 1e11 ? v : v * 1000;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n > 1e11 ? n : n * 1000;
  }
  const t = new Date(s).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/** 把毫秒时间戳裁到「当天 23:59:59.999」 */
function endOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

export interface IdpTermRange {
  /** 区间起点（含） */
  from: number;
  /** 区间终点（含） */
  to: number;
}

/**
 * 「学年 + 学期」→ 沟通记录的统计区间。
 *
 * 规则（**写进界面提示**，否则用户对不上数）：
 *   · 秋季 = 学年开始日 ~ 次年 1 月 31 日
 *   · 春季 = 次年 2 月 1 日 ~ 学年结束日
 *   · 学期串形如 `2026秋` / `2027春`，年份必须与学年对得上：
 *     秋的年份 = 学年开始年份；春的年份 = 学年开始年份 + 1
 *
 * 对不上（或学年日期缺失/学期格式不对）⇒ 返回 `null`，调用方**必须显式提示**，
 * 不能退化成"全表统计"（那会把别的学期的沟通算进来，数字看着有值、其实是错的）。
 */
export function idpTermRange(
  yearStart: unknown,
  yearEnd: unknown,
  term: string,
): IdpTermRange | null {
  const start = idpTimeMs(yearStart);
  const end = idpTimeMs(yearEnd);
  if (!start || !end) return null;
  const m = /^(\d{4})\s*([春秋])$/.exec(String(term ?? '').trim());
  if (!m) return null;
  const year = Number(m[1]);
  const season = m[2];
  const startYear = new Date(start).getFullYear();
  if (season === '秋') {
    if (year !== startYear) return null;
    return { from: start, to: endOfDay(new Date(startYear + 1, 0, 31).getTime()) };
  }
  if (year !== startYear + 1) return null;
  return { from: new Date(startYear + 1, 1, 1, 0, 0, 0, 0).getTime(), to: endOfDay(end) };
}

/** 学期区间的人话说明（界面提示用；`null` ⇒ 说明为什么算不出来） */
export function idpTermRangeText(range: IdpTermRange | null): string {
  if (!range) return '学年日期缺失或学期与学年对不上 —— 沟通次数无法统计，请检查配置的学年/学期';
  const f = new Date(range.from);
  const t = new Date(range.to);
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `${fmt(f)} ~ ${fmt(t)}`;
}

// ─────────────────────────────────────────────────────────────
// 菜单可见性
// ─────────────────────────────────────────────────────────────

/** 「我的 IDP」菜单 key（homepage 与角色菜单白名单共用） */
export const MY_IDP_MENU_KEY = 'myIdp';

/** 「IDP 统计」菜单 key（2026-09-29 新增） */
export const IDP_STATS_MENU_KEY = 'idpStats';

/**
 * 两个 IDP 菜单各自的**可见性判据** —— 唯一一份（AppShell 调它、后端守卫也调它）。
 *
 * ## 2026-09-29 改造（峰哥：「都另造权限吧，有权限的人才能看到这个菜单」）
 *
 * 改造前「我的 IDP」的判据是 `anyStudentRecordPerm('read')`（任一记录类型 read），
 * 好处是老师天然可见，坏处是 **student / parent 也持有 `module:dailyFollowups:read`**
 * ⇒ 他们同样能看到老师端菜单。现在两个菜单各有**独立权限点**：
 *   · `module:myIdp:read`   → 「我的 IDP」
 *   · `module:idpStats:read` → 「IDP 统计」
 * 权限点是**硬闸门**：没勾的人，谁都不能看（含菜单与接口）。
 *
 * ⚠️ 菜单白名单是**叠加**的收敛条件（角色里显式列了菜单就是"只给这些"）：
 *    白名单非空时要求它含本菜单 key。但**必须向后兼容**白名单里的旧 key ——
 *    生产实测 `Phase1` 角色有 13 项白名单（含 `studentObservations` 这个合并前的旧 key），
 *    **不含 `myIdp`**；严格只认 `myIdp` 会把 Phase1（招生老师）整体挡在门外（报障级）。
 *    ⇒ 兼容集合 = 本菜单 key ＋ `studentRecords`（合并入口）＋ 学生记录的各旧 key。
 *    这不会放大可见性：能被兼容 key 放行的人，前提是**已经持有新权限点**。
 */
export function idpMenuVisible(
  input: { perms?: readonly string[] | null; menus?: readonly string[] | null },
  menuKey: typeof MY_IDP_MENU_KEY | typeof IDP_STATS_MENU_KEY,
): boolean {
  const perms = input?.perms;
  // ① 硬闸门：必须持有本菜单自己的读权限
  if (!perms?.includes(modulePermission(menuKey, 'read'))) return false;
  // ② 菜单白名单（空 / 缺省 = 不额外限制）
  const menus = input?.menus;
  if (!menus?.length) return true;
  if (menus.includes(menuKey)) return true;
  if (menus.includes(STUDENT_RECORD_ENTRY_KEY)) return true;
  // 合并前的旧 key（studentObservations / dailyFollowups / homeSchoolComms …）
  return STUDENT_RECORD_LEGACY_MENU_KEYS.some((k) => menus.includes(k));
}

/**
 * 「IDP 统计」的**数据范围**判据：`true` = 看全部老师，`false` = 只看自己名下。
 *
 * 判据 = 持有 `module:idpStatsAll:read`（2026-09-29 v8 起**专用**，矩阵里显示为
 * 「IDP 统计 · 看全部」，挂在「IDP 统计」菜单下的缩进子行）。
 *
 * 🔴 为什么不能借 `module:idpPlans:read`（原实现）：那是**「IDP配置」页的入口**，
 *    借它等于"想看全部统计就必须同时能看到 IDP 配置页"—— 两件事绑在一起了。
 *    而且生产实测 `idpPlans:read` 还被 **student / parent** 持有（历史遗留），
 *    哪天给他们 `idpStats:read`，他们就会看到**全部老师**的统计。
 *
 * ⚠️ 该点 `legacyRead: null` ⇒ **不会**随版本迁移自动发放（否则等于人人看全部）；
 *    持有它 = 系统管理员（代码全量自愈）+ 管理员在角色矩阵里手工勾选的角色。
 *
 * ⚠️ 不要改成「角色名里含管理员」之类的字面判断：角色是**配置数据**，可以改名、可以新增，
 *    写死角色名的那天就是漏授权的那天。权限点才是真源。
 */
export function idpStatsSeeAll(perms: readonly string[] | undefined | null): boolean {
  return Boolean(perms?.includes(modulePermission('idpStatsAll', 'read')));
}

// ─────────────────────────────────────────────────────────────
// 「IDP 统计」的月份与间隔（纯函数：前后端共用同一份，别各写一遍）
// ─────────────────────────────────────────────────────────────

/** 北京时间的时区偏移（+08:00）—— 全站判「自然日 / 月份」都用它，别用服务器本地时区 */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 毫秒 → 北京时间 `YYYY-MM` */
export function idpMonthKey(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms + BEIJING_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * 毫秒 → 北京时间的「自然日序号」（自 epoch 起的天数）。
 *
 * 用途：算「相隔几天 / 距今几天」。**按自然日差**而不是 24 小时差 ——
 * 老师的认知是「9/14 和 9/17 隔了 3 天」，而不是「差了 3.0 天」；
 * 用 24h 差的话「9/14 23:00 → 9/15 01:00」会算成 0 天，明显反直觉。
 */
export function idpDayIndex(ms: number): number {
  return Math.floor((ms + BEIJING_OFFSET_MS) / 86400000);
}

/**
 * 相邻两次沟通的**自然日间隔**：输入按时间**升序**的毫秒数组，
 * 返回每一项与前一项相差的天数（第一项 / 去重后无前项时为 `null`）。
 *
 * ⚠️ 先按时间升序、再算相邻 —— 传进来没排序会得到负数（调用方排序，别在这里隐式排，
 *    否则「列表顺序」与「间隔」两个口径会悄悄用不同的序）。
 */
export function idpGapDaysAsc(sortedMs: readonly number[]): (number | null)[] {
  return sortedMs.map((ms, i) => {
    if (i === 0) return null;
    const prev = sortedMs[i - 1];
    if (!prev || !ms) return null;
    return idpDayIndex(ms) - idpDayIndex(prev);
  });
}

/** 最近一次沟通**距今**的自然日数（`todayMs` 由调用方传，便于测试固定"今天"） */
export function idpDaysAgo(lastMs: number, todayMs: number): number | null {
  if (!lastMs) return null;
  return Math.max(0, idpDayIndex(todayMs) - idpDayIndex(lastMs));
}

/**
 * 沟通次数口径（**唯一口径**，后端重算与聚合接口共用）。
 *
 * 口径（界面提示同步这句话）：
 *   「沟通次数 = 该学生在**本配置的学年学期区间内**、记录类型为 IDP沟通 的记录数；
 *     不区分沟通人（谁记的都算）。」
 *
 * @param comms    该学生的 IDP沟通 记录（**已按学生过滤**，不是全表）
 * @param range    学年学期区间；`null` ⇒ 不该调用（调用方应先提示配置有问题）
 */
export function idpSummarizeComms(
  comms: readonly IdpCommLike[],
  range: IdpTermRange,
): IdpCommStat {
  let count = 0;
  let lastAt = 0;
  let lastSummary = '';
  let noTime = 0;
  for (const c of comms) {
    const t = idpTimeMs(c.time);
    if (!t) {
      noTime += 1;
      continue;
    }
    if (t < range.from || t > range.to) continue;
    count += 1;
    if (t > lastAt) {
      lastAt = t;
      lastSummary = commSummaryOf(c);
    }
  }
  return { count, lastAt, lastSummary, noTime };
}

// ─────────────────────────────────────────────────────────────
// 沟通次数口径
// ─────────────────────────────────────────────────────────────

export interface IdpCommLike {
  /** 记录类型 */
  type?: unknown;
  /** 关联学生（record id） */
  studentId?: unknown;
  /** 沟通时间（任意形态） */
  time?: unknown;
  /** 沟通主题（最新摘要用） */
  subject?: unknown;
}

export interface IdpCommStat {
  /** 落在区间内的沟通条数 */
  count: number;
  /** 最近一次沟通时间（ms）；没有则 0 */
  lastAt: number;
  /** 最近一次的摘要（主题优先，退回总结前若干字） */
  lastSummary: string;
  /**
   * **时间读不出来的**条数 —— 「读不到 ≠ 0」，这个数必须单独报出来，
   * 否则用户看到 count 少了会以为系统丢了记录。
   */
  noTime: number;
}

/** 取一条沟通记录的摘要文本（主题优先；没有主题就退回总结的前 60 字） */
export function commSummaryOf(c: { subject?: unknown; summary?: unknown }): string {
  const s = String(c.subject ?? '').trim();
  if (s) return s;
  return String(c.summary ?? '').trim().slice(0, 60);
}

/** IDP沟通 这个记录类型的字面量（学生记录的 `记录类型` 字段取值） */
export const IDP_COMM_RECORD_TYPE = 'IDP沟通';

/**
 * 「笔记关联」表里，**IDP 沟通记录**的关联行会写成哪些 `实体类型`。
 *
 * 🔴 必须同时认两个值 —— 这是 2026-09-29 实测出来的（生产库 13 条 IDP沟通记录）：
 *
 * ```
 * 实体类型=学生记录 → 13     ← 全部
 * 实体类型=IDP沟通  → 0
 * ```
 *
 * 原因：写侧（「我的笔记 → 转换」的留痕与后续 `PUT /getnote/links`）用的是**模块标签**
 * （`target.label` = 「学生记录」），而 IDP 时间线最初只按**记录类型**（`IDP沟通`）过滤
 * ⇒ **一条笔记都读不出来**（页面「笔记」列恒空，且不报错）。这正是项目里反复踩的
 * 「同一件事两套判据」—— 修法是**读取侧放宽到写侧实际会写的值**，而不是去改写侧
 * （改写侧会让已有的 13 条历史关联全部对不上）。
 *
 * ⚠️ 放宽是安全的：调用方传入的 `recordIds` 全部来自「记录类型 = IDP沟通」的记录，
 *    而业务记录 id 全局唯一 ⇒ 不会误收别的模块的笔记。
 *
 * ⚠️ 判据只有这一份：`linkedNotesOf` 与 `linkedNoteMapOf` 都必须用它，不许再写字面量。
 */
export const IDP_COMM_NOTE_ENTITY_TYPES: readonly string[] = [IDP_COMM_RECORD_TYPE, '学生记录'];

/**
 * IDP 列表「学生」列的展示文案 = **中文名｜英文名**（2026-09-26 峰哥要求）。
 *
 * 为什么抽成纯函数：这个格式被两个页面用（IDP 配置页 / 我的 IDP 页），
 * 各写一份必然漂移 —— 以后要改成「中文名（英文名）」就得记得改两处，漏一处不报错。
 *
 * 英文名缺失（不少学生本来就没填）时**只出中文名**，不留「｜」这种空尾巴。
 * 分隔符用全角「｜」，与系统里用户名的既有写法（`丁懿｜Kevin`）一致。
 */
export function idpStudentLabel(name: unknown, nameEn: unknown): string {
  const cn = String(name ?? '').trim();
  const en = String(nameEn ?? '').trim();
  if (!cn) return en;
  return en ? `${cn}｜${en}` : cn;
}

/** 学生记录里「记录类型」字段名（转出，避免各模块各写一份） */
export const IDP_COMM_TYPE_FIELD = STUDENT_RECORD_TYPE_FIELD;

/**
 * 关联字段值的宽容解析 → id 数组（四种形态都吃：`string[]` / `{link_record_ids:[…]}` /
 * `{record_ids:[…]}` / JSON 字符串 / 单个字符串）。
 *
 * 🔴 为什么要宽容：`{"link_record_ids": null}` 这种「空关联」的序列化形态，
 *    用 `String(v) !== ''` 判空会**误判成"有值"**（生产实测邮件归档 816/6383 封都是它）。
 *    所以判空一律 `idpLinkIds(v).length > 0`，取值一律走这个函数。
 *
 * ⚠️ 项目里已有几份同构实现（`mail-archive.meta` 的 `idsOf`、`curriculum.logic` 的
 *    `toIds` 等）。本次**不跨模块 import**（会把 idp 模块和邮件归档耦上），
 *    新代码请用这一份。
 */
export function idpLinkIds(v: unknown): string[] {
  const one = (x: unknown): string => (typeof x === 'string' ? x.trim() : '');
  if (v == null) return [];
  if (Array.isArray(v)) return v.map(one).filter(Boolean);
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return [];
    if (s.startsWith('[') || s.startsWith('{')) {
      try {
        return idpLinkIds(JSON.parse(s));
      } catch {
        return [];
      }
    }
    return [s];
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    for (const key of ['link_record_ids', 'record_ids', 'ids'] as const) {
      if (key in o) return idpLinkIds(o[key]);
    }
    return [];
  }
  return [];
}

/** 关联字段取**单个** id（多值时取第一个） */
export function idpLinkId(v: unknown): string {
  return idpLinkIds(v)[0] ?? '';
}

/**
 * 字段值 → 可读文本（**宽容**，四种形态都吃）。
 *
 * 🔴 为什么不能用 `String(v)`：关联字段的空壳值是对象 `{"link_record_ids": null}`，
 *    `String()` 会得到字符串 **`"[object Object]"`** —— 不抛错、不写日志，
 *    只是数据被悄悄写坏（IDP 明细首版 82 行的「班级」列全是它，
 *    直到上传飞书导师数据对照班级时才发现）。
 *
 * 解析顺序：字符串/数字直接用 → 数组取第一个非空 → 对象取 `text` / `name` / `value`
 * → **都没有就返回空串**（空壳 `{"link_record_ids": null}` 属于这一类，是"空关联"不是"有值"）。
 */
export function idpTextOf(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    for (const x of v) {
      const t = idpTextOf(x);
      if (t) return t;
    }
    return '';
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    for (const k of ['text', 'name', 'value'] as const) {
      const t = idpTextOf(o[k]);
      if (t) return t;
    }
    return '';
  }
  return '';
}
