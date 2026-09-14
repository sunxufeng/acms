/**
 * 作业 ↔ 成绩册联动 —— **零依赖纯函数**（口径唯一真源）。
 *
 * ⚠️ 为什么单独一个文件（对照 acms-new-sql-module 技能的「坑 5：同一判据不要写两遍」）：
 * 「哪一格该写什么分、哪些格留空、哪些格跳过」这套判据在**预览**与**写入**两处都要用，
 * 写成两份必然漂移 —— 预览显示「将填 2 格」而实际写了 3 格，是最难解释的一类不一致。
 * 所以 preview 与 sync 共用本文件的 `planHomeworkSync()`，预览即所见。
 *
 * ── 三条口径（与 Gibbon 的 Markbook × Homework 对齐）────────────────────
 *
 * 1. **未完成 / 无提交 ⇒ 留空，绝不写 0**。
 *    成绩册的加权总评是**自归一化**的（分母 = 实际参与项的权重和，见 markbook.logic.ts），
 *    留空 = 这一格不参与汇总 = 「本次未参与」；写 0 = 「参与了但得 0 分」，
 *    会把总评实打实拉低。两者语义完全不同，不能混。
 *
 * 2. **得分折算**：优先用提交记录里的分数，没有分数才按「完成即满分」折算。
 *    提交记录里那个数字不一定是真分数（未批改时表单默认值常是 0），
 *    所以 0 分只在「提交状态 = 已批改」时才当成真实分数接受，否则退回满分。
 *
 * 3. **列 ↔ 作业的绑定**：存成列上的 `关联作业` 字段（值 = 作业名称）。
 *    不新建表、不写死 id：作业在 ACMS 里就是靠「作业名称 + 教学班」自然键标识的
 *    （homeworkTracker / homeworkSubmission 都没有作业主表），跟着它走最不容易错位。
 */

import { DEFAULT_FULL_MARK, textOf } from './markbook.logic.js';

// ── 字段名常量（飞书列名即数据键，不译）──────────────────────────────────

/** 成绩册列上的绑定字段：值 = 作业名称 */
export const HOMEWORK_BIND_FIELD = '关联作业';
/** 作业侧的自然键字段 */
export const HOMEWORK_NAME_FIELD = '作业名称';
/** 完成追踪的完成标记 */
export const TRACKER_DONE_FIELD = '是否完成';
/** 提交记录的候选分数列（历史/人工录入的表字段名不统一，逐个试） */
export const SUBMISSION_SCORE_FIELDS = ['得分', '分数', '成绩'] as const;
/** 提交状态里表示「分数已定稿」的值 */
export const SUBMISSION_GRADED_STATUS = '已批改';

/** 同步模式：只填空格（默认）／覆盖已有值 */
export type SyncMode = 'fill-empty' | 'overwrite';

/**
 * 预览 / 写入原因。**既是给用户看的说明，也是前端判色的依据**，
 * 前端按这个值取 i18n 文案（见 HomeworkSyncPanel 的 REASON_KEY），不要直接显示中文原文。
 */
export type SyncReason = '已完成' | '未完成留空' | '无提交' | '已存在将跳过';

/** 数值安全取值（与 curriculum.logic.ts 的 numOf 同义，这里不引它以免跨模块耦合） */
export function numOf(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = Number(String(v ?? '').trim());
  return Number.isFinite(n) ? n : 0;
}

/** 可选分数取值：取不到返回 null（区别于「真的是 0 分」） */
export function optNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 完成标记判定。兼容 `'是' / '已完成' / true / 1`（换表单形态不会静默失效）。
 * 空值 / 其他值 → false。
 */
export function isDone(v: unknown): boolean {
  if (v === true) return true;
  if (v === false || v === null || v === undefined) return false;
  const s = textOf(v);
  if (!s) return false;
  if (s === '是' || s === '已完成' || s === '完成') return true;
  const n = Number(s);
  return Number.isFinite(n) && n > 0;
}

