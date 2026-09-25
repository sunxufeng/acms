/**
 * 考试与成绩 —— 输入解析、期末总评结转、班级排名、GPA。**零依赖纯函数**。
 *
 * ⚠️ 与 `markbook/markbook.logic.ts` 的分工：
 *   · markbook.logic  = 成绩册的**过程**口径（两层权重、等级映射、达标判定）
 *   · 本文件          = 成绩册之上的**结果**口径（结转、排名、GPA、输入容错）
 *   两边**共用** safeWeight / normScore / weightedTotal / pickLevel / isAttained，
 *   绝不复制一份。任何一处改口径只改 markbook.logic，本文件跟着变。
 *
 * 参照 RosarioSIS v13 Grades 模块（Grades.php / Assignments.php / InputFinalGrades.php）：
 *   · 宽容输入：`85` / `85%` / 字母等级 / `*` 免考 / `缺` 缺考 / 越界截断
 *   · 结转：Σ(归一化 × 列权重 × 类型权重) ÷ Σ权重，分母只算参与项（自归一化）
 *   · 排名：竞赛排名法（同分同名次，下一名跳号）
 */

import {
  type LevelDef,
  isAttained,
  pickLevel,
  safeWeight,
  weightedTotal,
} from '../markbook/markbook.logic.js';

// ─────────────────────────────────────────────────────────────
// 1. 枚举
// ─────────────────────────────────────────────────────────────

/**
 * 单元格状态。
 *
 * 「未录入」与「免考」是两件事 —— 这是老系统最常见的歧义来源：
 *   · 未录入 = 老师还没录 → 不进分母（score 为 null）
 *   · 免考   = 考了不用考/没参加，不计入 → **不进分母**
 *   · 缺考   = 该来没来 → **进分母，按 0 分算**
 */
export type CellStatus = '正常' | '免考' | '缺考';

export const CELL_STATUSES: readonly CellStatus[] = ['正常', '免考', '缺考'];

/** 舍入口径（写在成绩批次上） */
export type RoundMode = '不处理' | '四舍五入' | '向上取整' | '向下取整' | '保留1位小数';
export const ROUND_MODES: readonly RoundMode[] = ['四舍五入', '保留1位小数', '向上取整', '向下取整', '不处理'];
export const DEFAULT_ROUND_MODE: RoundMode = '保留1位小数';

/** 免考怎么算（写在成绩批次上） */
export type ExcusedMode = '不计入分母' | '计0分';
export const EXCUSED_MODES: readonly ExcusedMode[] = ['不计入分母', '计0分'];

/** 缺考怎么算（写在成绩批次上） */
export type AbsentMode = '计0分' | '不计入分母';
export const ABSENT_MODES: readonly AbsentMode[] = ['计0分', '不计入分母'];

/** 总评状态 */
export type TermGradeStatus = '草稿' | '已确认';
/** 数据来源 */
export type TermGradeSource = '自动结转' | '手工调整';
/** 成绩单状态 */
export type ReportCardStatus = '未生成' | '已生成';

// ─────────────────────────────────────────────────────────────
// 2. 输入解析（RosarioSIS 的宽容输入）
// ─────────────────────────────────────────────────────────────

export interface ScoreParseOptions {
  /** 该列满分；缺失/非正数按 100 */
  fullMark?: unknown;
  /** 该列的等级体系（用于把字母等级折成分数） */
  levels?: LevelDef[];
}

export interface ScoreParseResult {
  ok: boolean;
  /** 解析出的得分；`免考` 与「未录入」都是 null */
  score: number | null;
  status: CellStatus;
  /** 规范化后用于回显的文本（前端把它写回输入框） */
  display: string;
  /** 可容忍的问题（已自动修正，如超满分截断）——黄条提示 */
  warning?: string;
  /** 致命问题（非法输入）——红条提示，**保留用户原值，不静默清空** */
  error?: string;
}

/** 免考的各种写法 */
const EXCUSED_TOKENS = ['*', '＊', '免', '免考', '缺考免', 'ex', 'exempt', 'excused'];
/** 缺考的各种写法 */
const ABSENT_TOKENS = ['缺', '缺考', '缺席', 'ab', 'abs', 'absent', 'na', 'n/a', '-'];

function normFullMark(v: unknown): number {
  const f = Number(v);
  return Number.isFinite(f) && f > 0 ? f : 100;
}

