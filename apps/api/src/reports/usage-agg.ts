/**
 * 「使用统计」报表的聚合与归一（纯函数，配单测）。
 *
 * 这张报表回答的是「谁在用、用了多少」，所以**人名的归一是核心逻辑**，不是装饰：
 * 审计日志里同一个人的写法有三种（2026-09-21 生产实测，占全部记录的 73%）：
 *
 *   `孙旭峰` 446 · `孙旭峰｜Richard` 357 · `Richard` 120
 *
 * 不归一的话，「按操作人统计」里会出现三个"不同的人"，报表直接失去意义。
 * 归一的真源是**系统用户表的姓名**（如 `孙旭峰｜Richard`），其他写法都往它上面并。
 *
 * 另外两类需要单独看待，不能混进「人」里：
 *   - **系统任务**（`系统 · 行为告警重算`）—— 不是人在点；
 *   - **测试账号**（`验证探针` / `探针` / `forge` / `adm`）—— 是验证脚本写的。
 * 它们统一归到一行「系统任务 · 测试」，明细留在 `detail` 里供排查（不要静默丢掉）。
 */

/** 未填值/空值的展示名。**必须排最后** —— 它表示「没有信息」，不是一个类别 */
export const UNFILLED = '（未填写）';

/** 系统任务与测试账号合并后的行名 */
export const SYSTEM_ACTOR = '系统任务 · 测试';

/**
 * 系统任务 / 测试账号的识别模式。
 *
 * 刻意保守：只匹配明确的写法，宁可有漏网的（显示成一个人名，肉眼能看出来）
 * 也不要把真人误并进「系统任务」（那会让使用量凭空少一块，且很难发现）。
 */
const SYSTEM_PATTERNS: readonly RegExp[] = [
  /^系统/, // 系统 · 行为告警重算
  /^system\b/i,
  /探针/, // 验证探针 / 探针
  /^验证/, // 「验证」/「验证会话」—— 自动化验证脚本留下的名字（2026-09-21 实测有）
  /测试/, // 测试账号
  /^forge$/i,
  /^adm(in(istrator)?)?$/i,
  /^cron\b/i,
  /^bot\b/i,
];

/**
 * 维度值（行名/列名）的清洗：**只去首尾空白**。
 *
 * ⚠️ 与 `normalizeActorName` 的区别很重要：那个还会去中间的空格（人名里
 * `刘佳音 ｜ Joy` 要并成 `刘佳音｜Joy`），但**列名是业务文本**（如「系统任务 · 测试」
 * 「学生记录 · 家校沟通」），把中间空格删掉会变成「系统任务·测试」——
 * 2026-09-21 上线探针就抓到过这个（断言用带空格的文案比对不上）。
 * 所以行名在调用方先归一，`buildMatrix` 只做 trim。
 */
function cleanLabel(raw: unknown): string {
  return String(raw ?? '').trim() || UNFILLED;
}

/**
 * 归一用的清洗：去空白（含全角）、统一分隔符。
 *
 * ⚠️ 生产数据里既有 `刘佳音 ` （尾部空格）也有 `刘佳音 ｜ Joy`（分隔符两侧带空格），
 *    不清洗就归不到一起。分隔符统一成 `｜`（全角），`|`/`/` 视为同义。
 */
