/**
 * 出勤率口径 —— **零依赖纯函数**（不碰 Nest / DB / 网络，可离线拿生产数据照跑）。
 *
 * 为什么单独一个文件：口径要同时被「报表接口」「离线验证脚本」「前端口径说明」引用，
 * 写成两份必然漂移（出现「接口算出 92%、页面说明写 95%」这类对不上的问题）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 最终口径（改这里之前先读完）
 * ─────────────────────────────────────────────────────────────────────────
 * 1. **参与统计的记录**：只算「**已通过**」的考勤终态记录（`审核状态 = 已通过`）。
 *    待审核 / 已驳回 / **没写审核状态（归一视为待审核）** 的记录单独计数，
 *    既不进分子也不进分母 —— 未审核的数据不能算进结算基数。
 * 2. **计入统计=否 的考勤码整条排除**（分母分子都不算），如「校内活动」。
 * 3. **方向**决定归属：`在校` → 实到（分子）；`不在校` → 未出勤。
 * 4. **语义范围**决定细分：
 *      在校        → 正常出勤
 *      在校-迟到   → 迟到
 *      离校-提前   → 早退（方向通常为「在校」）
 *      离校        → 请假（经批准离校：事假 / 病假）
 *    ⇒ 未出勤里：语义范围 = `离校` 记「请假」，其余记「缺勤」。
 * 5. **出勤率 = 实到 / 应出勤人次**（应出勤人次 = 参与统计的记录数）。
 * 6. **异常**：`考勤状态 = 异常` 的记录数，与上面几个桶正交（同一批已通过且计入统计的记录里数）。
 *
 * ⚠️ 码表兜底：生产「考勤码表」当前是**空表**（0 行，2026-09-14 实测），
 *    所以码表为空 / 码表里没配某个码时，回落到「内置默认码表」（= 原先硬编码在
 *    前端 columns.tsx 里的 7 个考勤结果）。两边都认不出的码：**不猜**，
 *    单独计数（unknownCode）并且不进分子分母。
 */

import { textOf } from '../markbook/markbook.logic.js';
import { linkIds } from '../shared/record.util.js';

// ── 审核终态 ───────────────────────────────────────────────────────────────

export const REVIEW_PENDING = '待审核';
export const REVIEW_APPROVED = '已通过';
export const REVIEW_REJECTED = '已驳回';
export type ReviewStatus = typeof REVIEW_PENDING | typeof REVIEW_APPROVED | typeof REVIEW_REJECTED;
export const REVIEW_STATUSES: readonly ReviewStatus[] = [REVIEW_PENDING, REVIEW_APPROVED, REVIEW_REJECTED];

/**
 * 审核状态归一化。
 * ⚠️ 空值 / 未标注 / 认不出的值一律按「待审核」——新建记录（含通用 CRUD 表单、
 * 批量导入、历史手工插入的行）不会因为没有这个字段就被算进出勤率。
 */
export function reviewStatusOf(v: unknown): ReviewStatus {
  const s = textOf(v);
  if (s === REVIEW_APPROVED) return REVIEW_APPROVED;
  if (s === REVIEW_REJECTED) return REVIEW_REJECTED;
  return REVIEW_PENDING;
}

// ── 时间：毫秒 / 秒 / 「YYYY-MM-DD」三种形态都要认 ─────────────────────────
//
// ⚠️ 考勤记录的「考勤日期」实测**两种形态并存**：
//   - 打卡接口（sign.service）写的是本地日期字符串 "YYYY-MM-DD"；
//   - 通用 CRUD（RecordMeta.dateFields）写的是毫秒时间戳。
// 直接 Number() 会让字符串形态变成 NaN，整条记录从趋势里消失（静默漏报）。

export function toMs(v: unknown): number {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v > 1e11 ? v : v * 1000;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n > 1e11 ? n : n * 1000;
  }
  const t = new Date(s.replace(' ', 'T')).getTime();
  return Number.isNaN(t) ? 0 : t;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** 本地日期 YYYY-MM-DD */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 本地周一（所在周的起点，YYYY-MM-DD） */
