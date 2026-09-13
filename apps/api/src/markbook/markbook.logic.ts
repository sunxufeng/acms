/**
 * 成绩册的加权汇总、等级映射与达标判定 —— **零依赖纯函数**。
 *
 * ⚠️ 为什么单独一个文件：这套口径在「实时计算网格」「保存条目时写快照」
 * 「重算历史条目」三处都要用。写成两份必然漂移（出现「网格显示 A、条目快照却是 B」），
 * 所以集中在这里，任何一处改口径都只改这一个文件。
 *
 * 口径对照（参照 GibbonEdu/core 的 Markbook）：
 * 1. **两层权重**：列权重 × 类型权重。两者都允许缺省（缺省 = 1）。
 * 2. **汇总分母 = 实际参与项的权重和**（自归一化），不要求各类型权重合计 100。
 *    只录了部分考核时，这样算出来的才是「已录部分的表现」，而不是被没录的项拉低。
 * 3. **分数先归一化到百分制**再加权（列上「满分」不同也能混算）。
 * 4. **达标判定用等级序号，不是分数**：序号越小越好（1 = 最好），
 *    所以「达标 = 实际序号 ≤ 目标序号」—— 与「分数 ≥ 及格线」的直觉相反，前端必须写清。
 */

export interface ColumnDef {
  id: string;
  name: string;
  /** 考核类型（与类型权重表按「类型」匹配） */
  type: string;
  /** 列权重 */
  weight: number;
  /** 满分 */
  fullMark: number;
  /** 等级体系 id（可空：空则用默认体系） */
  scaleId: string;
}

export interface LevelDef {
  id: string;
  scaleId: string;
  /** 显示值，如 A / 优秀 / 90 */
  label: string;
  /** 序号：越小越好（1 = 最好） */
  order: number;
  /** 分数区间（可空；空则按序号等分兜底） */
  min: number | null;
  max: number | null;
  /** 关注标记：落在该等级要不要提示关注 */
  concern: boolean;
}

export interface EntryValue {
  columnId: string;
  studentId: string;
  /** 原始得分（按列的满分制）；null = 未录入 */
  score: number | null;
}

export const DEFAULT_FULL_MARK = 100;

/** 权重兜底：非正数一律当 1（权重为 0 会让分母归零、总评变成无意义） */
export function safeWeight(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** 两层权重相乘 */
export function effectiveWeight(columnWeight: unknown, typeWeight: unknown): number {
  return safeWeight(columnWeight) * safeWeight(typeWeight);
}

/** 得分 → 百分制（保留 2 位）。满分缺失/非正数一律按 100 处理 */
export function normScore(score: number, fullMark: unknown): number {
  const f = Number(fullMark);
  const mk = Number.isFinite(f) && f > 0 ? f : DEFAULT_FULL_MARK;
  return Math.round((score / mk) * 10000) / 100;
}

/**
 * 加权汇总（自归一化）。
 * @param items 已归一化到百分制的分数 + 该列的有效权重（只传有值的项）
 */
export function weightedTotal(items: { score: number; weight: number }[]): {
  total: number | null;
  weightSum: number;
  count: number;
} {
  let acc = 0;
  let wsum = 0;
  let n = 0;
  for (const it of items) {
    if (!Number.isFinite(it.score)) continue;
    const w = safeWeight(it.weight);
    acc += it.score * w;
    wsum += w;
    n++;
  }
  if (!wsum) return { total: null, weightSum: 0, count: n };
  return { total: Math.round((acc / wsum) * 100) / 100, weightSum: Math.round(wsum * 100) / 100, count: n };
}

/**
 * 按百分制分数在等级体系里找等级。
 * 优先用等级自身配的分数区间；没有配区间时按序号等分兜底
 * （序号越小越好 ⇒ 分数越高，所以按 (100 - 分数) 定位）。
 */
export function pickLevel(levels: LevelDef[], score: number | null | undefined): LevelDef | null {
  if (score == null || !Number.isFinite(score) || !levels.length) return null;
  const withRange = levels.filter((l) => l.min != null || l.max != null);
  if (withRange.length) {
    const hit = withRange.find((l) => score >= (l.min ?? -Infinity) && score <= (l.max ?? Infinity));
    if (hit) return hit;
  }
  const sorted = [...levels].sort((a, b) => a.order - b.order);
  const step = 100 / sorted.length;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((100 - score) / step)));
  return sorted[idx] ?? null;
}

/**
 * 达标判定。
 * @returns true 达标 / false 未达标 / null 无法判定（缺目标或没成绩）
 */
export function isAttained(actualOrder: number | null | undefined, targetOrder: number | null | undefined): boolean | null {
  if (actualOrder == null || targetOrder == null) return null;
  if (!Number.isFinite(Number(actualOrder)) || !Number.isFinite(Number(targetOrder))) return null;
  // 序号越小越好 → 实际序号 ≤ 目标序号才算达标
  return Number(actualOrder) <= Number(targetOrder);
}

/** 班级名归一化（学生档案的「当前班级」与列上的「班级」必须按同一口径比对） */
export function normClass(v: unknown): string {
  return String(v ?? '').trim();
}

/** 条目快照：保存条目时把等级写死在条目上，等级改名不篡改历史 */
export interface EntrySnapshot {
  level: string;
  levelOrder: number | null;
  levelConcern: boolean;
  attained: string;
}

export function snapshotOf(
  levels: LevelDef[],
  normedScore: number | null,
  targetOrder: number | null,
): EntrySnapshot {
  const lv = pickLevel(levels, normedScore);
  const att = isAttained(lv ? lv.order : null, targetOrder);
  return {
    level: lv ? lv.label : '',
    levelOrder: lv ? lv.order : null,
    levelConcern: lv ? lv.concern : false,
    attained: att === null ? '' : att ? '达标' : '未达标',
  };
}
