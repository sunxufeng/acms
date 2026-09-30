/**
 * 「卫瓴映射」配置：卫瓴侧取值 → 学生档案选项的对应关系（**前后端共用一份**）。
 *
 * ── 需求（2026-09-30 峰哥）────────────────────────────────────────
 *   「卫瓴 18 种或者更多的来源渠道 → 档案 4 个选项或者更多的对应关系做成可配置的页面，
 *     放到后台管理里，菜单名称叫"卫瓴映射"」
 *
 * ── 为什么单开一个配置，而不是把映射表写死在 `weiling-enroll.ts` ──────────
 *   原来 `WEILING_SCHOOL_TYPE_MAP` / `WEILING_PLANNED_TERM_MAP` 是模块级 `const`，
 *   而「来源渠道」「生源跟进状态」干脆没映射（转档时留空 + 写理由）。
 *   但这两栏的口径**只有招生老师知道**（「活动-公众号」到底算官网还是活动招募？），
 *   写死在代码里就变成"每次都要找人改代码 + 重新部署"。
 *
 * ── 🔴 设计要点（照 `SupportSignalConfig` 的范式）────────────────────
 *   ① 判据参数化 + **默认值 = 原常量** ⇒ `buildEnrollDraft(ctx, mapping?)` 第三参可选，
 *      老调用点/老测试一行不改、零行为变化。
 *   ② `normalizeWeilingMappingConfig()` **逐项回落 + 丢弃非法项，永不抛错**
 *      —— 配置读坏了必须还能转档，不能整页 500。
 *   ③ **存进去的就是生效的那份**（保存前先归一化），否则界面显示的与判据用的会不一致。
 *   ④ 必配**试算**：用提交的配置跑全站联系人，看"这样配能填上多少条 / 还有哪些取值没配"。
 *
 * ── ⚠️ 口径提醒（2026-09-30 实测纠正，之前的设计文档抄的是过期快照）────────
 *   学生档案「来源渠道」的选项来自**字典**（`dict.data.ts` 种子），当前是 **8 项**：
 *     官网 / 转介绍 / 展会 / 社交媒体 / 代理 / 搜索引擎 / 开放日 / 其他
 *   （旧快照里的「官网咨询 / 活动招募」是**历史残留**，飞书字段选项只追加不删除。）
 *   「生源跟进状态」当前是 **6 项**：新线索 / 跟进中 / 已报名 / 已入学 / 已成交 / 已流失。
 *   ⇒ **别在代码里再抄一份选项清单**：本文件只声明"选项从哪个字典读"（`archiveDictKey`），
 *     真实候选由运行期从字典取（`GET /dictionaries`），这样老师改字典不会让映射失效。
 */

/** 映射表的键（每个键 = 一条「卫瓴字段 → 档案字段」的对应关系） */
export type WeilingMappingKey = 'channel' | 'stage' | 'schoolType' | 'plannedTerm' | 'payment';

export const WEILING_MAPPING_KEYS: readonly WeilingMappingKey[] = [
  'channel',
  'stage',
  'schoolType',
  'plannedTerm',
  'payment',
];

/**
 * 卫瓴侧「没在映射表里出现过」的值该归到哪。
 *
 * 为什么需要：卫瓴的来源渠道是**运营随手建**的（今天多了「小红书」，明天多了「视频号」），
 * 要求每条都配映射不现实；但又不能默认留空（那 18 种里没配的就全丢了）。
 * ⇒ 每个字段可给一个兜底选项，`''` = 不兜底（留空）。
 */
export interface WeilingMappingFallback {
  channel: string;
  stage: string;
  schoolType: string;
  plannedTerm: string;
  payment: string;
}