export function weekStartKey(ms: number): string {
  const d = new Date(ms);
  const dow = (d.getDay() + 6) % 7; // 周一=0
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - dow);
  return `${monday.getFullYear()}-${pad(monday.getMonth() + 1)}-${pad(monday.getDate())}`;
}

// ── 考勤码（口径配置）────────────────────────────────────────────────────

export type Direction = '在校' | '不在校';
export type Scope = '在校' | '在校-迟到' | '离校' | '离校-提前';

export interface RateCode {
  /** 简写（稳定标识，历史记录按它引用） */
  short: string;
  /** 名称（显示用；历史记录里也可能存名称） */
  name: string;
  direction: Direction;
  scope: Scope;
  /** 计入统计=否 的码整条排除（分子分母都不算） */
  counted: boolean;
  /** 配置来源：配置=考勤码表；默认=内置兜底 */
  source: '配置' | '默认';
}

/** 内置默认码表：考勤码表为空时兜底（= 改造前硬编码在前端的 7 个考勤结果） */
const BUILTIN_CODES: readonly RateCode[] = [
  { short: '出勤', name: '出勤', direction: '在校', scope: '在校', counted: true, source: '默认' },
  { short: '迟到', name: '迟到', direction: '在校', scope: '在校-迟到', counted: true, source: '默认' },
  { short: '早退', name: '早退', direction: '在校', scope: '离校-提前', counted: true, source: '默认' },
  { short: '事假', name: '事假', direction: '不在校', scope: '离校', counted: true, source: '默认' },
  { short: '病假', name: '病假', direction: '不在校', scope: '离校', counted: true, source: '默认' },
  { short: '缺勤', name: '缺勤', direction: '不在校', scope: '在校', counted: true, source: '默认' },
  { short: '校内活动', name: '校内活动', direction: '在校', scope: '在校', counted: false, source: '默认' },
];

function normalizeDirection(v: unknown): Direction {
  // 认不出的方向按「在校」——方向是统计主判定轴，默认落在「算实到」比误判成缺勤温和
  return textOf(v) === '不在校' ? '不在校' : '在校';
}

function normalizeScope(v: unknown): Scope {
  const s = textOf(v);
  return s === '在校-迟到' || s === '离校' || s === '离校-提前' ? s : '在校';
}

/**
 * 生效码表 = 考勤码表配置（状态≠停用） + 内置默认（补配置里没有的码）。
 * 匹配键同时认「简写」与「名称」，避免配置只写了一个时重复两条。
 */
export function buildCodeTable(configRows: readonly Record<string, unknown>[]): RateCode[] {
  const out: RateCode[] = [];
  const seen = new Set<string>();
  const push = (c: RateCode): void => {
    for (const k of [c.short, c.name]) {
      if (k && seen.has(k)) return;
    }
    for (const k of [c.short, c.name]) if (k) seen.add(k);
    out.push(c);
  };
  for (const r of configRows) {
    if (textOf(r['状态']) === '停用') continue;
    const short = textOf(r['简写']);
    const name = textOf(r['名称']) || short;
    if (!short && !name) continue;
    push({
      short: short || name,
      name,
      direction: normalizeDirection(r['方向']),
      scope: normalizeScope(r['语义范围']),
      // 只有显式「否」才排除；没填该字段的配置行按计入处理（不因为漏配就把数据全丢掉）
      counted: textOf(r['计入统计']) !== '否',
      source: '配置',
    });
  }
  for (const c of BUILTIN_CODES) push(c);
  return out;
}

/** 记录上的「考勤结果」→ 生效码；认不出返回 null（不猜口径） */
export function resolveCode(value: unknown, codes: readonly RateCode[]): RateCode | null {
  const v = textOf(value);
  if (!v) return null;
  return codes.find((c) => c.name === v || c.short === v) ?? null;
}

// ── 聚合 ─────────────────────────────────────────────────────────────────

export interface AttendanceInputRow {
  id: string;
  fields: Record<string, unknown>;
}

export interface StudentInfo {
  id: string;
  name: string;
  /** 学生档案「当前年级」（生产唯一有值的分组维度） */
  grade: string;
  /** 学生档案「当前班级」（生产全为 null，将来补上会自动生效） */
  cls: string;
}