/** 把字母等级折成分数：优先取等级配的 [min,max] 中位，没配区间就按序号等分取档位中位 */
function levelToScore(levels: LevelDef[], label: string): number | null {
  if (!levels?.length) return null;
  const key = label.trim().toUpperCase();
  const hit =
    levels.find((l) => l.label.trim().toUpperCase() === key) ??
    // 容忍 `A-` 写成 `A -`、`B+` 写成 `b＋`（全角加号）
    levels.find((l) => l.label.trim().toUpperCase().replace(/\s+/g, '') === key.replace(/\s+/g, '').replace('＋', '+'));
  if (!hit) return null;
  if (hit.min != null && hit.max != null) return (hit.min + hit.max) / 2;
  if (hit.min != null) return hit.min;
  if (hit.max != null) return hit.max;
  // 没配区间：按序号等分（序号越小越好 ⇒ 分数越高），取该档中位
  const sorted = [...levels].sort((a, b) => a.order - b.order);
  const idx = sorted.findIndex((l) => l.id === hit.id);
  if (idx < 0) return null;
  const step = 100 / sorted.length;
  return Math.round(100 - step * idx - step / 2);
}

/**
 * 解析成绩册单元格的输入文本。
 *
 * 返回值语义：
 *   ok=true  → score / status 可直接落库（warning 时表示已自动修正）
 *   ok=false → **不要落库**，前端把 error 显示出来并保留用户原值
 *
 * ⚠️ 与旧实现的区别（这是本次要修的主要问题）：
 *   旧代码 `Number(trimmed)` —— `八十八` 会变成 `NaN` 被写成 null，
 *   老师看到的是「输入没了」，查不出原因。现在非法输入会明确报错。
 */