export interface WeilingMappingConfig {
  /** 卫瓴「来源渠道」（联系人表顶层列 `来源渠道`，如「活动-公众号」）→ 档案「来源渠道」 */
  channel: Record<string, string>;
  /** 卫瓴「客户阶段」（联系人表顶层列 `客户阶段`）→ 档案「生源跟进状态」 */
  stage: Record<string, string>;
  /** 卫瓴「原学校类型」（自定义字段 `yxxlx`）→ 档案「原学校类型」 */
  schoolType: Record<string, string>;
  /** 卫瓴「计划入读致极学院时间」（自定义字段 `jxrdzjxysj`）→ 档案「入学年月」 */
  plannedTerm: Record<string, string>;
  /** 卫瓴「缴费情况」（自定义字段 `jfqk`）→ 档案「付款状态」 */
  payment: Record<string, string>;
  fallback: WeilingMappingFallback;
}

/**
 * 每条映射关系的元信息。
 *
 * 🔴 **只此一份**：页面渲染左列（卫瓴取值）与右列（档案选项）都从它来；
 *    `buildEnrollDraft` 也用同一个 `key` 去查配置。
 *    另写一份清单必然漂移（改了字段名不报错，只是那条映射静默失效）。
 */
export interface WeilingMappingFieldMeta {
  key: WeilingMappingKey;
  /** 卫瓴侧字段的中文名（页面左列标题） */
  weilingLabel: string;
  /** 卫瓴侧取值从哪来（写清"列名"还是"自定义字段 api_name"，排查时要用） */
  weilingSource: string;
  /** 学生档案的目标字段名（= 数据 key） */
  archiveField: string;
  /** 目标字段的选项读哪个字典（`''` = 该字段选项不是字典，用下面的 `archiveValues`） */
  archiveDictKey: string;
  /** 目标字段的选项（`archiveDictKey` 为空时用；非空时作为字典读不到时的兜底） */
  archiveValues: readonly string[];
  /** 页面上的一句说明 */
  hint: string;
}

export const WEILING_MAPPING_FIELDS: readonly WeilingMappingFieldMeta[] = [
  {
    key: 'channel',
    weilingLabel: '来源渠道',
    weilingSource: '联系人表顶层列「来源渠道」（上游算好的完整层级名，如「活动-公众号」）',
    archiveField: '来源渠道',
    archiveDictKey: '来源渠道',
    archiveValues: ['官网', '转介绍', '展会', '社交媒体', '代理', '搜索引擎', '开放日', '其他'],
    hint: '卫瓴的渠道是运营随手建的（会一直增加），配上映射后转档时会自动填；没配的走「兜底」。',
  },
  {
    key: 'stage',
    weilingLabel: '客户阶段',
    weilingSource: '联系人表顶层列「客户阶段」（潜在客户 / 适龄客户 / 面访 / 面试 / 成交客户…）',
    archiveField: '生源跟进状态',
    archiveDictKey: '生源跟进状态',
    archiveValues: ['新线索', '跟进中', '已报名', '已入学', '已成交', '已流失'],
    hint: '两边的"阶段"含义不同（卫瓴是销售漏斗、档案是招生进度），请按你对业务的理解配。',
  },
  {
    key: 'schoolType',
    weilingLabel: '原学校类型',
    weilingSource: '自定义字段 yxxlx（体制内 / 国际课程 / homeschool 或 休学 / 海外回国 / 创新学校 / 其他）',
    archiveField: '原学校类型',
    archiveDictKey: '',
    archiveValues: ['国际学校', '体制内学校'],
    hint: '档案这一栏只有两个选项，「homeschool / 海外回国 / 创新学校」卫瓴有、档案没有 ⇒ 只能留空或兜底。',
  },
  {
    key: 'plannedTerm',
    weilingLabel: '计划入读时间',
    weilingSource: '自定义字段 jxrdzjxysj（2025年秋季学期 / 2026年春季学期 / 2026年秋季或后 / 其它）',
    archiveField: '入学年月',
    archiveDictKey: '入学年月',
    archiveValues: [
      '21春季', '21秋季', '22春季', '22秋季', '23春季', '23秋季', '24春季', '24秋季',
      '25春季', '25秋季', '26春季', '26秋季', '27春季', '27秋季', '28春季', '28秋季',
    ],
    hint: '卫瓴只到学期、还有「秋季或后」这种模糊值 ⇒ 转档时仍会要求人工确认。',
  },
  {
    key: 'payment',
    weilingLabel: '缴费情况',
    weilingSource: '自定义字段 jfqk（是 / 否）',
    archiveField: '付款状态',
    archiveDictKey: '',
    archiveValues: ['未付款', '已付款'],
    hint: '卫瓴这一栏全库只有个位数有值，配了也基本用不上。',
  },
];