export interface Bucket {
  key: string;
  expected: number;
  present: number;
  rate: number;
  late: number;
  earlyLeave: number;
  leave: number;
  absent: number;
  abnormal: number;
}

export interface StudentBucket extends Bucket {
  studentId: string;
  studentName: string;
  grade: string;
  cls: string;
}

export interface TrendPoint {
  key: string;
  expected: number;
  present: number;
  rate: number;
  late: number;
  leave: number;
  absent: number;
  abnormal: number;
}

export interface AttendanceSummary {
  /** 参与统计的记录数（已通过 + 计入统计）= 出勤率分母 */
  expected: number;
  /** 实到（方向=在校）= 出勤率分子 */
  present: number;
  /** 未出勤合计（方向=不在校）= 请假 + 缺勤 */
  absentTotal: number;
  /** 请假（不在校 且 语义范围=离校） */
  leave: number;
  /** 缺勤（不在校 且 语义范围≠离校） */
  absent: number;
  late: number;
  earlyLeave: number;
  abnormal: number;
  /** 出勤率 %（1 位小数） */
  rate: number;
  /** 考勤记录总数（区间 + 筛选内，含未通过 / 未计入） */
  total: number;
  /** 待审核（含未标注）—— 不进分子分母 */
  pending: number;
  /** 其中「审核状态」字段为空的（未标注）条数 */
  pendingUnlabeled: number;
  /** 已驳回 */
  rejected: number;
  /** 计入统计=否 被排除的条数 */
  excluded: number;
  /** 认不出口径的码（两边码表都没有）被排除的条数 */
  unknownCode: number;
}

export interface AttendanceReport {
  from: string;
  to: string;
  /** 是否因超过拉取上限被截断（数据量超预期时页面会提示） */
  truncated: boolean;
  summary: AttendanceSummary;
  byClass: Bucket[];
  byGrade: Bucket[];
  byStudent: StudentBucket[];
  byDay: TrendPoint[];
  byWeek: TrendPoint[];
  options: { classes: string[]; grades: string[] };
  /** 生效码表（含内置兜底），页面口径说明用它列出「哪些码不计入」 */
  codes: RateCode[];
  /**
   * 各桶实际出现的「考勤结果」原始值。
   * 下钻（点 KPI 跳列表）只在该桶**恰好一个原始值**时给出链接 —— 列表侧是等值筛选，
   * 多个值筛不出来，宁可不给链接也不给一个数字对不上的链接。
   */
  bucketValues: {
    present: string[];
    late: string[];
    earlyLeave: string[];
    leave: string[];
    absent: string[];
    pending: string[];
  };
}

const UNLABELED = '未标注';

function emptyBucket(key: string): Bucket {
  return { key, expected: 0, present: 0, rate: 0, late: 0, earlyLeave: 0, leave: 0, absent: 0, abnormal: 0 };
}

function finish<T extends Bucket>(b: T): T {
  b.rate = b.expected > 0 ? Math.round((b.present / b.expected) * 1000) / 10 : 0;
  return b;
}

function bump(b: Bucket, dir: Direction, scope: Scope, abnormal: boolean): void {
  b.expected += 1;
  if (dir === '在校') {
    b.present += 1;
    if (scope === '在校-迟到') b.late += 1;
    if (scope === '离校-提前') b.earlyLeave += 1;
  } else if (scope === '离校') {
    b.leave += 1;
  } else {
    b.absent += 1;
  }
  if (abnormal) b.abnormal += 1;
}

export interface ComputeOptions {
  rows: readonly AttendanceInputRow[];
  /** 学生档案索引：record id → 学生信息 */
  students: ReadonlyMap<string, StudentInfo>;
  /** 班级表索引：record id → 班级名称（考勤记录「班级」是关联字段） */
  classNames: ReadonlyMap<string, string>;
  /** 生效码表（buildCodeTable 的输出） */
  codes: readonly RateCode[];
  fromMs?: number;
  toMs?: number;
  /** 按班级筛选（班级显示名） */
  cls?: string;
  /** 按年级筛选（学生档案「当前年级」） */
  grade?: string;
  /** 学生排行取前 N（默认 20） */
  topN?: number;
  truncated?: boolean;
}