export function normalizeActorName(raw: unknown): string {
  return String(raw ?? '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[|/]/g, '｜')
    .trim();
}

/** 是否是系统任务 / 测试账号 */
export function isSystemActor(raw: unknown): boolean {
  const s = normalizeActorName(raw);
  if (!s) return false;
  return SYSTEM_PATTERNS.some((re) => re.test(s));
}

/**
 * 用一个「已知姓名清单」（系统用户表）构造归一函数。
 *
 * 匹配顺序：
 *   1. 清洗后**全等**标准姓名 ⇒ 直接用它（最可靠）；
 *   2. 按 `｜` 拆段，某一段与**唯一**一个标准姓名的某一段相同 ⇒ 并到那个姓名
 *      （覆盖 `Richard` → `孙旭峰｜Richard`）；
 *   3. 匹配不上 ⇒ **保留清洗后的原值**（不丢数据、不猜）。
 *
 * 🔴 第 2 步要求「段 → 姓名」是**一对一的**：同名段对应多个人时（例如两处都有 `Amy`）
 *    宁可保留原值也不合并 —— 把两个人的使用量并成一个人，比多出一行更难发现。
 */
export function buildActorNormalizer(knownNames: readonly string[]): (raw: unknown) => string {
  const standards: string[] = [];
  const byFull = new Map<string, string>();
  const bySeg = new Map<string, string[]>();

  for (const name of knownNames) {
    const clean = normalizeActorName(name);
    if (!clean) continue;
    standards.push(clean);
    byFull.set(clean, clean);
    for (const seg of clean.split('｜').filter(Boolean)) {
      const list = bySeg.get(seg) ?? [];
      list.push(clean);
      bySeg.set(seg, list);
    }
  }

  return (raw: unknown): string => {
    const s = normalizeActorName(raw);
    if (!s) return UNFILLED;
    if (isSystemActor(s)) return SYSTEM_ACTOR;
    const exact = byFull.get(s);
    if (exact) return exact;
    for (const seg of s.split('｜').filter(Boolean)) {
      const hit = bySeg.get(seg);
      // ⚠️ 用局部变量而不是 `hit[0]`：`noUncheckedIndexedAccess` 下下标取值是 `string | undefined`
      const only = hit?.length === 1 ? hit[0] : undefined;
      if (only) return only;
    }
    return s;
  };
}

/** 参与归一化的所有标准姓名（排查用） */
export function knownNamesOf(knownNames: readonly string[]): string[] {
  return knownNames.map((n) => normalizeActorName(n)).filter(Boolean);
}

// ─────────────────────── 矩阵 ───────────────────────

export interface UsageRow {
  /** 行名（已归一的维度值） */
  label: string;
  /** 与 `cols` 一一对应的计数 */
  cells: number[];
  total: number;
  /** 需要额外说明时的明细（如「系统任务 · 测试」由哪些写法合成） */
  detail?: string;
}

export interface UsageMatrix {
  /** 列名（维度取值），按合计降序；空值列排在最后 */
  cols: string[];
  rows: UsageRow[];
  colTotals: number[];
  /** 全表总计 = 各 cell 之和（列合计之和 / 行合计之和必须等于它） */
  total: number;
}

/**
 * 由 (行, 列) 对构建矩阵。
 *
 * 三条口径（都会出现在界面上，写死可测）：
 *   1. 行、列都按合计**降序**，同位按名称稳定排序（同一份数据两次调用顺序必须一致）；
 *   2. **空值（UNFILLED）恒排最后** —— 它表示「没有信息」，不该按数量挤到前面，
 *      也不该因为数量为 0 而消失（0 也要留一行，否则「有没有人没填」看不出来）；
 *   3. `total` 取各 cell 之和，**行合计之和 = 列合计之和 = total**（单测钉死）。
 */
export function buildMatrix(
  items: readonly { row: unknown; col: unknown; weight?: number }[],
): UsageMatrix {
  const rowSet = new Set<string>();
  const colSet = new Set<string>();
  const cell = new Map<string, number>();
  const key = (r: string, c: string) => `${r}\u0000${c}`;

  for (const it of items) {
    const r = cleanLabel(it.row);
    const c = cleanLabel(it.col);
    const w = Number.isFinite(it.weight) ? Number(it.weight) : 1;
    rowSet.add(r);
    colSet.add(c);
    cell.set(key(r, c), (cell.get(key(r, c)) ?? 0) + w);
  }

  const totalsOf = (vals: Iterable<string>, byRow: boolean): Map<string, number> => {
    const m = new Map<string, number>();
    for (const v of vals) {
      let sum = 0;
      for (const other of byRow ? colSet : rowSet) {
        sum += cell.get(byRow ? key(v, other) : key(other, v)) ?? 0;
      }
      m.set(v, sum);
    }
    return m;
  };

  /** 降序 + 空值最后 + 同位按名称稳定 */
  const order = (vals: string[], totals: Map<string, number>): string[] =>
    [...vals].sort((a, b) => {
      if ((a === UNFILLED) !== (b === UNFILLED)) return a === UNFILLED ? 1 : -1;
      const d = (totals.get(b) ?? 0) - (totals.get(a) ?? 0);
      return d !== 0 ? d : a.localeCompare(b, 'zh-Hans-CN');
    });

  const colTotalsMap = totalsOf(colSet, false);
  const rowTotalsMap = totalsOf(rowSet, true);
  const cols = order([...colSet], colTotalsMap);
  const rows = order([...rowSet], rowTotalsMap).map((label) => ({
    label,
    cells: cols.map((c) => cell.get(key(label, c)) ?? 0),
    total: rowTotalsMap.get(label) ?? 0,
  }));

  return {
    cols,
    rows,
    colTotals: cols.map((c) => colTotalsMap.get(c) ?? 0),
    total: rows.reduce((s, r) => s + r.total, 0),
  };
}

/**
 * 把「原始写法 → 次数」拼成一行明细文本，供「系统任务 · 测试」这类合并行展示。
 *
 * 为什么必须留明细：合并行把 5 种写法压成 1 行，界面上只看得到「80 次」。
 * 万一里面混进了真人（写成了 `系统 xxx` 之类），没有明细就永远查不出来。
 * 明细挂在 `title` 上，正常看不占地方、排查时一悬停就有。
 */
export function buildActorDetail(counts: ReadonlyMap<string, number>): string {
  const entries = [...counts.entries()].filter(([n]) => String(n ?? '').trim() !== '');
  if (entries.length <= 1) return '';
  return entries
    .sort((a, b) => b[1] - a[1])
    .map(([n, c]) => `${n} ${c}`)
    .join(' · ');
}

// ─────────────────────── 模块名 ───────────────────────

/**
 * 把审计日志里的「业务模块」值翻成模块中文名。
 *
 * 为什么需要：审计存的是**接口路径段**（`users` / `meeting-minutes` / `markbook-weights`），
 * 直接显示给使用者等于什么都没说（2026-09-21 生产实测：Top 12 全是英文 key）。
 * 真源是 contracts 的 `MODULE_RESOURCES`（key / path / aliases 都可能是审计里存的那个值）。
 *
 * 匹配不上就**原样返回**：审计可能记录了还没登记进资源目录的路径，
 * 显示原值至少能看出是哪个模块，比显示「未知」有用。
 */
export function buildModuleLabelResolver(
  resources: readonly {
    key: string;
    label: string;
    path?: string;
    aliases?: readonly string[];
  }[],
): (raw: unknown) => string {
  const map = new Map<string, string>();
  /** 去前导斜杠、去查询串、小写化 —— 索引与查询共用同一份清洗，避免「建索引时洗了、查的时候没洗」 */
  const bare = (raw: unknown): string => {
    const s = String(raw ?? '').trim().replace(/^\/+/, '');
    const q = s.indexOf('?');
    return (q >= 0 ? s.slice(0, q) : s).toLowerCase();
  };
  const put = (k: string | undefined, label: string) => {
    const s = bare(k);
    // 先到先得：MODULE_RESOURCES 的顺序本身就是「更具体的在前」的既有约定，
    // 冲突时保留第一个（例如 aliases 里列的旧路径）。
    if (s && !map.has(s)) map.set(s, label);
  };
  for (const r of resources) {
    put(r.key, r.label);
    put(r.path, r.label);
    for (const a of r.aliases ?? []) put(a, r.label);
  }
  return (raw: unknown): string => {
    const s = String(raw ?? '').trim();
    if (!s) return '';
    return map.get(bare(s)) ?? s;
  };
}
