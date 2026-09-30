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

// ─────────────────────────────────────────────────────────────
// 成绩册：模板导出 + 成绩导入（2026-09-30 峰哥需求）
// ─────────────────────────────────────────────────────────────

/**
 * 通用 CSV 解析（**全站只此一份**）。
 *
 * 处理：BOM、CRLF、双引号包裹（内部 `""` 表示一个引号）、引号内的逗号与换行。
 * 返回二维数组（含表头行），空行已剔除（老师用 Excel 存出来常带尾随空行）。
 *
 * 🔴 为什么放在 contracts：`CrudPage` 的「导入」按钮与成绩册的成绩导入**必须同一份**。
 *    两处各写一份，就会出现"某个文件在一处能导、在另一处导不出来"这类无解报障。
 */
export function parseCsvRows(text: string): string[][] {
  const s = String(text ?? '').replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i] as string;
    if (inQuote) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else inQuote = false;
      } else cur += ch;
      continue;
    }
    if (ch === '"') {
      inQuote = true;
      continue;
    }
    if (ch === ',') {
      row.push(cur);
      cur = '';
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i += 1;
      row.push(cur);
      cur = '';
      if (!(row.length === 1 && row[0] === '')) rows.push(row);
      row = [];
      continue;
    }
    cur += ch;
  }
  row.push(cur);
  if (!(row.length === 1 && row[0] === '')) rows.push(row);
  return rows;
}