/** 满分兜底：`markbookColumn.满分` 缺失/非正数时按 100（与 markbook.logic 同源） */
export function safeFullMark(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_FULL_MARK;
}

/**
 * 得分折算（唯一实现，preview 与 sync 共用）。
 *
 * 优先级：
 *   1. 提交记录里有「已批改」的分数 → 用分数（超满分按满分截断，避免百分制 > 100 打乱等级区间）
 *   2. 提交记录里有正数分 → 用分数（同样截断）
 *   3. 其余（无提交记录 / 无分数列 / 分数为 0 且未批改）→ **完成即满分**
 */
export function foldScore(
  submissionScore: number | null,
  submissionStatus: string,
  fullMark: unknown,
): { score: number; source: 'submission' | 'full-mark'; clamped: boolean } {
  const fm = safeFullMark(fullMark);
  if (submissionScore != null && Number.isFinite(submissionScore)) {
    const gradedZero = submissionScore === 0 && textOf(submissionStatus) === SUBMISSION_GRADED_STATUS;
    if (submissionScore > 0 || gradedZero) {
      const score = Math.min(fm, Math.max(0, submissionScore));
      return { score, source: 'submission', clamped: score !== submissionScore };
    }
  }
  return { score: fm, source: 'full-mark', clamped: false };
}

// ── 计划器 ────────────────────────────────────────────────────────────

export interface PlanStudent {
  id: string;
  name: string;
}

/** 该班该作业的一条完成追踪行（已归一） */
export interface PlanTracker {
  studentId: string;
  done: boolean;
}

/** 该班该作业的一条提交记录（已归一，同学生只留最新一版） */
export interface PlanSubmission {
  studentId: string;
  score: number | null;
  status: string;
  late: string;
  version: number;
}

/** 成绩册里**已存在**的条目（用来判断「空格 / 已有值」，以及覆盖时的额外字段） */
export interface PlanExisting {
  score: number | null;
  comment: string;
  visibleStudent: string;
  visibleParent: string;
}

export interface PlanInput {
  students: PlanStudent[];
  trackers: Map<string, PlanTracker>;
  submissions: Map<string, PlanSubmission>;
  existing: Map<string, PlanExisting>;
  fullMark: unknown;
  mode: SyncMode;
}

export interface PlanRow {
  studentId: string;
  studentName: string;
  /** 成绩册里的当前值（格子为空 = null，与「已有值」区分开） */
  current: number | null;
  /** 计划写入的值；null = 不写（留空） */
  next: number | null;
  reason: SyncReason;
  /** 分数来源：submission（提交记录的分数）/ full-mark（完成即满分）/ ''（不写） */
  source: 'submission' | 'full-mark' | '';
  /** 是否真的会发写请求 */
  willWrite: boolean;
  /** 该格已有值、本次将覆盖 */
  willOverwrite: boolean;
  /**
   * 该格已有值、本次将**清空**（只在 overwrite 模式下、且该生未完成时出现）。
   * 语义：overwrite = 让这一列如实反映作业状态，所以遗留的分数要清掉，
   * 否则「未完成」的学生身上挂着上一次的分，总评是错的。
   */
  willClear: boolean;
  /** 提交记录的迟交标记，仅作展示 */
  late: string;
  /** 提交记录里为什么用/不用那个分数，给用户交代 */
  note: '' | 'clamped' | 'zero-not-graded';
}

/** 每个学生在同一作业下可能有多版提交，取版本号最大的一版（同版本取后写的） */
export function latestSubmissions(rows: PlanSubmission[]): Map<string, PlanSubmission> {
  const out = new Map<string, PlanSubmission>();
  for (const r of rows) {
    const prev = out.get(r.studentId);
    if (!prev || r.version >= prev.version) out.set(r.studentId, r);
  }
  return out;
}

