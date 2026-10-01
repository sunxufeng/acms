/**
 * 「代码规则」——把「一个编号怎么拼出来」从代码里拿出来，变成后台可配（2026-10-01 峰哥）。
 *
 * 🔴 为什么默认规则是**逆推出来的**、而不是设计稿里那个 `AR-26秋-B-0001`：
 *    设计稿里的例子是**假设**的。生产 82 个学籍号的实际格式是
 *    `{入学年份后2位}{秋季|春季→FA|SP}-{项目码}-{流水3位}`，例如 `26FA-P1-003`。
 *    如果默认规则按设计稿的假设来，新学生拿到的号会跟存量**两套格式并存**。
 *    所以这里先用只读盘点把真实格式逆推出来（82/82 一致），再写成默认规则，
 *    并由单测钉住「默认规则能**逐条复现**存量学籍号」——这是这个页面最硬的一条正确性判据。
 *
 * 🔴 学籍号是**学生与家长的登录凭证**（`学生编号` 或 学籍号 + 姓名即可登录）
 *    ⇒ 规则改错的影响面是"以后所有人拿到格式错的号"，且**已生成的号不会被追溯修改**
 *    （追溯改号 = 有人登不上系统）。所以：默认只读 + 单测复现存量 + 权限点不随迁移发放。
 *
 * ⚠️ 这里只放**判据与纯函数**（前后端共用）。落库、试算接口在
 *    `apps/api/src/code-rules/`，页面在 `apps/web/app/code-rules/`。
 */

// ══════════════════════════════════════════════════════════════
// 段模型
// ══════════════════════════════════════════════════════════════

/** 五种段类型（这个模型能表达绝大多数编号需求，且不用改代码就能加新形态） */
export const CODE_SEGMENT_KINDS = ['text', 'date', 'field', 'serial', 'random'] as const;
export type CodeSegmentKind = (typeof CODE_SEGMENT_KINDS)[number];

export const CODE_SEGMENT_LABEL: Record<CodeSegmentKind, { zh: string; en: string }> = {
  text: { zh: '固定文本', en: 'Text' },
  date: { zh: '日期分量', en: 'Date part' },
  field: { zh: '取自记录字段', en: 'Record field' },
  serial: { zh: '流水号', en: 'Serial' },
  random: { zh: '随机串', en: 'Random' },
};

/** 日期分量格式 */
export const CODE_DATE_FORMATS = ['year4', 'year2', 'yearMonth', 'yearMonthDay', 'academicYear', 'term'] as const;
export type CodeDateFormat = (typeof CODE_DATE_FORMATS)[number];
export const CODE_DATE_FORMAT_LABEL: Record<CodeDateFormat, string> = {
  year4: '年（4 位）2026',
  year2: '年（2 位）26',
  yearMonth: '年月 202609',
  yearMonthDay: '年月日 20260928',
  academicYear: '学年 2026-2027',
  term: '学期 26秋',
};

/**
 * 字段值的变换。
 *
 * 🔴 为什么需要它：存量学籍号第 1 段是「年 2 位」，而 `入学年份` 字段存的是 **`2026`**。
 *    没有 `last2` 就只能把整段 4 位塞进去，生成 `2026FA-P1-003` —— 与存量不一致。
 */
export const CODE_FIELD_TRANSFORMS = ['raw', 'last2', 'first2'] as const;
export type CodeFieldTransform = (typeof CODE_FIELD_TRANSFORMS)[number];
export const CODE_FIELD_TRANSFORM_LABEL: Record<CodeFieldTransform, string> = {
  raw: '原样',
  last2: '取后 2 位',
  first2: '取前 2 位',
};

/**
 * 映射键的匹配方式。
 *
 * 🔴 为什么需要它（这条最容易踩）：存量学籍号的学期码来自 `入学年月`，字段值是
 *    **`26秋季` / `25春季`**，而映射关系是「秋季 → FA」。键**不是完整值**，
 *    精确匹配会一条都命中不了 ⇒ 用 `suffix`（后缀）或 `contains`（包含）。
 *    这与「语义相近 ≠ 选项体系相同」是同一类问题：**先对键，别先对语义**。
 *    默认 `suffix`：`26秋季`.endsWith(`秋季`) ⇒ FA，且能覆盖以后所有年份。
 */
export const CODE_MAP_MATCHES = ['exact', 'suffix', 'contains'] as const;
export type CodeMapMatch = (typeof CODE_MAP_MATCHES)[number];
export const CODE_MAP_MATCH_LABEL: Record<CodeMapMatch, string> = {
  exact: '完全相同',
  suffix: '按结尾匹配（推荐）',
  contains: '按包含匹配',
};