/**
 * 出厂默认映射 —— **等于原代码里写死的那两张表**（零行为变化）。
 *
 * 🔴 「来源渠道」「生源跟进状态」默认为**空**：它们原来就是"不填 + 写理由"，
 *    默认空 ⇒ 上线后行为不变，等招生老师在页面上配好才生效。
 *    这也是「默认值 = 原常量」这条规矩的直接体现 —— 别在默认值里偷偷填上猜测的映射。
 */
export const DEFAULT_WEILING_MAPPING_CONFIG: WeilingMappingConfig = {
  channel: {},
  stage: {},
  schoolType: {
    体制内: '体制内学校',
    国际课程: '国际学校',
  },
  plannedTerm: {
    '2025年秋季学期': '25秋季',
    '2026年春季学期': '26春季',
    '2026年秋季或后': '26秋季',
    // 🔴 `其它` 显式留空：它表示"这条**故意不映射**"（卫瓴这一档是模糊值），
    //    与"还没配"是两件事 —— 页面上要能把两者区分开，所以必须留这个键。
    //    （第一版把它漏了，被"默认值 == 原常量"那条断言抓到。）
    其它: '',
  },
  payment: {
    是: '已付款',
    否: '未付款',
  },
  fallback: {
    channel: '',
    stage: '',
    schoolType: '',
    plannedTerm: '',
    payment: '',
  },
};

/** 映射表里一项：卫瓴取值 → 档案取值 */
export interface WeilingMappingEntry {
  /** 卫瓴侧的原始取值（界面上显示给老师看） */
  from: string;
  /** 档案侧的目标取值（`''` = 不映射 / 留空） */
  to: string;
  /** 生产库里该取值出现过多少条（页面按它排序，让老师先配高频的） */
  count: number;
}

/** 一条映射关系的页面数据 */
export interface WeilingMappingFieldView {
  key: WeilingMappingKey;
  weilingLabel: string;
  weilingSource: string;
  archiveField: string;
  /** 目标字段的**运行期**选项（来自字典；字典读不到时回落 `archiveValues`） */
  archiveOptions: string[];
  hint: string;
  fallback: string;
  /** 卫瓴侧出现过的取值 + 已配的映射 + 出现条数（按条数降序） */
  entries: WeilingMappingEntry[];
  /** 生产库里出现过、但配置里没配、且没兜底的取值（页面标红提醒） */
  unmapped: string[];
  /** 库里已有取值总量（用于算"配了多大比例"） */
  total: number;
  /** 已配到值的条数 */
  mapped: number;
}

/** 读配置接口的返回 */
export interface WeilingMappingResult {
  config: WeilingMappingConfig;
  defaults: WeilingMappingConfig;
  fields: WeilingMappingFieldView[];
  /** 与默认值不同的键（页面顶部提示"已自定义 N 项"） */
  changed: string[];
  /** 从任意字段（含 `fallback`）引用的、档案里不存在的选项（页面标红） */
  invalid: string[];
  /** 出现条数最多的前 N 个未配卫瓴取值（提示优先配这些） */
  topUnmapped: { key: WeilingMappingKey; from: string; count: number }[];
}

// ══════════════════════════════════════════════════════════════
// 归一化与判据（纯函数，前后端共用）
// ══════════════════════════════════════════════════════════════

function cleanMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const from = String(k ?? '').trim();
    if (!from) continue; // 空键没有意义
    // ⚠️ 值可以是 `''`（= 故意不映射，比如「homeschool 在档案里没有对应项」）
    out[from] = v == null ? '' : String(v).trim();
  }
  return out;
}