/** CSV 单元格转义（含逗号 / 引号 / 换行时加引号） */
export function csvCell(v: unknown): string {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** 学生ID 列名（导入时优先用它匹配，防同名错配） */
export const GRADE_IMPORT_ID_COL = '学生ID（勿改）';
/** 学生姓名列名 */
export const GRADE_IMPORT_NAME_COL = '学生姓名';
/**
 * 「**清空**这一格」的标记（大小写不敏感）。
 *
 * 🔴 为什么需要它：导入的默认语义是「**空 = 不动**」（见 `parseGradeImport`）——
 *    老师往往只填其中几列，空着的不该把已有分数删掉。
 *    所以要清空某一格，必须**显式**写个记号；后端 `saveEntries` 收到空串就会删掉该条目。
 *
 * 🔴🔴 为什么是 `clear` 而**不是** `-`：后端的 `parseScoreInput` 把 `-`（以及 `na`、`n/a`）
 *    当作**缺考**（`ABSENT_TOKENS`）。若导出/导入也用 `-` 表示"清空"，
 *    同一个符号就有了两套语义 —— 老师在格子里手输 `-` 得到缺考、在导入文件里写 `-`
 *    却把格子清空了，而且**都不报错**。所以必须换一个不与任何既有 token 撞的记号。
 *    选 `clear` 是因为它自明、且在 `EXCUSED_TOKENS` / `ABSENT_TOKENS` 里都不存在
 *    （那两个列表见 `apps/api/src/exam-grade/exam-grade.logic.ts`）。
 *    ⚠️ 反过来说：以后往那两个 token 列表里加词时，**别加 `clear`**。
 */
export const GRADE_IMPORT_CLEAR = 'clear';

/**
 * 单元格 → **导出/导入用的规范文本**（语言无关）。
 *
 * 🔴 为什么不复用界面上的 `cellText`（`apps/web/app/markbook/page.tsx`）：
 *    那个是**给人看的**，免考/缺考走 i18n 文案 —— 英文界面会导出 `Excused`/`Absent`。
 *    （这两个词刚好也在 token 列表里，能解析回来；但"刚好能"不是设计，是运气。
 *      将来 i18n 文案一改，英文用户的模板就导不回来了，而且只在英文界面复现。）
 *    导出/导入是**机器往返**，必须用一套固定写法：`免` / `缺` / 等级 / 数字。
 *    ✅ 守卫里有一条**往返断言**：`gradeCellExportText` 的输出必须能被后端的
 *       `parseScoreInput` 解析回同一个状态（免 → 免考、缺 → 缺考、数字 → 同值）。
 */
export function gradeCellExportText(cell: {
  status?: string;
  score?: number | null;
  level?: string;
} | null | undefined): string {
  if (!cell) return '';
  const st = String(cell.status ?? '').trim();
  if (st === '免考') return '免';
  if (st === '缺考') return '缺';
  if (cell.score != null && Number.isFinite(Number(cell.score))) return String(cell.score);
  // 只录了等级（等级区间没有分数上下限时得分可能为空）→ 写等级本身
  return String(cell.level ?? '').trim();
}

export interface GradeTemplateColumn {
  id: string;
  name: string;
  type?: string;
}

/** 列头（重名时加 `(2)`、`(3)`）——**模板生成与导入解析共用同一份**，否则必然串位 */
export function gradeColumnHeaders(
  columns: readonly GradeTemplateColumn[],
): { colId: string; header: string }[] {
  const used = new Map<string, number>();
  const out: { colId: string; header: string }[] = [];
  for (const c of columns ?? []) {
    const base = String(c?.name ?? '').trim() || '未命名列';
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    out.push({ colId: String(c?.id ?? ''), header: n === 1 ? base : base + '(' + n + ')' });
  }
  return out;
}

/** 导入文件的表头 → 列 id（模板表头的反查；匹配不上的列名要报给老师看清楚） */
export function gradeHeaderIndex(
  headerRow: readonly string[],
  columns: readonly GradeTemplateColumn[],
): {
  /** 第 i 列对应哪个考核列（'' = 不是考核列，如姓名 / id 列，或匹配不上） */
  byIndex: string[];
  /** 模板里出现了、但当前班级没有的列头 */
  unknown: string[];
} {
  const heads = gradeColumnHeaders(columns);
  const headerToId = new Map(heads.map((h) => [h.header, h.colId]));
  const byIndex: string[] = [];
  const unknown: string[] = [];
  for (const raw of headerRow ?? []) {
    const h = String(raw ?? '').trim();
    if (!h || h === GRADE_IMPORT_NAME_COL || h === GRADE_IMPORT_ID_COL) {
      byIndex.push('');
      continue;
    }
    const id = headerToId.get(h);
    if (id) {
      byIndex.push(id);
      continue;
    }
    byIndex.push('');
    unknown.push(h);
  }
  return { byIndex, unknown };
}

/**
 * 生成模板 CSV（一行一学生、一列一考核项）。
 *
 * 结构：
 * ```
 * 学生姓名,学生ID（勿改）,月考一,月考二
 * # 填法：只填要改的格子；空着 = 不动（不会清空原有分数）；要清空写 -
 * 张三,recvtZbIHraRAX,85,
 * ```
 * ⚠️ 说明行以 `#` 开头（导入时会跳过）—— 放在**第 2 行**而不是表头之前：
 *    表头必须是第一行，Excel 打开才是一张规整的表。
 */
export function buildGradeTemplateCsv(input: {
  students: readonly { id: string; name: string; enName?: string }[];
  columns: readonly GradeTemplateColumn[];
  /** 取某格现有分数的展示文本（导出时带上，改起来有参照）；返回空串 = 未录入 */
  cellText?: (studentId: string, columnId: string) => string;
  /** 是否写说明行（默认写） */
  hint?: boolean;
}): string {
  const heads = gradeColumnHeaders(input.columns);
  const lines: string[] = [];
  lines.push(
    [GRADE_IMPORT_NAME_COL, GRADE_IMPORT_ID_COL, ...heads.map((h) => h.header)].map(csvCell).join(','),
  );
  if (input.hint !== false) {
    lines.push(
      '# 填法：只填要改的格子；空着 = 不动（不会清空原有分数）；要清空某一格写 ' +
        GRADE_IMPORT_CLEAR +
        '（大小写不敏感）；可填 数字 / 85% / 等级 / 免（免考）/ 缺（缺考）',
    );
  }
  for (const st of input.students ?? []) {
    const cells = heads.map((h) => input.cellText?.(st.id, h.colId) ?? '');
    lines.push([st.name, st.id, ...cells].map(csvCell).join(','));
  }
  return lines.join('\r\n');
}

export interface GradeImportProblem {
  /** 文件里的第几行（1 基，含表头 —— 与 Excel 的行号一致，老师好定位） */
  line: number;
  /** 人看得懂的定位（学生名 · 列名） */
  where: string;
  reason: string;
}

export interface GradeImportParsed {
  /**
   * 提交给后端的变更行。
   * ⚠️ 「空 = 不动」那条只在**输入为空**时成立 —— 那类格子**不进 rows**（计入 `untouched`）。
   *    写 `clear` 的格子会以 `raw: ''` 进 rows（后端把空串解释成"删除该条目"），
   *    所以 rows 里**允许**出现 `raw === ''`，别在别处假设"rows 里全是非空值"。
   */
  rows: { columnId: string; studentId: string; raw: string }[];
  /** 空着没填的格子数（不动） */
  untouched: number;
  /** 显式清空的格子数（写 `clear`，见 `GRADE_IMPORT_CLEAR`） */
  clears: number;
  /** 能在前端判出来的问题（列名没匹配上 / 学生找不到 / 同名歧义） */
  problems: GradeImportProblem[];
  /** 表头里出现了、但当前班级没有的列名 */
  unknownColumns: string[];
}

/**
 * 解析导入文件 → 变更行 + 问题清单（**纯函数，前端调用；不在服务端重做一份**）。
 *
 * ## 三条语义（写死在判据里，别在界面另一处再解释一遍）
 *
 * 1. 🔴 **空 = 不动**。老师通常只填一部分格子；若按"空 = 清空"提交，
 *    一次导入会把其他列的分全删掉（且后端不报错，只是数量对不上）。
 * 2. 🔴 **`-` = 清空**（显式记号）。转成空串交给后端 ⇒ 后端删该条目。
 * 3. 🔴 学生匹配：**`学生ID` 列优先**（模板自带、防同名错配）；
 *    没有该列或对不上时回落**姓名精确匹配**，且**必须唯一** ——
 *    同名两人一律报错不猜（猜错就是把 A 的分写到 B 头上，而且看不出来）。
 *
 * ⚠️ 值本身（数字 / 85% / 等级 / 免 / 缺）**不在这里解析**：原样交给后端
 *    `POST /markbook/entries/save`，由 `parseScoreInput` 判合法性与警告
 *    —— 值解析全站只有那一份，前端再写一份必然"导入的能过、手填的过不了"。
 */
export function parseGradeImport(input: {
  text: string;
  students: readonly { id: string; name: string }[];
  columns: readonly GradeTemplateColumn[];
}): GradeImportParsed {
  const rows = parseCsvRows(input.text).filter(
    (r) => !String(r[0] ?? '').trim().startsWith('#'),
  );
  const out: GradeImportParsed = {
    rows: [],
    untouched: 0,
    clears: 0,
    problems: [],
    unknownColumns: [],
  };
  if (rows.length < 2) {
    out.problems.push({ line: 1, where: '文件', reason: '文件里没有数据行（表头之外是空的）' });
    return out;
  }

  const header = rows[0] as string[];
  const { byIndex, unknown } = gradeHeaderIndex(header, input.columns);
  out.unknownColumns = unknown;
  const headerOf = new Map(gradeColumnHeaders(input.columns).map((h) => [h.colId, h.header]));

  const idxOf = (name: string) => header.findIndex((h) => String(h ?? '').trim() === name);
  const iId = idxOf(GRADE_IMPORT_ID_COL);
  const iName = idxOf(GRADE_IMPORT_NAME_COL);
  if (iId < 0 && iName < 0) {
    out.problems.push({
      line: 1,
      where: '表头',
      reason:
        '找不到「' +
        GRADE_IMPORT_NAME_COL +
        '」或「' +
        GRADE_IMPORT_ID_COL +
        '」列 —— 请用成绩册的「导出模板」导出的文件填写',
    });
    return out;
  }

  const byId = new Map(input.students.map((s) => [s.id, s]));
  const byName = new Map<string, { id: string; name: string }[]>();
  for (const s of input.students) {
    const k = String(s.name ?? '').trim();
    byName.set(k, [...(byName.get(k) ?? []), s]);
  }

  for (let r = 1; r < rows.length; r += 1) {
    const line = r + 1; // 文件行号（1 基，含表头）——与 Excel 显示的行号一致
    const row = rows[r] as string[];
    const rawId = iId >= 0 ? String(row[iId] ?? '').trim() : '';
    const rawName = iName >= 0 ? String(row[iName] ?? '').trim() : '';

    // 整行都空 ⇒ 静默跳过（Excel 存出来常带空行，不该报错）
    const anyCell = byIndex.some((cid, i) => cid && String(row[i] ?? '').trim());
    if (!rawId && !rawName && !anyCell) continue;

    let student = rawId ? byId.get(rawId) : undefined;
    if (!student && rawName) {
      const hits = byName.get(rawName) ?? [];
      if (hits.length === 1) student = hits[0];
      else if (hits.length > 1) {
        out.problems.push({
          line,
          where: rawName,
          reason:
            '班里有 ' +
            hits.length +
            ' 个同名「' +
            rawName +
            '」，无法确定是谁 —— 请用模板里的「' +
            GRADE_IMPORT_ID_COL +
            '」列区分',
        });
        continue;
      }
    }
    if (!student) {
      out.problems.push({
        line,
        where: rawName || rawId || '(空)',
        reason: rawId
          ? '这位学生不在当前班级（或「学生ID」被改过）'
          : '这位学生不在当前班级',
      });
      continue;
    }

    for (let i = 0; i < byIndex.length; i += 1) {
      const colId = byIndex[i] as string;
      if (!colId) continue;
      const v = String(row[i] ?? '').trim();
      if (!v) {
        out.untouched += 1; // 空 = 不动（见函数头第 1 条）
        continue;
      }
      if (v.toLowerCase() === GRADE_IMPORT_CLEAR) {
        out.clears += 1;
        out.rows.push({ columnId: colId, studentId: student.id, raw: '' }); // 空串 ⇒ 后端删条目
        continue;
      }
      out.rows.push({ columnId: colId, studentId: student.id, raw: v });
      void headerOf;
    }
  }
  return out;
}