/** 流水号重置周期 */
export const CODE_RESET_CYCLES = ['none', 'year', 'academicYear', 'term', 'month', 'day'] as const;
export type CodeResetCycle = (typeof CODE_RESET_CYCLES)[number];
export const CODE_RESET_CYCLE_LABEL: Record<CodeResetCycle, string> = {
  none: '不重置',
  year: '每年',
  academicYear: '每学年',
  term: '每学期',
  month: '每月',
  day: '每天',
};

/** 重置维度（流水线按什么分组各自计数） */
export const CODE_RESET_SCOPES = ['prefix', 'global', 'field'] as const;
export type CodeResetScope = (typeof CODE_RESET_SCOPES)[number];
export const CODE_RESET_SCOPE_LABEL: Record<CodeResetScope, string> = {
  prefix: '同前缀（推荐）',
  global: '全局一条线',
  field: '同某个字段',
};

/** 撞号怎么办 */
export const CODE_CONFLICT_STRATEGIES = ['next', 'error'] as const;
export type CodeConflictStrategy = (typeof CODE_CONFLICT_STRATEGIES)[number];
export const CODE_CONFLICT_LABEL: Record<CodeConflictStrategy, string> = {
  next: '跳到下一个可用号',
  error: '直接报错，让人工填',
};

export type CodeSegment =
  | { kind: 'text'; value: string }
  | { kind: 'date'; format: CodeDateFormat }
  | { kind: 'field'; field: string; transform: CodeFieldTransform; map: Record<string, string>; mapMatch: CodeMapMatch }
  | {
      kind: 'serial';
      digits: number;
      start: number;
      step: number;
      cycle: CodeResetCycle;
      scope: CodeResetScope;
      /** `scope === 'field'` 时按哪个字段分组 */
      scopeField: string;
    }
  | { kind: 'random'; length: number; charset: string };

export type CodeRule = {
  /** 规则唯一键（= 目标字段的英文 key，如 `studentNo`） */
  key: string;
  name: string;
  /** contracts 里的表 key（如 `studentProfile`） */
  targetTable: string;
  /** 字段**真名**（如 `学籍号（脱敏）` —— 注意是全角括号） */
  targetField: string;
  enabled: boolean;
  segments: CodeSegment[];
  /**
   * 段之间的分隔符。
   *
   * ⚠️ 为 `''`（默认）时**不插任何东西**，靠显式的 `{kind:'text', value:'-'}` 段来表达
   *    分隔 —— 存量格式 `26FA-P1-001` 里「年+学期」是连在一起的（`26FA`），
   *    若用"所有段之间都插 `-`"的做法会生成 `26-FA-P1-001`，与存量不一致。
   *    所以默认规则用「显式文本段」写法，这个选项只在"每段之间都要插"的简单规则上用。
   */
  separator: string;
  upperCase: 'upper' | 'lower' | 'keep';
  conflict: CodeConflictStrategy;
  /** `conflict === 'next'` 时最多往后试几次 */
  conflictRetry: number;
  note: string;
};

export type CodeRuleConfig = { rules: CodeRule[] };

// ══════════════════════════════════════════════════════════════
// 默认规则（逆推自生产 82 个学籍号，82/82 一致）
// ══════════════════════════════════════════════════════════════

/** 学年起算月：8 月及以后算当年的秋季学期 */
export const ACADEMIC_YEAR_START_MONTH = 8;

/** 项目码映射（`入学年级` → 学籍号中段）。逐条与生产数据核对过 */
export const STUDENT_NO_GRADE_MAP: Record<string, string> = {
  未来企业家班: 'FEP',
  'Pre-1': 'P1',
  'Pre-2': 'P2',
  'Pre-3': 'P3',
  大一: 'Y1',
  全球领航计划: 'GP',
  /**
   * ⚠️ 历史脏值：有 1 条记录的 `入学年级` 填的是 `G10`（卫瓴年级体系），
   *    但它的学籍号是 `24FA-P1-001` ⇒ 实际就是 Pre-1。留着这条映射是为了
   *    批量为这类记录补号时不生成格式外的号（而不是"认可 G10 这个写法"）。
   */
  G10: 'P1',
};

/** 学期码映射：按**结尾**匹配（字段值是 `26秋季`，键是 `秋季`） */
export const STUDENT_NO_TERM_MAP: Record<string, string> = { 秋季: 'FA', 春季: 'SP' };

/**
 * 默认「学籍号」规则 —— **与存量格式逐字一致**。
 *
 * 组成：`[入学年份取后2位][入学年月→FA/SP][-][入学年级→项目码][-][流水3位]`
 *   · 流水按 `{年2位}{学期}-{项目码}` 分组重置（`26FA-P1-001`…`026FA-P1-025`、`25FA-P1-001`…）
 *   · 起始 1、步长 1、撞号往后跳（不做全局序号锁 —— 见设计文档 K3）
 */