/**
 * 把任意来路不明的值归一化成一份**一定能用**的映射配置。
 *
 * 🔴 逐项回落 + 丢弃空键，**永不抛错**（配置读坏了要能继续转档，而不是整页 500）。
 * 🔴🔴 **「未传的子映射」保留默认，「显式传空对象」才真的清空** —— 这是本仓
 *    「未传的字段不动」那条规矩在配置上的应用：
 *      · 老版本的配置行里没有 `schoolType` ⇒ 应该继续用出厂的「体制内→体制内学校」，
 *        而不是把它悄悄抹成空（那会让转档**少填一栏且不报错**）。
 *      · 老师想把某张表清空 ⇒ 前端传 `{ schoolType: {} }`，此时确实清空。
 *    ⚠️ 第一版写成「一律 `cleanMap(src[key])`」，被自己的测试抓到了：
 *      垃圾输入会把 `plannedTerm` / `payment` 也清空 ⇒ 转档静默少填两栏。
 * 🔴 只做结构层面的归一化，**不做"目标值是否合法"的判断** ——
 *    那需要运行期的字典（服务端才知道），由 `weilingMappingInvalid()` 单独报出来。
 *    在这里悄悄丢掉非法项会让"我明明配了"变成查不出来的事。
 */
export function normalizeWeilingMappingConfig(raw: unknown): WeilingMappingConfig {
  const d = DEFAULT_WEILING_MAPPING_CONFIG;
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const fbSrc = (src['fallback'] && typeof src['fallback'] === 'object' ? src['fallback'] : {}) as Record<
    string,
    unknown
  >;
  const fb = { ...d.fallback };
  for (const k of WEILING_MAPPING_KEYS) {
    const v = fbSrc[k];
    if (typeof v === 'string') fb[k] = v.trim();
    // ⚠️ 缺省（`undefined`）时**保留默认值**，而不是清空（同上：未传的不动）
  }
  /** 某个子映射：键不存在 ⇒ 用默认；存在 ⇒ 用它（空对象 = 显式清空） */
  const pick = (key: WeilingMappingKey): Record<string, string> =>
    Object.prototype.hasOwnProperty.call(src, key) ? cleanMap(src[key]) : { ...d[key] };
  return {
    channel: pick('channel'),
    stage: pick('stage'),
    schoolType: pick('schoolType'),
    plannedTerm: pick('plannedTerm'),
    payment: pick('payment'),
    fallback: fb,
  };
}

/** 与默认值不同的键名（含 `fallback.<key>`），页面据此显示"已自定义 N 项" */
export function weilingMappingChangedKeys(config: WeilingMappingConfig): string[] {
  const d = DEFAULT_WEILING_MAPPING_CONFIG;
  const out: string[] = [];
  for (const k of WEILING_MAPPING_KEYS) {
    if (JSON.stringify(config[k]) !== JSON.stringify(d[k])) out.push(k);
    if ((config.fallback[k] ?? '') !== (d.fallback[k] ?? '')) out.push(`fallback.${k}`);
  }
  return out;
}

/**
 * 查出配置里引用的、**目标字段的选项里不存在**的值。
 *
 * 为什么要单独报（而不是归一化时静默丢掉）：写一个选项外的值，界面上会显示成
 * "这个字段没值"，比留空更难查（2026-09-30 卫瓴年级 G1–G12 那次教训）。
 * ⇒ 存的时候允许存（老师可能先把选项加上），但**页面必须标红让人看见**。
 */
export function weilingMappingInvalid(
  config: WeilingMappingConfig,
  options: Partial<Record<WeilingMappingKey, readonly string[]>>,
): string[] {
  const out: string[] = [];
  for (const k of WEILING_MAPPING_KEYS) {
    const allowed = options[k];
    if (!allowed || !allowed.length) continue;
    const set = new Set(allowed);
    for (const [from, to] of Object.entries(config[k])) {
      if (to && !set.has(to)) out.push(`${k}：「${from}」映射到「${to}」，但「${to}」不在档案选项里`);
    }
    const fb = config.fallback[k];
    if (fb && !set.has(fb)) out.push(`${k}：兜底值「${fb}」不在档案选项里`);
  }
  return out;
}

