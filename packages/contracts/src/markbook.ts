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

// ── 「按学科分行」视图的列归并（2026-09-23）──────────────────────────────────
//
// 背景：`subjectColumnDrafts` 在「一次勾多个科目」时会把列名拼成「日常 · 数学」，
// 于是**一个考核项落成 N 条独立列记录**（N = 勾选的科目数）。
//
// 横排 / 按学科分列两个视图**需要**这 N 列 —— 它们靠列头区分科目。
// 但「按学科分行」视图里科目已经写在行上，表头再出现「日常 · 数学 / 日常 · 英语 /
// 日常 · 生物学」三列就错了：每行只有斜对角那一格能填，另外两格永远是空的
// （2026-09-22 生产截图确认）。⇒ 该视图必须先把同基础名的列归并成 1 列，
// 由**行上的科目**决定取哪一条列记录。

/** 去掉列名末尾的「 · 科目」后缀（即 `subjectColumnDrafts` 拼上去的那一段） */
export function columnBaseName(name: string, subject: string): string {
  const n = String(name ?? '').trim();
  const s = String(subject ?? '').trim();
  if (!s || !n) return n;
  const suffix = ` · ${s}`;
  if (!n.endsWith(suffix)) return n;
  // 列名恰好只剩后缀（基础名为空）时不动它，否则会造出一个空列头
  return n.slice(0, n.length - suffix.length).trim() || n;
}

/** 归并后的一列（对应表头一个单元格） */
export interface MergedColumnGroup<T> {
  /** 表头要显示的名字（= 基础名；撞名降级时是原列名） */
  base: string;
  /** 科目 → 列（'' = 未指定科目）。渲染每个学科行时由行上的科目来这里取记录 */
  bySubject: Map<string, T>;
  /** 组内全部列（顺序与入参一致） */
  cols: T[];
}

/**
 * 把「同一考核类型下」的列按基础名归并（供「按学科分行」视图使用）。
 *
 * 🔴 撞名保护：同一个 (基础名, 科目) 出现 **多条**时不归并 —— 宁可多一列，
 *    也不能把另一条吃掉（吃掉 = 那一列的成绩在视图里彻底看不见，且全程不报错）。
 *    判定为撞名的那几条各自独立成组，`base` 用原列名。
 *
 * 返回顺序 = 入参顺序（即服务端按 `sort` 排好的列顺序），不会因为归并把列挪位。
 */
export function mergeColumnsByBaseName<T extends { id: string; name: string; subject?: string }>(
  cols: readonly T[],
): MergedColumnGroup<T>[] {
  const list = Array.isArray(cols) ? cols : [];
  const subjectOf = (c: T) => String(c?.subject ?? '').trim();

  const seen = new Map<string, number>();
  const dupKeys = new Set<string>();
  for (const c of list) {
    const k = `${columnBaseName(c.name, subjectOf(c))}\u0000${subjectOf(c)}`;
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    if (n > 1) dupKeys.add(k);
  }

  const out: MergedColumnGroup<T>[] = [];
  const index = new Map<string, MergedColumnGroup<T>>();
  for (const c of list) {
    const sub = subjectOf(c);
    const base = columnBaseName(c.name, sub);
    const isDup = dupKeys.has(`${base}\u0000${sub}`);
    const key = isDup ? `dup\u0000${c.id}` : `g\u0000${base}`;
    let g = index.get(key);
    if (!g) {
      g = { base: isDup ? String(c.name ?? '').trim() : base, bySubject: new Map(), cols: [] };
      index.set(key, g);
      out.push(g);
    }
    g.cols.push(c);
    if (!g.bySubject.has(sub)) g.bySubject.set(sub, c);
  }
  return out;
}

/** 归并列表头的「权重 · 满分」提示数据（文案由调用方拼，这里只算事实） */
export interface MergedWeightFull {
  /** 组内各列的 (权重, 满分) 是否完全一致 —— 一致才敢在表头写一个具体数值 */
  same: boolean;
  /** 一致时的取值（不一致时给第一条，仅作兜底） */
  weight: number;
  fullMark: number;
  /** 按科目列出（顺序与组内列一致；科目空串 = 未指定） */
  items: { subject: string; weight: number; fullMark: number }[];
}

/**
 * 归并后一列对应多条列记录，权重/满分就可能**按科目不同**。
 * 表头只写得下一个值 ⇒ 一致时写具体值、不一致时写「按学科不同」并用悬停列出全部。
 * （硬写第一条的数值是错的：老师会以为整列都是那个满分。）
 */
export function mergedWeightFull<T extends { subject?: string; weight?: number; fullMark?: number }>(
  cols: readonly T[],
): MergedWeightFull {
  const num = (v: unknown, d: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  const items = (Array.isArray(cols) ? cols : []).map((c) => ({
    subject: String(c?.subject ?? '').trim(),
    weight: num(c?.weight, 1),
    fullMark: num(c?.fullMark, 100),
  }));
  const first = items[0] ?? { subject: '', weight: 1, fullMark: 100 };
  const same = items.every((i) => i.weight === first.weight && i.fullMark === first.fullMark);
  return { same, weight: first.weight, fullMark: first.fullMark, items };
}