/** 出勤率报表全量聚合（内存计算，几千条量级足够） */
export function computeAttendanceReport(opts: ComputeOptions): AttendanceReport {
  const { rows, students, classNames, codes } = opts;
  const fromMs = opts.fromMs ?? 0;
  const toMsBound = opts.toMs ?? Number.POSITIVE_INFINITY;
  const topN = opts.topN ?? 20;

  const byClassMap = new Map<string, Bucket>();
  const byGradeMap = new Map<string, Bucket>();
  const byStudentMap = new Map<string, StudentBucket>();
  const byDayMap = new Map<string, TrendPoint>();
  const byWeekMap = new Map<string, TrendPoint>();
  const classSet = new Set<string>();
  const gradeSet = new Set<string>();
  const vals = {
    present: new Set<string>(),
    late: new Set<string>(),
    earlyLeave: new Set<string>(),
    leave: new Set<string>(),
    absent: new Set<string>(),
    pending: new Set<string>(),
  };

  const summary: AttendanceSummary = {
    expected: 0, present: 0, absentTotal: 0, leave: 0, absent: 0,
    late: 0, earlyLeave: 0, abnormal: 0, rate: 0,
    total: 0, pending: 0, pendingUnlabeled: 0, rejected: 0, excluded: 0, unknownCode: 0,
  };

  for (const row of rows) {
    const f = row.fields;
    const at = toMs(f['考勤日期'] ?? f['到校时间'] ?? f['离校时间']);
    // 拿不到日期的记录不参与时间区间过滤（宁可把它算进来，也不要静默漏掉一条已通过的出勤），
    // 但它不会出现在趋势里（趋势按日/周分组，没有日期就无从归组）。
    if (fromMs && at && at < fromMs) continue;
    if (toMsBound !== Number.POSITIVE_INFINITY && at && at > toMsBound) continue;

    const studentId = linkIds(f['关联学生编号'])[0] ?? '';
    const student = studentId ? students.get(studentId) : undefined;
    const classId = linkIds(f['班级'])[0] ?? '';
    // 班级：优先用考勤记录自己的「班级」关联；为空回落到学生档案「当前班级」（生产全空，将来补上自动生效）
    const cls = (classId ? classNames.get(classId) : '') || student?.cls || '';
    const grade = student?.grade ?? '';
    if (opts.cls && cls !== opts.cls) continue;
    if (opts.grade && grade !== opts.grade) continue;

    summary.total += 1;
    classSet.add(cls || UNLABELED);
    gradeSet.add(grade || UNLABELED);

    const code = resolveCode(f['考勤结果'], codes);
    const rawValue = textOf(f['考勤结果']);
    const review = reviewStatusOf(f['审核状态']);
    const approved = review === REVIEW_APPROVED;

    if (!approved) {
      if (review === REVIEW_REJECTED) summary.rejected += 1;
      else {
        summary.pending += 1;
        if (!textOf(f['审核状态'])) summary.pendingUnlabeled += 1;
        if (rawValue) vals.pending.add(rawValue);
      }
      // 未通过终态的记录：单独计数，不进分子分母（也不进各维度）
      continue;
    }
    if (!code) {
      summary.unknownCode += 1;
      continue;
    }
    if (!code.counted) {
      summary.excluded += 1;
      continue;
    }

    const abnormal = textOf(f['考勤状态']) === '异常';
    summary.expected += 1;
    if (code.direction === '在校') {
      summary.present += 1;
      if (rawValue) vals.present.add(rawValue);
      if (code.scope === '在校-迟到') {
        summary.late += 1;
        if (rawValue) vals.late.add(rawValue);
      }
      if (code.scope === '离校-提前') {
        summary.earlyLeave += 1;
        if (rawValue) vals.earlyLeave.add(rawValue);
      }
    } else {
      summary.absentTotal += 1;
      if (code.scope === '离校') {
        summary.leave += 1;
        if (rawValue) vals.leave.add(rawValue);
      } else {
        summary.absent += 1;
        if (rawValue) vals.absent.add(rawValue);
      }
    }
    if (abnormal) summary.abnormal += 1;

    // 按班级 / 按年级
    const ck = cls || UNLABELED;
    const cb = byClassMap.get(ck) ?? emptyBucket(ck);
    bump(cb, code.direction, code.scope, abnormal);
    byClassMap.set(ck, cb);

    const gk = grade || UNLABELED;
    const gb = byGradeMap.get(gk) ?? emptyBucket(gk);
    bump(gb, code.direction, code.scope, abnormal);
    byGradeMap.set(gk, gb);

    // 学生排行
    const sid = studentId || `__no_student__:${textOf(f['考勤编号']) || row.id}`;
    const sb = byStudentMap.get(sid) ?? {
      ...emptyBucket(sid),
      studentId: studentId || '',
      studentName: student?.name || UNLABELED,
      grade: grade || UNLABELED,
      cls: cls || UNLABELED,
    };
    bump(sb, code.direction, code.scope, abnormal);
    byStudentMap.set(sid, sb);

    // 趋势（按日 / 按周）
    if (at) {
      const dk = dayKey(at);
      const d = byDayMap.get(dk) ?? { key: dk, expected: 0, present: 0, rate: 0, late: 0, leave: 0, absent: 0, abnormal: 0 };
      d.expected += 1;
      if (code.direction === '在校') d.present += 1;
      else if (code.scope === '离校') d.leave += 1;
      else d.absent += 1;
      if (code.scope === '在校-迟到') d.late += 1;
      if (abnormal) d.abnormal += 1;
      byDayMap.set(dk, d);

      const wk = weekStartKey(at);
      const w = byWeekMap.get(wk) ?? { key: wk, expected: 0, present: 0, rate: 0, late: 0, leave: 0, absent: 0, abnormal: 0 };
      w.expected += 1;
      if (code.direction === '在校') w.present += 1;
      else if (code.scope === '离校') w.leave += 1;
      else w.absent += 1;
      if (code.scope === '在校-迟到') w.late += 1;
      if (abnormal) w.abnormal += 1;
      byWeekMap.set(wk, w);
    }
  }

  const rateOf = (r: { expected: number; present: number }): number =>
    r.expected > 0 ? Math.round((r.present / r.expected) * 1000) / 10 : 0;

  const trendSort = (a: TrendPoint, b: TrendPoint): number => a.key.localeCompare(b.key);
  const byDay = [...byDayMap.values()].map((d) => ({ ...d, rate: rateOf(d) })).sort(trendSort);
  const byWeek = [...byWeekMap.values()].map((w) => ({ ...w, rate: rateOf(w) })).sort(trendSort);

  const byStudent = [...byStudentMap.values()]
    .filter((s) => s.absent + s.late > 0)
    .sort((a, b) => b.absent + b.late - (a.absent + a.late) || a.studentName.localeCompare(b.studentName))
    .slice(0, topN)
    .map((s) => finish(s));

  summary.rate = rateOf(summary);

  return {
    from: fromMs ? dayKey(fromMs) : '',
    to: toMsBound === Number.POSITIVE_INFINITY ? '' : dayKey(toMsBound),
    truncated: opts.truncated === true,
    summary,
    byClass: [...byClassMap.values()].map(finish).sort((a, b) => b.expected - a.expected || a.key.localeCompare(b.key)),
    byGrade: [...byGradeMap.values()].map(finish).sort((a, b) => b.expected - a.expected || a.key.localeCompare(b.key)),
    byStudent,
    byDay,
    byWeek,
    options: { classes: [...classSet].sort(), grades: [...gradeSet].sort() },
    codes: [...codes],
    bucketValues: {
      present: [...vals.present].sort(),
      late: [...vals.late].sort(),
      earlyLeave: [...vals.earlyLeave].sort(),
      leave: [...vals.leave].sort(),
      absent: [...vals.absent].sort(),
      pending: [...vals.pending].sort(),
    },
  };
}