export const DEFAULT_STUDENT_NO_RULE: CodeRule = {
  key: 'studentNo',
  name: '学籍号（26 级起）',
  targetTable: 'studentProfile',
  targetField: '学籍号（脱敏）',
  enabled: true,
  segments: [
    { kind: 'field', field: '入学年份', transform: 'last2', map: {}, mapMatch: 'exact' },
    { kind: 'field', field: '入学年月', transform: 'raw', map: STUDENT_NO_TERM_MAP, mapMatch: 'suffix' },
    { kind: 'text', value: '-' },
    { kind: 'field', field: '入学年级', transform: 'raw', map: STUDENT_NO_GRADE_MAP, mapMatch: 'exact' },
    { kind: 'text', value: '-' },
    { kind: 'serial', digits: 3, start: 1, step: 1, cycle: 'term', scope: 'prefix', scopeField: '' },
  ],
  separator: '',
  upperCase: 'upper',
  conflict: 'next',
  conflictRetry: 20,
  note: '逆推自生产 82 个学籍号（82/82 一致）。改之前先跑试算，确认能复现存量格式。',
};

/**
 * 「学生编号」规则 —— **默认停用**（设计文档 K5）。
 *
 * 🔴 为什么停用而不是启用：`学生编号` 在 PG 模式下**不是自动生成的**（它原本是飞书
 *    AutoNumber），而它又是「学生账号管理」那套密码账号的唯一键。
 *    存量 84 人里只有 82 人有值、2 人没有 ⇒ 启用它会一下子决定"以后新建的学生
 *    拿什么编号"，而这件事的后果（能不能开户）比学籍号更硬。
 *    先登记、默认停用，等峰哥确认口径后再开。
 */
export const DEFAULT_STUDENT_CODE_RULE: CodeRule = {
  key: 'studentCode',
  name: '学生编号（兜底，默认停用）',
  targetTable: 'studentProfile',
  targetField: '学生编号',
  enabled: false,
  segments: [
    { kind: 'text', value: 'STU-' },
    { kind: 'serial', digits: 5, start: 301, step: 1, cycle: 'none', scope: 'global', scopeField: '' },
  ],
  separator: '',
  upperCase: 'upper',
  conflict: 'next',
  conflictRetry: 20,
  note: '存量 82 条形如 STU-00286。启用前先确认「学生编号」在 PG 下确实不再自动生成。',
};

export const DEFAULT_CODE_RULE_CONFIG: CodeRuleConfig = {
  rules: [DEFAULT_STUDENT_NO_RULE, DEFAULT_STUDENT_CODE_RULE],
};

/** 可配的目标字段（页面上「目标字段」下拉的候选） */
export const CODE_RULE_TARGETS: { table: string; tableLabel: string; field: string; unique: boolean }[] = [
  { table: 'studentProfile', tableLabel: '学生档案', field: '学籍号（脱敏）', unique: true },
  { table: 'studentProfile', tableLabel: '学生档案', field: '学生编号', unique: true },
];

// ══════════════════════════════════════════════════════════════
// 日期分量 / 重置周期
// ══════════════════════════════════════════════════════════════

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 学年起始年：8 月及以后算当年，否则算上一年 */
function academicStartYear(d: Date): number {
  return d.getMonth() + 1 >= ACADEMIC_YEAR_START_MONTH ? d.getFullYear() : d.getFullYear() - 1;
}

/** 学期：秋季 = 8 月~次年 1 月，春季 = 2~7 月 */
function termOf(d: Date): { year: number; season: '秋' | '春' } {
  const m = d.getMonth() + 1;
  if (m >= ACADEMIC_YEAR_START_MONTH) return { year: d.getFullYear(), season: '秋' };
  if (m <= 1) return { year: d.getFullYear() - 1, season: '秋' };
  return { year: d.getFullYear(), season: '春' };
}

export function formatDatePart(format: CodeDateFormat, nowMs: number): string {
  const d = new Date(Number.isFinite(nowMs) ? nowMs : Date.now());
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  switch (format) {
    case 'year4':
      return String(y);
    case 'year2':
      return String(y).slice(-2);
    case 'yearMonth':
      return `${y}${pad2(m)}`;
    case 'yearMonthDay':
      return `${y}${pad2(m)}${pad2(d.getDate())}`;
    case 'academicYear': {
      const s = academicStartYear(d);
      return `${s}-${s + 1}`;
    }
    case 'term': {
      const t = termOf(d);
      return `${String(t.year).slice(-2)}${t.season}`;
    }
    default:
      return '';
  }
}

/** 重置周期的"窗口键"：同一个键内的流水是连续的一条线 */
export function cycleKeyOf(cycle: CodeResetCycle, nowMs: number): string {
  const d = new Date(Number.isFinite(nowMs) ? nowMs : Date.now());
  switch (cycle) {
    case 'none':
      return '';
    case 'year':
      return String(d.getFullYear());
    case 'academicYear':
      return formatDatePart('academicYear', nowMs);
    case 'term':
      return formatDatePart('term', nowMs);
    case 'month':
      return formatDatePart('yearMonth', nowMs);
    case 'day':
      return formatDatePart('yearMonthDay', nowMs);
    default:
      return '';
  }
}

