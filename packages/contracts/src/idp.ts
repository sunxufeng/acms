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
  anyStudentRecordPerm,
} from './student-records.js';

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

/**
 * 「我的 IDP」菜单是否对当前用户可见 —— **唯一判据**（AppShell 调它，别在别处再写一份）。
 *
 * 🔴 为什么不复用 `idpPlans` 权限点：生产实测**只有** 系统管理员 / 院级管理 / student / parent
 *    持有它，**Phase1~Phase9（老师们实际用的角色）全都没有**。
 *    复用它 = 上线后除了管理员谁也看不到菜单（本项目反复踩过的「新权限点=上线即无人可见」）。
 *
 * 所以可见性与「学生记录」**同源**：任一记录类型的 read 或合并入口 read。
 * 语义上也成立 —— 这个页面的内容就是「我的 IDP 学生的 IDP 沟通记录」，而沟通记录就是学生记录。
 * **数据面**靠「我是该生的 IDP 老师」这个条件卡（后端 `idpOnlyMine`），不是靠权限点。
 *
 * ⚠️ 与学生记录一样兼容「合并前的旧菜单 key」：角色菜单白名单里可能存的是
 *    `dailyFollowups` / `studentRecords` 这类 key，而菜单里是 `myIdp`。
 *    严格只认 `myIdp` 会把**开了白名单的角色**挡在门外（2026-09-24 曹德强那个坑）。
 *    这里**不**自动放行 —— 白名单是管理员显式收敛，该补就补（部署后逐个角色补 `myIdp`），
 *    但要**同时认 `studentRecords`**：因为「学生记录可见 = 沟通记录可用」，
 *    管理员既然给了学生记录，这个页面就不该再被白名单挡一次。
 */
export function myIdpMenuVisible(input: {
  perms?: readonly string[] | null;
  /** 角色菜单白名单；空 / 缺省 = 不额外限制 */
  menus?: readonly string[] | null;
}): boolean {
  if (!anyStudentRecordPerm(input?.perms, 'read')) return false;
  const menus = input?.menus;
  if (!menus?.length) return true;
  if (menus.includes(MY_IDP_MENU_KEY)) return true;
  if (menus.includes(STUDENT_RECORD_ENTRY_KEY)) return true;
  // 合并前的旧 key（studentObservations / dailyFollowups / homeSchoolComms …）
  return STUDENT_RECORD_LEGACY_MENU_KEYS.some((k) => menus.includes(k));
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

/**
 * 按学生聚合 IDP 沟通次数（**唯一口径**，后端重算与聚合接口共用）。
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

/** 取一条沟通记录的摘要文本（主题优先；没有主题就退回总结的前 60 字） */
export function commSummaryOf(c: { subject?: unknown; summary?: unknown }): string {
  const s = String(c.subject ?? '').trim();
  if (s) return s;
  return String(c.summary ?? '').trim().slice(0, 60);
}

/** IDP沟通 这个记录类型的字面量（学生记录的 `记录类型` 字段取值） */
export const IDP_COMM_RECORD_TYPE = 'IDP沟通';

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