/**
 * 生成整列的写入计划。**preview 与 sync 都调它**，所以「预览到的一格」=「写入的一格」。
 *
 * 判定顺序（与 SyncReason 一一对应）：
 *   - 追踪表标记已完成            → `已完成`，分 = foldScore(...)
 *   - 无追踪行但有提交记录        → `已完成`（提交即完成），分 = foldScore(...)
 *   - 追踪行明确未完成            → `未完成留空`，不写
 *   - 追踪与提交都没有            → `无提交`，不写
 *   - 该格已有值且 mode=fill-empty→ `已存在将跳过`，不写
 *   - 该格已有值且 mode=overwrite → `已完成` 且 willOverwrite=true（未完成的格则 willClear=true）
 */
export function planHomeworkSync(input: PlanInput): PlanRow[] {
  const fm = safeFullMark(input.fullMark);
  const rows: PlanRow[] = [];

  for (const s of input.students) {
    const ex = input.existing.get(s.id);
    const current = ex?.score ?? null;
    const tracker = input.trackers.get(s.id);
    const sub = input.submissions.get(s.id);

    let next: number | null = null;
    let reason: SyncReason;
    let source: 'submission' | 'full-mark' | '' = '';
    let note: PlanRow['note'] = '';

    if (tracker?.done === true || (!tracker && sub)) {
      // 追踪表说完成了，或者没有追踪行但确实交了作业 → 都算完成
      const folded = foldScore(sub?.score ?? null, sub?.status ?? '', fm);
      next = folded.score;
      source = folded.source;
      reason = '已完成';
      if (folded.clamped) note = 'clamped';
      else if (sub && sub.score === 0 && folded.source === 'full-mark') note = 'zero-not-graded';
    } else if (tracker) {
      reason = '未完成留空';
    } else {
      reason = '无提交';
    }

    let willWrite = next != null;
    let willOverwrite = false;
    let willClear = false;

    if (willWrite && current != null) {
      if (input.mode === 'fill-empty') {
        // 默认模式：只补空格，已经录过的（不管是手工录的还是上次同步的）一概不动
        next = current;
        willWrite = false;
        source = '';
        note = '';
        reason = '已存在将跳过';
      } else {
        willOverwrite = true;
      }
    }
    if (!willWrite && current != null && input.mode === 'overwrite' && reason === '未完成留空') {
      // overwrite 语义 = 让这一列如实反映作业状态 → 该生未完成时清掉遗留分数
      willClear = true;
    }

    rows.push({
      studentId: s.id,
      studentName: s.name,
      current,
      next,
      reason,
      source: willWrite ? source : '',
      willWrite,
      willOverwrite,
      willClear,
      late: sub?.late ?? '',
      note,
    });
  }

  return rows;
}

/** 计划 → 计数（预览与写入结果共用同一套数字口径） */
export function summarizePlan(rows: PlanRow[]): {
  scanned: number;
  filled: number;
  overwritten: number;
  cleared: number;
  skipped: number;
  blank: number;
} {
  let filled = 0;
  let overwritten = 0;
  let cleared = 0;
  let skipped = 0;
  let blank = 0;
  for (const r of rows) {
    if (r.willClear) cleared++;
    else if (r.willOverwrite) overwritten++;
    else if (r.willWrite) filled++;
    else if (r.reason === '已存在将跳过') skipped++;
    else blank++; // 未完成 / 无提交：不写入，也不计入"跳过"
  }
  return { scanned: rows.length, filled, overwritten, cleared, skipped, blank };
}

/** 完成率（0~1，四位小数）。分母 = 该班名单人数（与 sync 的 scanned 同源，避免两个比率对不上） */
export function completionRate(done: number, total: number): number {
  if (!total) return 0;
  return Math.round((done / total) * 10000) / 10000;
}

/** 作业名称归一（去首尾空格；全角空格也清掉，避免肉眼一样的名字绑不上） */
export function normHomeworkName(v: unknown): string {
  return textOf(v).replace(/\u3000/g, ' ').trim();
}
