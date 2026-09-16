/**
 * 成绩类报表的**纯函数**（零依赖，不 import Nest / DB）。
 *
 * 为什么单独一个文件：报表口径是最容易被质疑的东西（「这个平均分怎么算的」），
 * 把它做成纯函数就能**拿生产数据离线跑一遍再上线**，改口径也不会牵动 service。
 * 与 `attendance-rate.ts` / `contact-dedup.ts` 同一约定。
 */

/** 报表只需要这几个字段，不依赖期末总评表的完整结构 */
export interface TermGradeLike {
  studentId: string;
  studentName: string;
  cls: string;
  subject: string;
  total: number | null;
  level: string;
  levelOrder: number | null;
  /** 达标 / 未达标 / 未设目标 */
  attained: string;
  weightedGpa: number | null;
  unweightedGpa: number | null;
  /** 参与项数（进了总评分母的考核个数） */
  count: number;
}

/**
 * 分数段。用「下界 ≤ x < 上界」判定，避免边界被算两次（90 分只进第一段）。
 * 标签是给人看的，顺序即显示顺序（从高到低）。
 */
export const SCORE_BANDS: { label: string; min: number; max: number }[] = [
  { label: '90 分以上', min: 90, max: Infinity },
  { label: '80–89 分', min: 80, max: 90 },
  { label: '70–79 分', min: 70, max: 80 },
  { label: '60–69 分', min: 60, max: 70 },
  { label: '60 分以下', min: -Infinity, max: 60 },
];

/** 总评落在哪一段（不在任何段内返回空串，调用方忽略） */
export function bandOf(total: number): string {
  for (const b of SCORE_BANDS) if (total >= b.min && total < b.max) return b.label;
  return '';
}

/** 分数段分布；空数组返回全 0（页面照样渲染出 5 个空段，避免"没数据"看起来像坏了） */
export function computeBands(totals: number[]): { label: string; count: number }[] {
  const map = new Map<string, number>();
  for (const b of SCORE_BANDS) map.set(b.label, 0);
  for (const t of totals) {
    const lab = bandOf(t);
    if (lab) map.set(lab, (map.get(lab) ?? 0) + 1);
  }
  return SCORE_BANDS.map((b) => ({ label: b.label, count: map.get(b.label) ?? 0 }));
}

/** 平均值（保留 1 位小数）；空数组返回 null（**不要返回 0** —— 0 分和"没数据"是两件事） */
export function mean(values: number[]): number | null {
  if (!values.length) return null;
  const s = values.reduce((a, b) => a + b, 0);
  return Math.round((s / values.length) * 10) / 10;
}

/** 分位数（线性插值）。用于中位数与「前 25%」这类口径。 */
export function quantile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const idx = (s.length - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const v = lo === hi ? (s[lo] ?? 0) : (s[lo] ?? 0) + ((s[hi] ?? 0) - (s[lo] ?? 0)) * (idx - lo);
  return Math.round(v * 10) / 10;
}

/**
 * 竞赛排名法：按值降序，**同值同名次、下一名跳号**（1,1,3 而不是 1,1,2）。
 *
 * 与期末总评里的排名口径保持一致 —— 同一份成绩在不同页面显示不同名次是最难解释的 bug。
 * `valueOf` 返回 null 表示该项不参与排名（如没有 GPA），对应名次也是 null。
 */
export function competitionRanks<T>(rows: T[], valueOf: (r: T) => number | null): (number | null)[] {
  const indexed = rows.map((r, i) => ({ i, v: valueOf(r) }));
  const rankable = indexed.filter((x) => x.v != null) as { i: number; v: number }[];
  rankable.sort((a, b) => b.v - a.v);
  const out: (number | null)[] = rows.map(() => null);
  let lastValue: number | null = null;
  let lastRank = 0;
  rankable.forEach((x, idx) => {
    const rank = lastValue != null && x.v === lastValue ? lastRank : idx + 1;
    out[x.i] = rank;
    lastValue = x.v;
    lastRank = rank;
  });
  return out;
}