/**
 * 取一个卫瓴取值最终该写进档案的值。
 *
 * 顺序：**精确映射 → 兜底 → 空**。
 * ⚠️ 精确映射命中但值是 `''` 时**不再回落兜底** —— 那是老师显式写的"这条就是不映射"
 *    （比如「homeschool」档案里没有对应项，且不想被兜底成「其他」）。
 */
export function weilingMappedValue(
  config: WeilingMappingConfig,
  key: WeilingMappingKey,
  weilingValue: string,
): { value: string; via: 'exact' | 'fallback' | 'none' } {
  const from = String(weilingValue ?? '').trim();
  if (from && Object.prototype.hasOwnProperty.call(config[key], from)) {
    return { value: config[key][from] ?? '', via: 'exact' };
  }
  const fb = config.fallback[key] ?? '';
  if (fb) return { value: fb, via: 'fallback' };
  return { value: '', via: 'none' };
}

/**
 * 试算：拿一组「卫瓴取值 → 出现条数」算这套配置能填上多少条。
 *
 * 🔴 纯函数，且**必须拿生产真实的取值分布来跑**（服务端从库里 distinct 出来传进来），
 *    这样试算结果与配置生效后的实际效果必然一致 —— 不许前端估。
 * 🔴 不知道条数的取值按 0 计（老师手工添加的候选），照样算"配上了没"。
 */
export function weilingMappingTally(
  config: WeilingMappingConfig,
  distribution: Partial<Record<WeilingMappingKey, { value: string; count: number }[]>>,
): { key: WeilingMappingKey; total: number; mapped: number; unmapped: string[] }[] {
  return WEILING_MAPPING_KEYS.map((key) => {
    const rows = distribution[key] ?? [];
    let total = 0;
    let mapped = 0;
    const unmapped: string[] = [];
    for (const r of rows) {
      const n = Number.isFinite(r.count) ? Math.max(0, Math.trunc(r.count)) : 0;
      total += n;
      const hit = weilingMappedValue(config, key, r.value);
      if (hit.value) mapped += n;
      else if (n > 0) unmapped.push(r.value);
    }
    return { key, total, mapped, unmapped };
  });
}

/** 把分布按条数降序排，并合并重复取值（库里大小写/空白差异会造出重复项） */
export function weilingValueDistribution(
  rows: { value: unknown; count: unknown }[],
): { value: string; count: number }[] {
  const acc = new Map<string, number>();
  for (const r of rows) {
    const v = String(r.value ?? '').trim();
    if (!v) continue; // 空值不进候选（"没填"不是一个可映射的取值）
    const n = Number(r.count);
    acc.set(v, (acc.get(v) ?? 0) + (Number.isFinite(n) ? Math.trunc(n) : 0));
  }
  return [...acc.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, 'zh'));
}

// ══════════════════════════════════════════════════════════════
// 菜单与可见性（与「信号规则」`supportConfigVisible` 同款做法）
// ══════════════════════════════════════════════════════════════

/** 菜单项的 key（`homepage.ts` 的 `DEFAULT_NAV_MENU_CONFIG` 与 `AppShell` 都用它） */
export const WEILING_MAPPING_MENU_KEY = 'weilingMapping';

/**
 * 能看「卫瓴映射」页 = 持有 `module:weilingMapping:read`。
 *
 * 🔴 为什么不吃菜单白名单：菜单项的 `perm` 留空（见 `homepage.ts`），
 *    可见性一律收口到这个判据 —— 与 `supportConfigVisible` 一致。
 *    好处是"配了权限点就能看见"，不会出现"权限全绿但菜单不显示"那种三道闸的排查。
 */
export function weilingMappingVisible(perms: readonly string[] | undefined | null): boolean {
  return Boolean(perms?.includes('module:weilingMapping:read'));
}