// ══════════════════════════════════════════════════════════════
// 字段取值 + 映射
// ══════════════════════════════════════════════════════════════

/**
 * 按变换方式取字段值。
 *
 * ⚠️ 判空一律 `String(x ?? '').trim()`：字段缺失/`null`/数字都要能安全落到空串，
 *    不能抛错（生成编号时抛错会连带把"新建学生"整条链路弄挂）。
 */
export function fieldValueOf(fields: Record<string, unknown>, field: string, transform: CodeFieldTransform): string {
  const raw = String((fields ?? {})[field] ?? '').trim();
  if (!raw) return '';
  if (transform === 'last2') return raw.slice(-2);
  if (transform === 'first2') return raw.slice(0, 2);
  return raw;
}

/**
 * 按映射表翻译（含 `mapMatch` 三种匹配方式）。
 *
 * ⚠️ 映射表为空 ⇒ **原样返回**（不是返回空）——「没配映射」和「配了但没命中」是两回事：
 *    前者应该让号正常生成（比如项目码本来就要求填原文），后者才是"这条规则配漏了"。
 *
 * 🔴 但**生成编号时**不能这么放行：`入学年级` 配了映射表却遇到表外的值（如 `大三`），
 *    原样拼进号里会得到 `26FA-大三-001` 这种格式外的号，而且它**会被写进数据库**。
 *    ⇒ `generateCode()` 用的是下面这个 `mapFieldValueStrict()`（`hit=false` 即拒绝生成）。
 *    本函数保留宽松语义，只给"展示原值"这类场景用。
 */
export function mapFieldValue(raw: string, map: Record<string, string>, mode: CodeMapMatch): string {
  return mapFieldValueStrict(raw, map, mode).value;
}

/** 带命中标记的映射（生成编号时用：未命中 ⇒ 宁可不生成，也不写格式外的号） */
export function mapFieldValueStrict(
  raw: string,
  map: Record<string, string>,
  mode: CodeMapMatch,
): { value: string; hit: boolean } {
  const entries = Object.entries(map ?? {});
  if (!entries.length) return { value: raw, hit: true }; // 没配映射 = 不需要映射
  if (mode === 'suffix') {
    // 长键优先，避免 `季` 与 `秋季` 同时命中时取到更短的
    const hit = entries.filter(([k]) => k && raw.endsWith(k)).sort((a, b) => b[0].length - a[0].length)[0];
    return hit ? { value: hit[1], hit: true } : { value: raw, hit: false };
  }
  if (mode === 'contains') {
    const hit = entries.filter(([k]) => k && raw.includes(k)).sort((a, b) => b[0].length - a[0].length)[0];
    return hit ? { value: hit[1], hit: true } : { value: raw, hit: false };
  }
  const exact = map[raw];
  return exact === undefined ? { value: raw, hit: false } : { value: exact, hit: true };
}

// ══════════════════════════════════════════════════════════════
// 生成
// ══════════════════════════════════════════════════════════════

export type CodeGenContext = {
  nowMs: number;
  /** 记录自身的字段（供 `field` 段与 `scope='field'` 用） */
  fields: Record<string, unknown>;
  /** 该目标字段**已存在**的编号（用来推下一个流水号 + 判冲突） */
  existing: string[];
  /** 随机段的种子（试算时给确定值 ⇒ 预览可复现；不传则用时间） */
  randomSeed?: string;
};

export type CodeGenResult = {
  code: string;
  serial: number;
  /** 流水线分组键（调试/说明用） */
  groupKey: string;
  /** 生成不了时的原因（`code` 为空） */
  reason?: string;
};

/** 简单确定性 PRNG（试算要可复现：同一 seed 必须得到同一个号） */
function seededPicker(seed: string): (n: number) => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (n: number) => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    return Math.abs(h) % Math.max(1, n);
  };
}