export function parseScoreInput(raw: unknown, opts: ScoreParseOptions = {}): ScoreParseResult {
  const fullMark = normFullMark(opts.fullMark);
  const text = String(raw ?? '').trim();

  // 空 = 未录入（不是 0，也不是免考）
  if (!text) return { ok: true, score: null, status: '正常', display: '' };

  const lower = text.toLowerCase();

  // 免考
  if (EXCUSED_TOKENS.includes(lower)) {
    return { ok: true, score: null, status: '免考', display: '免' };
  }
  // 缺考（按 0 分算，但要和「真的考了 0 分」区分开）
  if (ABSENT_TOKENS.includes(lower)) {
    return { ok: true, score: 0, status: '缺考', display: '缺' };
  }

  let value: number | null = null;
  let fromPercent = false;

  if (text.endsWith('%') || text.endsWith('％')) {
    const p = Number(text.slice(0, -1).trim());
    if (Number.isFinite(p)) {
      value = (p / 100) * fullMark;
      fromPercent = true;
    }
  } else {
    // 全角数字/小数点先归一化（中文输入法下极容易打出来）
    const normalized = text
      .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(/[．。]/g, '.')
      .replace(/[－ー—–]/g, '-');
    const n = Number(normalized);
    if (Number.isFinite(n) && normalized !== '') {
      value = n;
    } else if (opts.levels?.length) {
      // 当作等级处理（A / B+ / 优秀 …）
      value = levelToScore(opts.levels, text);
    }
  }

  if (value == null || !Number.isFinite(value)) {
    return {
      ok: false,
      score: null,
      status: '正常',
      display: text,
      error: `「${text}」不是合法分数（可填数字、85%、等级、* 免考、缺 缺考）`,
    };
  }

  let warning: string | undefined;
  if (value < 0) {
    // RosarioSIS：负数归 0（而不是拒绝）
    warning = `得分 ${text} 为负数，已按 0 计`;
    value = 0;
  } else if (value > fullMark) {
    warning = `${fromPercent ? '按百分比折算后' : ''}得分 ${round2(value)} 超过满分 ${fullMark}，已按满分截断`;
    value = fullMark;
  }

  return { ok: true, score: round2(value), status: '正常', display: String(round2(value)), warning };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * 把「批次/全局设置上存的档位文本」归一到合法枚举；**不合法（含空/空白）返回 `''`**，
 * 由调用方回落下一级（批次 → 全局设置 → 代码缺省）。
 *
 * 为什么需要（2026-09-20）：舍入 / 免考 / 缺考这三个档位现在由**字典**供候选，
 * 而字典是运营可编辑的。谁把「不计入分母」改成「不计分母」，值就不再等于判据字面量：
 * `if (excusedMode === '不计入分母')` 判假 ⇒ **免考反而被算进分母**（与预期完全相反），
 * 且不报错、无日志 —— 只有期末对总评时才发现「有的批次对、有的不对」。
 *
 * 归一之后，未知值一律回落全局设置（仍是一个合理口径），至少不会算反。
 * 注意：合法值**原样返回**，因此不会改变任何现有行为。
 */
export function pickMode<T extends string>(raw: unknown, allowed: readonly T[]): T | '' {
  const v = String(raw ?? '').trim();
  return (allowed as readonly string[]).includes(v) ? (v as T) : '';
}

/** 按批次口径舍入总评 */
export function roundBy(mode: RoundMode | string | undefined, value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  switch (mode) {
    case '四舍五入':
      return Math.round(value);
    case '向上取整':
      return Math.ceil(value);
    case '向下取整':
      return Math.floor(value);
    case '保留1位小数':
      return Math.round(value * 10) / 10;
    case '不处理':
      return round2(value);
    default:
      return round2(value);
  }
}

// ─────────────────────────────────────────────────────────────
// 3. 期末总评结转
// ─────────────────────────────────────────────────────────────

/** 结转的一项（= 成绩册的 一列 × 一个学生） */
export interface TermGradeItem {
  columnId: string;
  columnName: string;
  /** 考核类型名（用于明细展示） */
  typeName: string;
  /** 科目（可空） */
  subject: string;
  /** 该列满分 */
  fullMark: number;
  /** **有效权重** = 列权重 × 类型权重（调用方算好，本函数不再乘） */
  weight: number;
  /** 得分；null = 没有值 */
  score: number | null;
  /** 单元格状态 */
  status: CellStatus;
}

export interface TermGradeDetail {
  columnId: string;
  columnName: string;
  typeName: string;
  score: number | null;
  fullMark: number;
  /** 归一化到百分制 */
  norm: number | null;
  weight: number;
  /** 对总评的贡献 = norm × weight */
  contribution: number;
  /** 是否计入分母 */
  counted: boolean;
  /** 不计入的原因 */
  skipReason?: string;
}

export interface TermGradeComputation {
  /** 总评（已按口径舍入）；没有任何参与项时为 null */
  total: number | null;
  level: string;
  levelOrder: number | null;
  /** 该等级是否标记「需关注」 */
  concern: boolean;
  attained: '达标' | '未达标' | '';
  /** 参与项数（进分母的项） */
  count: number;
  /** 权重和（进分母的项的权重和） */
  weightSum: number;
  /** 参与项中的免考数 / 缺考数（前端挂小徽标用） */
  excusedCount: number;
  absentCount: number;
  /** 逐项明细（前端悬停展示「怎么算的」） */
  details: TermGradeDetail[];
}

export interface TermGradeOptions {
  /** 等级体系（用于把总评映射成等级） */
  levels?: LevelDef[];
  /** 该生在该班的目标等级序号（越小越好）；null = 未设目标 */
  targetOrder?: number | null;
  round?: RoundMode | string;
  excused?: ExcusedMode | string;
  absent?: AbsentMode | string;
}

/**
 * 结转一个学生在一个批次（某一科目）下的期末总评。
 *
 * 口径（与 markbook.logic.weightedTotal 同源，只多「免考不进分母」一条）：
 *   1. 只有「计入总评」的类型才会出现在 items 里（调用方已过滤）
 *   2. 未录入 → 不进分母
 *   3. 免考   → 默认不进分母；批次口径设为「计0分」时按 0 进
 *   4. 缺考   → 默认按 0 分进分母；批次口径设为「不计入分母」时跳过
 *   5. 总评 = Σ(norm × w) ÷ Σw，分母只算参与项（自归一化）
 */
export function computeTermGrade(
  items: readonly TermGradeItem[],
  opts: TermGradeOptions = {},
): TermGradeComputation {
  const excusedMode: ExcusedMode = (opts.excused as ExcusedMode) ?? '不计入分母';
  const absentMode: AbsentMode = (opts.absent as AbsentMode) ?? '计0分';

  const details: TermGradeDetail[] = [];
  const participants: { score: number; weight: number }[] = [];
  let excusedCount = 0;
  let absentCount = 0;

  for (const it of items) {
    const fullMark = normFullMark(it.fullMark);
    const weight = safeWeight(it.weight);
    let counted = true;
    let skipReason: string | undefined;
    let rawScore: number | null = it.status === '缺考' ? 0 : it.score;

    if (it.status === '免考') {
      excusedCount++;
      if (excusedMode === '不计入分母') {
        counted = false;
        skipReason = '免考 · 不计入分母';
        rawScore = null;
      } else {
        rawScore = 0;
      }
    } else if (it.status === '缺考') {
      absentCount++;
      if (absentMode === '不计入分母') {
        counted = false;
        skipReason = '缺考 · 不计入分母';
        rawScore = null;
      } else {
        rawScore = 0;
      }
    } else if (rawScore == null || !Number.isFinite(rawScore)) {
      counted = false;
      skipReason = '未录入';
    }

    const norm =
      counted && rawScore != null && Number.isFinite(rawScore)
        ? round2((rawScore / fullMark) * 100)
        : null;

    details.push({
      columnId: it.columnId,
      columnName: it.columnName,
      typeName: it.typeName,
      score: rawScore,
      fullMark,
      norm,
      weight,
      contribution: norm == null ? 0 : round2(norm * weight),
      counted: counted && norm != null,
      skipReason,
    });

    if (counted && norm != null) participants.push({ score: norm, weight });
  }

  const agg = weightedTotal(participants);
  const total = roundBy(opts.round, agg.total);

  // 等级映射复用成绩册那套（pickLevel：先按分数区间，没配区间按序号等分兜底）
  const lv = total == null ? null : pickLevel(opts.levels ?? [], total);
  const att = isAttained(lv ? lv.order : null, opts.targetOrder ?? null);

  return {
    total,
    level: lv ? lv.label : '',
    levelOrder: lv ? lv.order : null,
    concern: lv ? lv.concern : false,
    attained: att === null ? '' : att ? '达标' : '未达标',
    count: agg.count,
    weightSum: agg.weightSum,
    excusedCount,
    absentCount,
    details,
  };
}

// ─────────────────────────────────────────────────────────────
// 4. 班级排名（竞赛排名法）
// ─────────────────────────────────────────────────────────────

/**
 * 竞赛排名：按总评降序，同分同名次，下一名跳号（1,2,2,4）。
 *
 * @param rows 同一范围内的记录（**只传已经是「已确认」的**，由调用方过滤）
 * @returns studentId → 名次；total 为 null 的不参与排名，返回 undefined
 */
export function rankTermGrades(
  rows: readonly { id: string; total: number | null }[],
): { ranks: Map<string, number>; total: number } {
  const valid = rows.filter((r) => r.total != null && Number.isFinite(r.total as number));
  const sorted = [...valid].sort((a, b) => (b.total as number) - (a.total as number));

  const ranks = new Map<string, number>();
  let lastTotal: number | null = null;
  let lastRank = 0;
  sorted.forEach((r, i) => {
    const t = r.total as number;
    // 同分沿用上一个名次（不取平均名次，便于「第 2 名并列」这类表达）
    const rank = lastTotal != null && t === lastTotal ? lastRank : i + 1;
    ranks.set(r.id, rank);
    lastTotal = t;
    lastRank = rank;
  });

  return { ranks, total: sorted.length };
}

// ─────────────────────────────────────────────────────────────
// 5. GPA
// ─────────────────────────────────────────────────────────────

export interface GpaEntry {
  /** 该科目的等级绩点（等级表上的「绩点」字段）；null = 未配置 */
  points: number | null;
  /** 权重（加权 GPA 用同一套有效权重） */
  weight: number;
  /** 是否计入 GPA（等级表上的「是否计入GPA」） */
  counted?: boolean;
}

export interface GpaResult {
  /** 加权 GPA；无法计算为 null */
  weighted: number | null;
  /** 不加权 GPA（各科绩点算术平均）；无法计算为 null */
  unweighted: number | null;
  /** 参与计算的科目数 */
  subjectCount: number;
  /** 有没有任何一个科目配了绩点 —— 全没配时前端应提示「未配置绩点」而不是显示空白 */
  hasAnyPoints: boolean;
}

/**
 * 计算加权 / 不加权 GPA。
 *
 * ⚠️ ACMS 不做学分制，所以加权 GPA 用的是**同一套有效权重**（列权重 × 类型权重之和），
 *    而不是 RosarioSIS 的 credit hours。这样「数学和语文的总评权重不同」也能体现。
 */
export function computeGpa(entries: readonly GpaEntry[]): GpaResult {
  const usable = entries.filter((e) => (e.counted ?? true) && e.points != null && Number.isFinite(e.points as number));
  const hasAnyPoints = entries.some((e) => e.points != null);
  if (!usable.length) {
    return { weighted: null, unweighted: null, subjectCount: 0, hasAnyPoints };
  }

  let acc = 0;
  let wsum = 0;
  let plain = 0;
  for (const e of usable) {
    const w = safeWeight(e.weight);
    acc += (e.points as number) * w;
    wsum += w;
    plain += e.points as number;
  }

  return {
    weighted: wsum > 0 ? Math.round((acc / wsum) * 100) / 100 : null,
    unweighted: Math.round((plain / usable.length) * 100) / 100,
    subjectCount: usable.length,
    hasAnyPoints,
  };
}

// ─────────────────────────────────────────────────────────────
// 6. 异常成绩审查
// ─────────────────────────────────────────────────────────────

export type AnomalyRule = 'R1 超满分' | 'R2 零分' | 'R3 离群高' | 'R4 离群低' | 'R5 突变';

export interface AnomalyThresholds {
  /** R3：高于班级均值多少倍算离群（默认 1.5） */
  highFactor: number;
  /** R4：低于班级均值多少倍算离群（默认 0.5） */
  lowFactor: number;
  /** R5：与本人历史均值偏离多少分算突变（默认 30） */
  swingScore: number;
}

export const DEFAULT_ANOMALY_THRESHOLDS: AnomalyThresholds = {
  highFactor: 1.5,
  lowFactor: 0.5,
  swingScore: 30,
};

export interface AnomalyCandidate {
  entryId: string;
  columnId: string;
  columnName: string;
  studentId: string;
  studentName: string;
  score: number | null;
  fullMark: number;
  status: CellStatus;
  /** 同列同班均值（百分制）；样本 < 2 时为 null，相关规则不触发 */
  classAvg: number | null;
  /** 该生该类型的历史均值（百分制）；无历史为 null */
  historyAvg: number | null;
}

export interface AnomalyHit {
  entryId: string;
  rule: AnomalyRule;
  message: string;
  /** 偏离量（百分制分差，带符号） */
  deviation: number | null;
}

/**
 * 扫描一条成绩，返回命中的全部规则（可能同时命中多条）。
 *
 * ⚠️ **只提示，绝不自动改分**。任何「自动修正成绩」的功能都不做 ——
 *    成绩是给家长看的正式数据，误改的代价远大于漏改。
 */
export function detectAnomalies(
  c: AnomalyCandidate,
  th: AnomalyThresholds = DEFAULT_ANOMALY_THRESHOLDS,
): AnomalyHit[] {
  const hits: AnomalyHit[] = [];
  if (c.score == null || !Number.isFinite(c.score)) return hits;

  const full = normFullMark(c.fullMark);
  const pct = round2((c.score / full) * 100);

  // R1：归一化超过 100 —— 一定是录入错误（把 8 打成 88 这类）
  if (pct > 100) {
    hits.push({
      entryId: c.entryId,
      rule: 'R1 超满分',
      message: `得分 ${c.score} 超过满分 ${fullMarkText(full)}，一定是录错了`,
      deviation: round2(pct - 100),
    });
  }

  // R2：正常状态下的 0 分 —— 多是用 0 占位代替留空
  //     （缺考状态已经被显式标记，不算异常）
  if (c.status === '正常' && c.score === 0 && full > 0) {
    hits.push({
      entryId: c.entryId,
      rule: 'R2 零分',
      message: '得 0 分且状态为「正常」，确认是真 0 分还是漏录（漏录请清空或标「缺」）',
      deviation: null,
    });
  }

  // R3 / R4：与班级均值离群
  if (c.classAvg != null && c.classAvg >= 1) {
    if (pct >= c.classAvg * th.highFactor && pct < 100) {
      hits.push({
        entryId: c.entryId,
        rule: 'R3 离群高',
        message: `比班级均值（${c.classAvg}）高出 ${round2(pct - c.classAvg)} 分，可能是小数点点错`,
        deviation: round2(pct - c.classAvg),
      });
    } else if (c.classAvg >= 60 && pct <= c.classAvg * th.lowFactor) {
      hits.push({
        entryId: c.entryId,
        rule: 'R4 离群低',
        message: `比班级均值（${c.classAvg}）低 ${round2(c.classAvg - pct)} 分`,
        deviation: round2(pct - c.classAvg),
      });
    }
  }

  // R5：与本人历史均值突变
  if (c.historyAvg != null && Math.abs(pct - c.historyAvg) >= th.swingScore) {
    const d = round2(pct - c.historyAvg);
    hits.push({
      entryId: c.entryId,
      rule: 'R5 突变',
      message: `比本人该类型历史均值（${c.historyAvg}）${d > 0 ? '高' : '低'} ${Math.abs(d)} 分，需人工判断是真波动还是录错`,
      deviation: d,
    });
  }

  return hits;
}

function fullMarkText(full: number): string {
  return Number.isInteger(full) ? String(full) : String(full);
}

// ─────────────────────────────────────────────────────────────
// 7. 批次幂等键
// ─────────────────────────────────────────────────────────────

/**
 * 结转的幂等键：批次 + 学生 + 科目。
 *
 * ⚠️ 批量结转必须可重入 —— 网络中断后重跑不能产生重复记录。
 *    服务端用这个键查已有记录：有则更新，无则新建。
 */
export function termGradeKey(batchId: string, studentId: string, subject: string): string {
  return `${batchId}__${studentId}__${subject || ''}`;
}

// ─────────────────────────────────────────────────────────────
// 8. 「学生 × 科目」行 → 学生维度清单
// ─────────────────────────────────────────────────────────────

export interface StudentRef {
  studentId: string;
  studentName: string;
  cls: string;
  /** 该生出现在几行里 = 有几科（含「未分科目」那一行） */
  subjectCount: number;
}

/**
 * 把**期末总评表的行**压成**学生维度**的清单（成绩单左侧「已有总评的学生」列表用）。
 *
 * 🔴 为什么需要它（2026-09-26 峰哥报障「已有总评的学生是重复的」）：
 *    总评表的行粒度是 **`批次 × 学生 × 科目`**（幂等键见 `termGradeKey`）——
 *    一个学生有几科就有几行。而成绩单是**学生粒度**的东西（`buildReportCard(studentId, batchId)`
 *    一次取该生全部科目），左列表直接渲染行 ⇒ 同一个学生出现 N 次（生产实测：2 个学生 6 行，
 *    每个学生各 3 次：数学 / 英语 / 未分科目）。
 *
 * 规则（刻意简单，避免引入第二个真源）：
 *   - 按 `studentId` 去重，**保持首次出现的顺序**（调用方的 rows 已按名次排好序，别打乱）；
 *   - `subjectCount` = 该生出现在几行里；
 *   - 姓名/班级取**第一个非空值**（防御历史脏行：某行姓名没写全时不至于整条丢名字）；
 *   - `studentId` 为空的行**丢弃**（无法定位学生，点开也取不到成绩单）。
 */
export function studentsFromRows(
  rows: readonly { studentId: string; studentName: string; cls: string }[],
): StudentRef[] {
  const out: StudentRef[] = [];
  const idx = new Map<string, number>();
  for (const r of rows) {
    const id = String(r.studentId ?? '').trim();
    if (!id) continue;
    const hit = idx.get(id);
    if (hit === undefined) {
      idx.set(id, out.length);
      out.push({
        studentId: id,
        studentName: String(r.studentName ?? ''),
        cls: String(r.cls ?? ''),
        subjectCount: 1,
      });
      continue;
    }
    const cur = out[hit]!;
    cur.subjectCount += 1;
    if (!cur.studentName && r.studentName) cur.studentName = String(r.studentName);
    if (!cur.cls && r.cls) cur.cls = String(r.cls);
  }
  return out;
}

/**
 * 「某科目在总评表里有多少行」的计数器（成绩单 / 批量评语的科目下拉标注用）。
 *
 * 🔴 为什么需要它（2026-09-26 峰哥报障「用科目筛选之后没数据了」）：
 *    科目下拉的候选来自**成绩册的列**（那个班在批次同期有哪些科目），
 *    而列表数据来自**期末总评表**。两者不同源 ⇒ 下拉里会出现「有列但还没结转出总评」的科目
 *    （生产实测：「生物学」在成绩册里有 1 列，但总评表里 0 行），选中它自然是空列表，
 *    而界面上只有一句「暂无总评」，用户看不出是"没结转"还是"坏了"。
 *    有了这个计数，下拉就能提前标注「暂无总评」，空态也能说清下一步。
 *
 * @param rows    期末总评表的行（只需 科目 字段）
 * @param subjectOf 取「科目」字段的函数；空值统一归到 `noneKey`
 */
export function countGradesBySubject(
  rows: readonly Record<string, unknown>[],
  subjectOf: (row: Record<string, unknown>) => string,
  noneKey: string,
): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) {
    const s = subjectOf(r) || noneKey;
    m.set(s, (m.get(s) ?? 0) + 1);
  }
  return m;
}