/** GPA 分段（4.0 制；未配绩点时不调用本函数） */
export const GPA_BANDS: { label: string; min: number }[] = [
  { label: '3.5 以上', min: 3.5 },
  { label: '3.0–3.5', min: 3.0 },
  { label: '2.5–3.0', min: 2.5 },
  { label: '2.0–2.5', min: 2.0 },
  { label: '2.0 以下', min: -Infinity },
];

export function gpaBands(gpas: number[]): { label: string; count: number }[] {
  const map = new Map<string, number>();
  for (const b of GPA_BANDS) map.set(b.label, 0);
  for (const g of gpas) {
    for (const b of GPA_BANDS) {
      if (g >= b.min) {
        map.set(b.label, (map.get(b.label) ?? 0) + 1);
        break;
      }
    }
  }
  return GPA_BANDS.map((b) => ({ label: b.label, count: map.get(b.label) ?? 0 }));
}

/**
 * 把「学生 × 批次 × 科目」的期末总评行，聚合成「学生一行」。
 *
 * 用在 GPA 与排名报表：一个学生一个批次下有多条（每个科目一条），
 * 排名要按学生而不是按科目录 —— 否则同一个学生会占据前 4 名。
 *
 * 口径：
 *  - `weightedGpa` 取**各科平均**（科目等权，不再按学分加权 —— ACMS 不做学分制）
 *  - 若某科没配绩点（null），该科**不进 GPA 平均**，但会计入 `subjectCount`
 *  - 全部科目都没配绩点 ⇒ 该生 GPA 为 null（页面显示「未配置绩点」而不是 0.00）
 */
export interface StudentGpaRow {
  studentId: string;
  studentName: string;
  cls: string;
  subjectCount: number;
  /** 参与 GPA 平均的科目数（配了绩点的那些） */
  gpaSubjectCount: number;
  weightedGpa: number | null;
  unweightedGpa: number | null;
  avgTotal: number | null;
  level: string;
  levelOrder: number | null;
  attainedCount: number;
  /** 参与平均的科目名（悬停明细用） */
  subjects: string;
}

export function aggregateByStudent(rows: TermGradeLike[]): StudentGpaRow[] {
  const byStudent = new Map<string, TermGradeLike[]>();
  for (const r of rows) {
    const arr = byStudent.get(r.studentId);
    if (arr) arr.push(r);
    else byStudent.set(r.studentId, [r]);
  }
  const out: StudentGpaRow[] = [];
  for (const [studentId, list] of byStudent) {
    const first = list[0];
    if (!first) continue;
    const totals = list.map((x) => x.total).filter((t): t is number => t != null);
    const wg = list.map((x) => x.weightedGpa).filter((t): t is number => t != null);
    const ug = list.map((x) => x.unweightedGpa).filter((t): t is number => t != null);
    // 等级取「最好的一条」（序号越小越好）作为该生在本批次的代表等级
    const best = list
      .filter((x) => x.levelOrder != null)
      .sort((a, b) => (a.levelOrder ?? 99) - (b.levelOrder ?? 99))[0];
    out.push({
      studentId,
      studentName: first.studentName,
      cls: first.cls,
      subjectCount: list.length,
      gpaSubjectCount: wg.length,
      weightedGpa: wg.length ? Math.round((wg.reduce((a, b) => a + b, 0) / wg.length) * 100) / 100 : null,
      unweightedGpa: ug.length ? Math.round((ug.reduce((a, b) => a + b, 0) / ug.length) * 100) / 100 : null,
      avgTotal: mean(totals),
      level: best?.level ?? '',
      levelOrder: best?.levelOrder ?? null,
      attainedCount: list.filter((x) => x.attained === '达标').length,
      subjects: list.map((x) => x.subject).join('、'),
    });
  }
  out.sort((a, b) => a.studentName.localeCompare(b.studentName, 'zh-CN'));
  return out;
}