function renderSegment(seg: CodeSegment, ctx: CodeGenContext, pick: (n: number) => number): string {
  switch (seg.kind) {
    case 'text':
      return seg.value ?? '';
    case 'date':
      return formatDatePart(seg.format, ctx.nowMs);
    case 'field': {
      const v = fieldValueOf(ctx.fields, seg.field, seg.transform);
      return mapFieldValue(v, seg.map ?? {}, seg.mapMatch ?? 'exact');
    }
    case 'random': {
      const cs = (seg.charset || 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789').replace(/[^A-Za-z0-9]/g, '');
      const len = Math.max(1, Math.min(12, Number(seg.length) || 4));
      let out = '';
      for (let i = 0; i < len; i += 1) out += cs[pick(cs.length)] ?? cs[0];
      return out;
    }
    case 'serial':
      // 流水号在第二步单独算
      return '';
    default:
      return '';
  }
}

/** 转义正则元字符（前缀里可能有 `-` `.` 等） */
function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 从既有编号里挑出「属于同一流水线」的流水值。
 *
 * 匹配方式：`^<前缀>(<数字>)<后缀>$`。
 * ⚠️ 数字用 `\d+` 而不是 `\d{digits}`：既有的号可能有前导零写法差异
 *   （`001` vs `1`），宽松一点才能正确取到"当前最大"。
 * ⚠️ `scope='global'` 时前缀是变化的（含日期），用 `.*?` 兜住前缀部分 —— 宁可少匹配
 *   也不能把别的规则的号算进来。
 * 🔴 前缀是**配置里写的字面值、大小写敏感**：如果规则里的固定文本写成 `26fa-p1-`
 *   而库里存的是 `26FA-P1-001`，这里**一条都匹配不到**（`serials` 为空 ⇒ 流水从 `start` 起）。
 *   后果不是崩溃而是"从 001 开始重数"，然后由撞号策略兜住：
 *   `next` 会往后跳到第一个空位、`error` 会报错让人工看 —— 所以这个坑是可发现的，
 *   但**配规则时要保证固定文本的大小写与库里一致**（试算能立刻看出来）。
 */
function collectSerials(prefix: string, suffix: string, existing: string[], globalScope: boolean): number[] {
  const re = globalScope
    ? new RegExp(`^.*?(\\d+)${suffix ? esc(suffix) : ''}$`)
    : new RegExp(`^${esc(prefix)}(\\d+)${suffix ? esc(suffix) : ''}$`);
  const out: number[] = [];
  for (const c of existing ?? []) {
    const m = re.exec(String(c ?? ''));
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/**
 * 按规则生成一个编号。
 *
 * 关键判据（单测钉住）：
 *   ① 存量格式必须能**逐条复现**（见 `apps/api/test/code-rules.test.ts`）
 *   ② 撞号时按 `conflict` 处置；`next` 往后跳到第一个没被占用的号（允许跳号，见设计 K3）
 *   ③ 🔴 **必需段取不到值 ⇒ 不生成**（`code` 为空 + `reason` 说明缺什么），
 *      **绝不产出 `26FA--001` 这种格式外的残号**（见下方必需段校验的注释）
 *   ④ 任何情况下都**不抛错**：生成编号失败会连带把"新建学生"整条链路弄挂，
 *      所以"不生成"是用返回值表达的，不是异常
 */
export function generateCode(rule: CodeRule, ctx: CodeGenContext): CodeGenResult {
  if (!rule || !rule.enabled) return { code: '', serial: 0, groupKey: '', reason: '规则未启用' };
  const segs = Array.isArray(rule.segments) ? rule.segments : [];
  if (!segs.length) return { code: '', serial: 0, groupKey: '', reason: '规则没有段' };
  if (!segs.some((s) => s.kind === 'serial')) {
    return { code: '', serial: 0, groupKey: '', reason: '规则没有流水号段（会生成重复的号）' };
  }

  const pick = seededPicker(ctx.randomSeed ?? String(ctx.nowMs));
  const sep = typeof rule.separator === 'string' ? rule.separator : '';

  /**
   * 🔴 必需段校验：**取不到值的 `field` 段 ⇒ 整条规则不生成**。
   *
   * 为什么不能"退化成空串"（2026-10-01 生产实测揪出）：
   *   默认学籍号规则的段是 `[年份][学期][-][项目码][-][流水]`，两个 `-` 是**独立的文本段**。
   *   学生的「入学年级」为空时，只有项目码段变成空串、被 `filter(x => x !== '')` 滤掉，
   *   而两个 `-` 还在 ⇒ 生成 `26FA--001`。
   *   这个残号**格式不合法却长得像合法的**，批量补号会把它写进「学籍号（脱敏）」
   *   —— 而学籍号是**学生 / 家长 / 小程序的登录凭证**，写错了就是"这个人拿这个号登不进来"。
   *   ⇒ 宁可这条不生成（页面上把原因写清楚让人补数据），也不写格式外的号。
   *
   * 同理，`map` 配了却没命中的值（如 `入学年级='大三'` 不在映射表里）也拒绝生成 ——
   * 否则会写出 `26FA-大三-001`。
   */
  for (const s of segs) {
    if (s.kind !== 'field') continue;
    const raw = fieldValueOf(ctx.fields, s.field, s.transform);
    if (!raw) {
      return { code: '', serial: 0, groupKey: '', reason: `字段「${s.field}」为空，无法生成` };
    }
    const m = mapFieldValueStrict(raw, s.map ?? {}, s.mapMatch ?? 'exact');
    if (!m.hit) {
      return {
        code: '',
        serial: 0,
        groupKey: '',
        reason: `「${raw}」不在字段「${s.field}」的映射表里，无法生成`,
      };
    }
  }

  const serialIdx = segs.findIndex((s) => s.kind === 'serial');
  const serialSeg = segs[serialIdx] as Extract<CodeSegment, { kind: 'serial' }>;

  const rendered = segs.map((s) => renderSegment(s, ctx, pick));
  /** 拼装：把空段去掉，避免出现 `26FA--001` 这种双分隔符 */
  const joinSide = (from: number, to: number): string =>
    rendered
      .slice(from, to)
      .filter((x) => x !== '')
      .join(sep);

  const prefix = joinSide(0, serialIdx);
  const suffix = joinSide(serialIdx + 1, segs.length);

  const digits = Math.max(1, Math.min(12, Number(serialSeg.digits) || 3));
  const start = Number.isFinite(Number(serialSeg.start)) ? Math.max(0, Math.trunc(Number(serialSeg.start))) : 1;
  const step = Number.isFinite(Number(serialSeg.step)) && Number(serialSeg.step) > 0 ? Math.trunc(Number(serialSeg.step)) : 1;
  const globalScope = serialSeg.scope === 'global';
  const fieldScope = serialSeg.scope === 'field';

  const fieldKey = fieldScope ? String(fieldValueOf(ctx.fields, serialSeg.scopeField, 'raw')) : '';
  const groupKey = [cycleKeyOf(serialSeg.cycle, ctx.nowMs), globalScope ? '*' : prefix, fieldScope ? fieldKey : '']
    .filter((x) => x !== '')
    .join('|');

  const used = new Set<string>((ctx.existing ?? []).map((x) => String(x ?? '')).filter(Boolean));
  const serials = collectSerials(prefix, suffix, ctx.existing ?? [], globalScope);
  const nextBase = serials.length ? Math.max(...serials) + step : start;

  const render = (n: number): string => {
    const ser = String(n).padStart(digits, '0');
    const body = [prefix, ser, suffix].filter((x) => x !== '').join(sep);
    return applyCase(body, rule.upperCase);
  };

  let serial = nextBase;
  let code = render(serial);
  if (rule.conflict === 'error') {
    if (used.has(code)) return { code: '', serial, groupKey, reason: `编号已存在（冲突策略=报错）：${code}` };
    return { code, serial, groupKey };
  }
  const retry = Math.max(0, Math.min(1000, Number(rule.conflictRetry) || 0));
  for (let i = 0; i <= retry && used.has(code); i += 1) {
    serial += step;
    code = render(serial);
  }
  if (used.has(code)) return { code: '', serial, groupKey, reason: `连续 ${retry} 个号都被占用：${code}` };
  return { code, serial, groupKey };
}

function applyCase(s: string, mode: CodeRule['upperCase']): string {
  if (mode === 'upper') return s.toUpperCase();
  if (mode === 'lower') return s.toLowerCase();
  return s;
}

// ══════════════════════════════════════════════════════════════
// 试算 / 预览（用**服务端同一份** generateCode，前端不许自己估算）
// ══════════════════════════════════════════════════════════════

export type CodeSample = { label: string; fields: Record<string, unknown> };

export type CodePreviewRow = {
  label: string;
  code: string;
  reason?: string;
  conflict: boolean;
};

/**
 * 用若干条样例试算。
 *
 * 🔴 后一条要把前一条生成的结果**累加进 `existing`**，否则"再一个"会跟第一条一样
 *    （预览里看到 `001`、`001` 会让人以为流水号坏了）。
 */
export function previewCodes(
  rule: CodeRule,
  samples: CodeSample[],
  existing: string[],
  nowMs: number,
): CodePreviewRow[] {
  const acc = [...(existing ?? [])];
  const out: CodePreviewRow[] = [];
  for (const s of samples) {
    const r = generateCode(rule, { nowMs, fields: s.fields ?? {}, existing: acc, randomSeed: `${s.label}|${nowMs}` });
    out.push({
      label: s.label,
      code: r.code,
      reason: r.reason,
      conflict: !!r.code && (existing ?? []).includes(r.code),
    });
    if (r.code) acc.push(r.code);
  }
  return out;
}

// ══════════════════════════════════════════════════════════════
// 归一化（逐项回落 + 钳制 + 去重，**永不抛错**）
// ══════════════════════════════════════════════════════════════

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function asString(v: unknown, dflt = ''): string {
  const s = String(v ?? '').trim();
  return s || dflt;
}
function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}
function pickFrom<T extends string>(v: unknown, allowed: readonly T[], dflt: T): T {
  const s = String(v ?? '').trim();
  return (allowed as readonly string[]).includes(s) ? (s as T) : dflt;
}
function stringMap(v: unknown): Record<string, string> {
  const src = asRecord(v);
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(src)) {
    const key = String(k ?? '').trim();
    if (!key) continue;
    out[key] = String(val ?? '');
  }
  return out;
}

export function normalizeSegment(input: unknown): CodeSegment {
  const s = asRecord(input);
  const kind = pickFrom(s.kind, CODE_SEGMENT_KINDS, 'text');
  if (kind === 'date') return { kind: 'date', format: pickFrom(s.format, CODE_DATE_FORMATS, 'year4') };
  if (kind === 'field') {
    return {
      kind: 'field',
      field: asString(s.field),
      transform: pickFrom(s.transform, CODE_FIELD_TRANSFORMS, 'raw'),
      map: stringMap(s.map),
      mapMatch: pickFrom(s.mapMatch, CODE_MAP_MATCHES, 'exact'),
    };
  }
  if (kind === 'serial') {
    return {
      kind: 'serial',
      // 3~6 位够用；允许 1 位（虽然难看）但钳住上限，避免生成 20 位号
      digits: clampInt(s.digits, 1, 10, 3),
      start: clampInt(s.start, 0, 9_999_999, 1),
      step: clampInt(s.step, 1, 1000, 1),
      cycle: pickFrom(s.cycle, CODE_RESET_CYCLES, 'term'),
      scope: pickFrom(s.scope, CODE_RESET_SCOPES, 'prefix'),
      scopeField: asString(s.scopeField),
    };
  }
  if (kind === 'random') {
    const charset = asString(s.charset, 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789').replace(/[^A-Za-z0-9]/g, '');
    return {
      kind: 'random',
      length: clampInt(s.length, 1, 12, 4),
      charset: charset || 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
    };
  }
  return { kind: 'text', value: asString(s.value) };
}

export function normalizeCodeRule(input: unknown, fallback?: CodeRule): CodeRule {
  const r = asRecord(input);
  const fb = fallback ?? DEFAULT_STUDENT_NO_RULE;
  const segs = Array.isArray(r.segments) ? r.segments : undefined;
  const normalizedSegs = segs ? segs.map(normalizeSegment) : fb.segments.map((x) => ({ ...x }));
  return {
    key: asString(r.key, fb.key),
    name: asString(r.name, fb.name),
    targetTable: asString(r.targetTable, fb.targetTable),
    // ⚠️ 字段真名带全角括号，`trim` 不能把括号里的空格当无意义清掉，所以只 trim 首尾
    targetField: asString(r.targetField, fb.targetField),
    enabled: typeof r.enabled === 'boolean' ? r.enabled : fb.enabled,
    // 🔴 至少要有 1 个段：空段列表会生成空编号（比报错更糟 —— 静默写空值）
    segments: normalizedSegs.length ? normalizedSegs : fb.segments.map((x) => ({ ...x })),
    separator: asString(r.separator),
    upperCase: pickFrom(r.upperCase, ['upper', 'lower', 'keep'] as const, fb.upperCase),
    conflict: pickFrom(r.conflict, CODE_CONFLICT_STRATEGIES, fb.conflict),
    conflictRetry: clampInt(r.conflictRetry, 0, 1000, fb.conflictRetry),
    note: asString(r.note, fb.note),
  };
}

/**
 * 归一化整份配置。
 *
 * 🔴 两条约束：
 *   ① **逐项回落**：读坏的配置必须还能工作（页面打不开比配置回滚更糟）
 *   ② **按 key 去重**：同一目标字段配两条规则 ⇒ 生成时不知道该用哪条，
 *      而这种冲突**不会报错**，只会"有时是 A、有时是 B"。以后来的覆盖先来的。
 *   ③ 缺的默认规则**补回来**（有人删了学籍号规则 ⇒ 新建学生就不会有学籍号，
 *      而学籍号是登录凭证 —— 这是"静默功能消失"，比报错难查得多）
 */
export function normalizeCodeRuleConfig(input: unknown, fallback: CodeRuleConfig = DEFAULT_CODE_RULE_CONFIG): CodeRuleConfig {
  const raw = asRecord(input);
  const list = Array.isArray(raw.rules) ? raw.rules : fallback.rules;
  const byKey = new Map<string, CodeRule>();
  for (const item of list) {
    const itemKey = asString(asRecord(item).key);
    const fb = fallback.rules.find((x) => x.key === itemKey);
    const rule = normalizeCodeRule(item, fb);
    if (!rule.key) continue;
    byKey.set(rule.key, rule);
  }
  for (const fb of fallback.rules) if (!byKey.has(fb.key)) byKey.set(fb.key, { ...fb, segments: fb.segments.map((x) => ({ ...x })) });
  return { rules: [...byKey.values()] };
}

/** 配置里有没有"同一目标字段配了两条启用规则"（保存前提示用） */
export function codeRuleConflicts(config: CodeRuleConfig): string[] {
  const seen = new Map<string, string>();
  const out: string[] = [];
  for (const r of config?.rules ?? []) {
    if (!r.enabled) continue;
    const k = `${r.targetTable}::${r.targetField}`;
    const prev = seen.get(k);
    if (prev) out.push(`${k} 同时被「${prev}」与「${r.name}」两条启用规则占用`);
    else seen.set(k, r.name);
  }
  return out;
}

/** 找某张表某个字段的启用规则 */
export function codeRuleFor(config: CodeRuleConfig, table: string, field: string): CodeRule | null {
  return (
    (config?.rules ?? []).find((r) => r.enabled && r.targetTable === table && r.targetField === field) ?? null
  );
}

/** 按规则 key 取（页面编辑用，含停用的） */
export function codeRuleByKey(config: CodeRuleConfig, key: string): CodeRule | null {
  return (config?.rules ?? []).find((r) => r.key === key) ?? null;
}

/** 把某个字段的现有值集合 + 规则 ⇒ 试算（服务端接口与前端预览共用同一入口） */
export function existingValuesOf(records: Record<string, unknown>[], field: string): string[] {
  return (records ?? []).map((r) => String(r?.[field] ?? '').trim()).filter(Boolean);
}

// ══════════════════════════════════════════════════════════════
// 菜单可见性
// ══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════
// 接口 DTO（前后端共用同一份，别在 web/api.ts 或 service 里再写一遍结构）
// ══════════════════════════════════════════════════════════════

export type CodePreviewItem = { label: string; code: string; reason?: string; conflict: boolean };

/** 一条规则 + 它自己那份试算结果与现有值 */
export type CodeRuleRow = CodeRule & {
  preview: CodePreviewItem[];
  /** 目标字段当前有值的记录数 */
  existingCount: number;
  /** 目标字段当前的取值样例（前 8 个）—— 配规则时要照着现有格式配 */
  existingSamples: string[];
};

export type CodeRulesView = {
  rules: CodeRuleRow[];
  /** 同一目标字段被多条启用规则占用时的提示（保存前要看到） */
  conflicts: string[];
  /** 规则里用到的「记录字段」的真实取值分布（映射候选，带出现次数） */
  fieldValues: Record<string, { value: string; count: number }[]>;
  meta: {
    segmentKinds: { value: string; label: string }[];
    dateFormats: { value: string; label: string }[];
    fieldTransforms: { value: string; label: string }[];
    mapMatches: { value: string; label: string }[];
    resetCycles: { value: string; label: string }[];
    resetScopes: { value: string; label: string }[];
    conflicts: { value: string; label: string }[];
    targets: typeof CODE_RULE_TARGETS;
    /** 「取自记录字段」段可选的字段名（运行期真实字段名） */
    fields: string[];
  };
};

export type CodeFillRow = { id: string; name: string; code: string; reason?: string };

export type CodeFillPreview = {
  field: string;
  /** 该字段当前已有值的条数 */
  existingCount: number;
  /** 已有值而被跳过的条数（只补空，不动已有值） */
  skipped: number;
  /**
   * 🔴 **能补的条数**（= `rows` 里 `code` 非空的那部分）。
   *
   * 页面上的「需要补 N 条」和按钮文案必须用这个数，**不能用 `rows.length`** ——
   * `rows` 里还含着"必需字段为空 ⇒ 生成不出来"的行（带 `reason`），
   * 按 `rows.length` 显示会承诺一个写不进去的条数（2026-10-01 实测：84 人里
   * 2 人缺「入学年级」，页面会写"需要补 2 条"，实际一条都不会写）。
   */
  fillable: number;
  /** 缺必需输入而**生成不出来**的条数（这些行在 `rows` 里 `code` 为空、带 `reason`） */
  blocked: number;
  rows: CodeFillRow[];
  samples: CodeFillRow[];
};

/**
 * 菜单 key（与 `homepage.ts` 的 `DEFAULT_NAV_MENU_CONFIG` 里那条同名）。
 *
 * ⚠️ 菜单项的 `perm` 留空 ⇒ 可见性收口在 `AppShell` 的 `codeRulesVisible()`
 *   （不能靠菜单白名单：`legacyRead: null` 的资源本来就不在白名单里）。
 */
export const CODE_RULES_MENU_KEY = 'codeRules';

/**
 * 「代码规则」菜单是否可见。
 *
 * 与 `studentSupportConfigVisible` / `weilingMappingVisible` 同一套做法：
 * `menuPermission` 为 `null`（不随迁移发放）⇒ 必须靠**显式判据**（有权限点才显示），
 * 否则这个菜单会对所有人显示、点进去 403。
 */
export function codeRulesVisible(perms: string[]): boolean {
  return (perms ?? []).includes('module:codeRules:read');
}
