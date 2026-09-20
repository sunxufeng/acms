/**
 * 成绩册列的口径（**前后端共用**）。
 *
 * 🔴 为什么放在 contracts 而不是 apps/api：新建考核列时前端要**预览**「将创建哪几列」，
 * 而预览规则必须与后端真正建列的规则是**同一份代码**。前端复制一遍必然漂移
 * （比如前端去重、后端不去重 ⇒ 预览 3 列、实际建出 4 列），而且两边都不报错。
 * 所以规则只写在这里，server 与 web 都从这里 import。
 */

/** 学期里表示「整个学年都适用」的那个取值（字典「教学学期」的第三项） */
export const TERM_WHOLE_YEAR = '全学年';

/** 页面上的「学年 / 学期」筛选条件（空串 = 不限） */
export interface TermSelection {
  year?: string;
  term?: string;
}

/** 一次「多科目建列」展开出来的单列草稿 */
export interface SubjectColumnDraft {
  /** 列名称（多科目时自动加「 · 科目」后缀，便于在列编辑器/列表里分辨） */
  name: string;
  /** 科目（空串 = 未指定） */
  subject: string;
  /** 排序（同一批连号 ⇒ 保证它们在网格里相邻） */
  sort: number;
}

/**
 * 把「一次建多个科目的列」展开成 N 条单列草稿。
 *
 * 规则（每一条都有理由，别随手改）：
 * 1. **勾 N 个科目 = N 列**，一列一个科目 —— 期末总评的幂等键是「批次 + 学生 + 科目」，
 *    一列挂多个科目就拆不出科目、权重也没法按科目区分。
 * 2. 科目去重、trim；**空串保留且只保留一个**（表示「未指定」，结转归「未填科目」组）。
 * 3. **≥2 个科目才加后缀** `名 · 科目`：单个科目时用户自己写的名字（如「期末语文」）已够清楚，
 *    硬加后缀反而变成「期末语文 · 语文」。空科目那一列永远不加后缀。
 * 4. 排序**连号**（base + 序号）⇒ 同批创建的列相邻，横着填分不会串到别的考试去。
 * 5. 一个科目都没传 ⇒ 退化成 1 列「未指定」（与不选科目等价，不报错）。
 */
export function subjectColumnDrafts(input: {
  name: string;
  subjects?: string[];
  sort?: number;
}): SubjectColumnDraft[] {
  const base = String(input.name ?? '').trim();
  const baseSort = Number(input.sort) || 0;
  const seen = new Set<string>();
  const subjects: string[] = [];
  for (const raw of Array.isArray(input.subjects) ? input.subjects : []) {
    const v = String(raw ?? '').trim();
    if (seen.has(v)) continue;
    seen.add(v);
    subjects.push(v);
  }
  if (!subjects.length) subjects.push('');
  const suffix = subjects.length >= 2;
  return subjects.map((subject, i) => ({
    name: suffix && subject ? `${base} · ${subject}` : base,
    subject,
    sort: baseSort + i,
  }));
}

/**
 * 这一列在当前「学年 + 学期」筛选下要不要显示。
 *
 * 四条口径，缺一个都会出问题：
 * 1. 页面**没选**学年学期 ⇒ 全给（老链接/收藏不带参数时行为与以前一致）。
 * 2. 列**没归属**（历史列）⇒ **始终显示**。否则一加上筛选，老数据立刻「消失」，
 *    而且期末结转也会跟着少算（这是最贵的一类静默错误）。
 * 3. 学年不同 ⇒ 排除；学年仅一侧有值 ⇒ 不因此排除（宁可多显示，不可漏）。
 * 4. 学期不同 ⇒ 排除；但列的学期是「全学年」⇒ 该学年的任何学期都算它。
 */
export function columnInTerm(col: { year?: string; term?: string }, sel: TermSelection): boolean {
  const cy = String(col.year ?? '').trim();
  const ct = String(col.term ?? '').trim();
  const sy = String(sel?.year ?? '').trim();
  const st = String(sel?.term ?? '').trim();
  if (!sy && !st) return true;
  if (!cy && !ct) return true;
  if (sy && cy && cy !== sy) return false;
  if (st && ct && ct !== st && ct !== TERM_WHOLE_YEAR) return false;
  return true;
}

/** 这一列是否「未归属学年学期」（界面要标出来，让人知道它为什么在任何学期都出现） */
export function isUnassignedTerm(col: { year?: string; term?: string }): boolean {
  return !String(col?.year ?? '').trim() && !String(col?.term ?? '').trim();
}

/**
 * 按「今天」推断默认的学年 / 学期（页面首次打开时的默认值）。
 *
 * 学年口径：8 月起算作新学年（8 月是秋季学期准备期），1–7 月仍属上一学年
 *   ⇒ 2026-09-20 → 2026学年；2027-03-01 → 2026学年。
 * 学期口径：2–7 月 = 第二学期，其余（8、9…12、1 月）= 第一学期。
 * ⚠️ 只用本地时间（`new Date()` 的 getMonth/getFullYear），**别用 toISOString** ——
 * UTC 会让东八区晚间的日期差一天（只在夜里复现的那种 bug）。
 */
export function defaultTermOf(today: Date): { year: string; term: string } {
  const m = today.getMonth() + 1;
  const y = today.getFullYear();
  const academicStart = m >= 8 ? y : y - 1;
  return { year: `${academicStart}学年`, term: m >= 2 && m <= 7 ? '第二学期' : '第一学期' };
}
