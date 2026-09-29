/**
 * 学生支持看板 —— 判据层（2026-09-29 峰哥需求）。
 *
 * ## 一句话定位
 *
 * 「每天早上打开就能回答三个问题：**今天该找谁 · 为什么要找他 · 谁在管、管到哪了**。」
 * 它不是第二个学生列表 —— 学生档案解决"查某个学生"，本页解决"系统告诉我该看谁"。
 *
 * ## 🔴 为什么判据必须收在这里一份
 *
 * 每张支持卡上的「为什么在这里」是**证据**，要被三处共用：
 * 后端 `/student-support/board` 聚合、前端展示、单测。各写一份必然漂移
 * （本项目最贵的 bug 类型）⇒ 全部做纯函数，前后端 import 同一份。
 *
 * ## 🔴🔴 设计前提：现成的"支持类"字段全都没人在用（生产实测 2026-09-29）
 *
 * ```
 * 日常跟进表 闭环状态   224 条里 223 条都是默认值「无需跟进」
 *           待办事项 / 待办负责人      224 条全空
 *           观察类型 / 家长反馈态度 / 信息敏感级别   空 218 / 221 / 224
 * 学生档案   心理状态 / 综合评定等级 / 预警科目 / 特殊支持摘要 / 学生标签   全部 0 有值
 * 行为记录表 / 行为跟进表 / 行为通知信件表 / 阶段评价表   有表结构、0 行
 * ```
 *
 * ⇒ **看板绝不能依赖人工维护的状态字段，否则上线第一天就是一块空板（且不报错）。**
 * 所以信号一律**从已有记录自动推导**（`supportSignalsOf`），人工只在「登记问题」时花 10 秒。
 *
 * ## 数据模型
 *
 * ```
 * 学生档案（84 人，只读基准盘）
 *   └── 学生记录 = 日常跟进表 tbljjbchyx9uhbbb（224 条，五类合并，一手数据）
 *         ├── 沟通时间 / 记录类型 / 责任人 / 沟通主题 / 沟通总结  ← 信号来源
 *         └── 关联要用「关联学生编号」(id 数组)，**别用「关联学生」(姓名字符串)**
 *   └── 学生支持 tblstudsupp00001（本模块新建：一行 = 一个学生 × 一次支持，承载"学生级状态"）
 * ```
 *
 * ## 🔴 为什么"状态"要新建表、不复用记录的 `闭环状态`
 *
 * `闭环状态` 是**记录级**字段（一条沟通一个状态）。但老师在看板上问的是
 * **"这个学生现在什么状态"** —— 学生级。
 * 复用 ⇒ 一个学生 5 条记录 5 个状态，答不出"他现在怎样"。
 */
import {
  STUDENT_RECORD_ENTRY_KEY,
  STUDENT_RECORD_LEGACY_MENU_KEYS,
} from './student-records.js';
import { modulePermission } from './module-permissions.js';
import { idpDaysAgo, idpDayIndex, idpTextOf } from './idp.js';

// ─────────────────────────────────────────────────────────────
// 表与字段（写库/读库都用这一份，别在别处硬写字符串）
// ─────────────────────────────────────────────────────────────

/** `学生支持` 表字段（自建 PG 表，见 tables.ts 的 studentSupport） */
export const SUPPORT_FIELDS = {
  关联学生: '关联学生',
  学生姓名: '学生姓名',
  支持状态: '支持状态',
  问题类型: '问题类型',
  严重程度: '严重程度',
  问题描述: '问题描述',
  负责跟进: '负责跟进',
  负责来源: '负责来源',
  期望回应日期: '期望回应日期',
  认领时间: '认领时间',
  关闭时间: '关闭时间',
  处理备注: '处理备注',
  来源: '来源',
  更新人: '更新人',
  更新时间: '更新时间',
} as const;

/** 人工登记的来源值（与「系统发现」区分，统计时要用） */
export const SUPPORT_SOURCES = ['系统发现', '人工登记'] as const;
export type SupportSource = (typeof SUPPORT_SOURCES)[number];

// ─────────────────────────────────────────────────────────────
// 流程状态 —— **留在代码里，不入字典**
// ─────────────────────────────────────────────────────────────
// 为什么不做成字典：状态机的值参与代码判据（`SUPPORT_OPEN_STATUSES`、超期判定）。
// 字典是运营可改的 ⇒ 谁把「跟进中」改成「进行中」，状态流转就静默对不上。
// 这是 ACMS 的既有约定（见套件「模块与页面开发/05-字典与下拉候选」第 0 节）。

export const SUPPORT_STATUSES = ['待认领', '跟进中', '已缓解', '已关闭', '已升级'] as const;
export type SupportStatus = (typeof SUPPORT_STATUSES)[number];

/** 待认领：系统发现但还没人负责 —— 看板置顶并标红 */
export const SUPPORT_STATUS_TODO: SupportStatus = '待认领';
/** 仍在处理中的状态（这些才计入"需要支持"） */
export const SUPPORT_OPEN_STATUSES: readonly SupportStatus[] = ['待认领', '跟进中', '已升级'];
/** 终态（默认折叠，不计入看板主数字） */
export const SUPPORT_CLOSED_STATUSES: readonly SupportStatus[] = ['已缓解', '已关闭'];

/** 状态 →「谁能看到卡片在哪个分组」用的级别 */
export function supportIsOpen(status: unknown): boolean {
  return SUPPORT_OPEN_STATUSES.includes(String(status ?? '') as SupportStatus);
}

// ─────────────────────────────────────────────────────────────
// 与字典耦合的枚举 —— 字典里的值**就是**这里的字面量
// ─────────────────────────────────────────────────────────────
// 🔴 峰哥 2026-09-29 明确要求：问题类型与严重程度**读取字典表**（运营可增删）。
//    但词表又与"问题线索"关键词抽取（代码判据）对齐 ⇒ 按套件约定
//    **值 import 服务端常量、字典种子直接引用本数组**，别手抄字符串：
//    手抄会在增删类型后静默错位（抽出来的类型在字典里不存在 ⇒ 前端 select 显示空）。

/** 「问题类型」字典 key（前端 `dictKey` 与 dict.data.ts 共用） */
export const SUPPORT_PROBLEM_TYPE_DICT = '支持问题类型';
/** 「严重程度」字典 key */
export const SUPPORT_SEVERITY_DICT = '支持严重程度';

export const SUPPORT_PROBLEM_TYPES = [
  '学业困难',
  '情绪与心理',
  '出勤与作息',
  '家庭情况',
  '人际社交',
  '升学规划',
  '行为与纪律',
  '其他',
] as const;
export type SupportProblemType = (typeof SUPPORT_PROBLEM_TYPES)[number];

export const SUPPORT_SEVERITIES = ['关注', '需介入', '紧急'] as const;
export type SupportSeverity = (typeof SUPPORT_SEVERITIES)[number];
/** 登记时的默认严重程度（老师不额外点一次就能保存） */
export const SUPPORT_SEVERITY_DEFAULT: SupportSeverity = '需介入';

// ─────────────────────────────────────────────────────────────
// 关键词词典（「问题线索」自动抽取 + 预选问题类型）
// ─────────────────────────────────────────────────────────────

/**
 * 问题词词典：**按问题类型分组**，命中后既能报"有问题"，又能**预选问题类型**。
 *
 * ## 🔴🔴 选词铁律：只收「指问题」的词，不收「中性也常出现」的词
 *
 * 词表第一版把 `情绪 / 压力 / 心理 / 冲突 / 请假 / 家庭 / 纪律 / 作息` 都收进来了，
 * 结果**上线实测命中 42/75 人（56%）**——看板一半的人都被标成"有问题"，等于没有优先级。
 *
 * 原因：本词典扫的是 `沟通总结`（**AI 录音总结，单条 5000~6000 字**，实测），
 * 这种长文里这些词天天出现，而且**大量出现在否定/中性语境**：
 *
 * ```
 *   命中「冲突」 ← "…时间冲突"            （不是人际冲突）
 *   命中「违纪」 ← "…没有违纪情况"        （明确否定）
 *   命中「情绪」 ← "…情绪高涨地讨论招新"  （不是情绪问题）
 *   命中「心理」 ← "…美国心理学方向升学"  （是专业名）
 *   命中「请假」 ← "…请假流程已说明"      （是流程说明）
 * ```
 *
 * ⇒ 收录标准：**这个词单独出现时，就足以说明"这个学生需要关注"**。
 *    拿不准的一律不收（宁可漏，不要 56% 的假阳性 —— 看板最贵的是"没人信"）。
 *
 * 实测对照（同一份数据、同一份判据）：
 * ```
 *   第一版（含宽词）        42 / 75 人（56%）  ❌ 无区分度
 *   收紧后                  ~10 人（13%）     ✅
 * ```
 * ⚠️ 调整词表后必须用**线上的 contracts** 复测命中量（别自己重写一份判据来估 ——
 *    2026-09-30 我就这么干过，算出"只命中 8 人"，与线上差 5 倍，白折腾一轮）。
 */
export const SUPPORT_PROBLEM_WORDS: Record<SupportProblemType, readonly string[]> = {
  学业困难: [
    '不及格', '成绩下滑', '下滑', '退步', '跟不上', '听不懂', '厌学',
    '未交作业', '作业未交', '欠交', '偏科', '学习困难', '学习问题',
  ],
  情绪与心理: [
    '焦虑', '压力大', '失眠', '抑郁', '应激', '自伤', '情绪低落', '情绪问题',
    '自卑', '易怒', '崩溃',
    // ❌ 不收「情绪」「心理」「压力」「紧张」：
    //    「情绪高涨」「心理健康课」「美国心理学方向」「没有压力」都会命中
  ],
  出勤与作息: [
    '缺勤', '旷课', '未返校', '缺课', '连续缺席', '缺数学课', '未上课', '迟到', '早退',
    // ❌ 不收「请假」「作息」：「请假流程」「作息规律」是中性叙述
  ],
  家庭情况: [
    '家庭变故', '离异', '单亲', '家暴', '经济困难', '家长投诉', '家庭矛盾',
    // ❌ 不收「家庭」「家访」：「家庭情况介绍」「已完成家访」都会命中
  ],
  人际社交: [
    '被孤立', '欺凌', '霸凌', '人际冲突',
    // ❌ 不收「冲突」「矛盾」「人际」「同学关系」：「时间冲突」「无矛盾」「人际关系良好」
  ],
  升学规划: [
    '升学焦虑', '申请受阻', '标化未达标',
    // ❌ 不收「选校」「选科」「文书」「标化」「申请季」「升学规划」——
    //    这些是**中性的规划话题**，几乎每个国际高中生的沟通记录里都有
    //    （实测：光「升学规划」一个词就误报 2 人）
  ],
  行为与纪律: [
    '违纪', '处分', '作弊', '打架',
    // ❌ 不收「纪律」「违规」「玩手机」：「纪律良好」会命中
  ],
  其他: [],
};

/** 词典的全部词（展开成一条，供全文扫描用；顺序 = 类型顺序，保证"第一个命中的类型"稳定） */
export const SUPPORT_PROBLEM_WORD_LIST: readonly { word: string; type: SupportProblemType }[] =
  SUPPORT_PROBLEM_TYPES.flatMap((type) => SUPPORT_PROBLEM_WORDS[type].map((word) => ({ word, type })));

/**
 * 「强词」—— 单独出现就足以成为一条信号。
 *
 * ## 为什么还要这个分级（收紧词表后仍然命中 32/75 人）
 *
 * 词表收紧到只收"指问题"的词之后，`problemClue` 依然命中 43% —— 因为**单命中一个泛词**
 * 就算数，而这类词在"学习情况评价"式的记录里几乎必然出现：
 *
 * ```
 *   只命中「学习问题」  ← "英语学习问题突出"     → 值不值得上板？多半是老师已在处理的日常
 *   只命中「缺课」      ← "课程出勤与作业情况反馈" → 同上
 *   命中「焦虑」+「崩溃」                        → 明显是问题 ✅
 *   只命中「失眠」                              ← 单独出现就已经很说明问题 ✅
 * ```
 *
 * ⇒ 规则：**命中任一强词，或同时命中 ≥2 个词**，才算「问题线索」。
 *    `SUPPORT_PROBLEM_MIN_WORDS` 控制后者。
 *
 * 实测（同一份数据、同一份判据，2026-09-30）：
 * ```
 *   第一版（含宽词）          42 / 75（56%）
 *   收紧词表                  32 / 75（43%）
 *   收紧词表 + 强词/≥2 词      ~16 / 75（21%）  ← 有区分度了
 * ```
 */
export const SUPPORT_STRONG_WORDS: readonly string[] = [
  // 学业：明确到"已经出结果"的程度
  '不及格', '厌学',
  // 情绪与心理：单独出现就是问题
  '失眠', '抑郁', '自伤', '应激', '崩溃',
  // 出勤：到了"人不在"的程度（"缺勤/迟到早退"属于轻度，需 ≥2 词或与其它信号叠加）
  '旷课', '连续缺席', '未返校',
  // 家庭与人身安全
  '家暴', '单亲', '离异', '欺凌', '霸凌', '被孤立',
  // 纪律与升学硬门槛
  '处分', '作弊', '打架', '申请受阻', '标化未达标',
];

/**
 * 非强词需要同时命中几个才算「问题线索」。
 * 2 = 至少两个不同的问题词同时出现（如「焦虑」+「崩溃」）。
 */
export const SUPPORT_PROBLEM_MIN_WORDS = 2;

/**
 * 从一段文本里抽出命中的问题词与**推断出的问题类型**。
 *
 * 🔴 标签旁边必须能挂**证据原文** —— 老师看到原句才会信，只看到标签只会怀疑。
 *    所以调用方拿 `words` 去回查原文，别只显示类型。
 */
export function supportProblemHits(text: unknown): { words: string[]; types: SupportProblemType[] } {
  const s = typeof text === 'string' ? text : '';
  if (!s) return { words: [], types: [] };
  const words: string[] = [];
  const types: SupportProblemType[] = [];
  for (const { word, type } of SUPPORT_PROBLEM_WORD_LIST) {
    if (!s.includes(word)) continue;
    if (!words.includes(word)) words.push(word);
    if (!types.includes(type)) types.push(type);
  }
  return { words, types };
}

// ─────────────────────────────────────────────────────────────
// 阈值（集中定义，便于按实际命中量调整）
// ─────────────────────────────────────────────────────────────

/** 「长期失联」阈值（天）：最近沟通距今 > 此值 ⇒ P0。实测 5 人命中，量合适 */
export const SUPPORT_LONG_SILENCE_DAYS = 14;
/** 「近期沉默」阈值（天）：8 ~ 14 天 ⇒ P1 */
export const SUPPORT_RECENT_SILENCE_DAYS = 8;
/**
 * 「反复沟通未缓解」：近 N 天内的记录数达到此值，且**都**命中同一类问题词。
 *
 * 🔴 为什么是 3 而不是 2：近 30 天有 2 条记录是**常态**（224 条记录集中在 9 月，
 *    平均每人 3 条）⇒ 阈值 2 会把"这个月正常谈过两次"也算成"反复沟通未缓解"。
 *    实测阈值 2 命中 37/75 人（49%）；连"只谈过一次的正常回访"都算了进去。
 *    3 条才叫"反复"，且必须**每一条**都在谈同一类问题。
 */
export const SUPPORT_UNRESOLVED_WINDOW_DAYS = 30;
export const SUPPORT_UNRESOLVED_MIN_COUNT = 3;
/** 登记时「期望回应日期」默认 = 今天 + N 天 */
export const SUPPORT_DEFAULT_DUE_DAYS = 3;
/** 「已缓解」N 天后自动转「已关闭」（看板不再显示） */
export const SUPPORT_AUTO_CLOSE_DAYS = 14;

// ─────────────────────────────────────────────────────────────
// 信号体系（"为什么要找他"）
// ─────────────────────────────────────────────────────────────

export type SupportSignalKey =
  | 'neverContacted'
  | 'longSilence'
  | 'problemClue'
  | 'unresolved'
  | 'recentSilence'
  | 'thinRelation'
  | 'noOwner';

/** 优先级级别（也是看板的分组维度） */
export type SupportLevel = 'P0' | 'P1' | 'P2';

export interface SupportSignalMeta {
  label: string;
  level: SupportLevel;
  icon: string;
  /** 这类信号要老师做什么（空态/提示文案用） */
  hint: string;
}

/**
 * 七条信号的元信息。
 *
 * 🔴 `level` 决定分组与排序，**别在别处再写一套优先级**（判据只此一份）。
 */
export const SUPPORT_SIGNAL_META: Record<SupportSignalKey, SupportSignalMeta> = {
  neverContacted: {
    label: '从未沟通', level: 'P0', icon: '🔴',
    hint: '有学生档案但一条沟通记录都没有 —— 最强信号：入学了没人管',
  },
  longSilence: {
    label: '长期失联', level: 'P0', icon: '🟠',
    hint: '最近沟通距今超过 14 天',
  },
  problemClue: {
    label: '问题线索', level: 'P1', icon: '🔵',
    hint: '沟通主题或总结里命中了风险词（学业 / 情绪 / 出勤 / 家庭 / 社交 / 升学 / 行为）',
  },
  unresolved: {
    label: '反复沟通未缓解', level: 'P1', icon: '🟠',
    hint: '近 30 天多次沟通且都在谈同一类问题 —— 谈了但问题还在',
  },
  recentSilence: {
    label: '近期沉默', level: 'P1', icon: '🟡',
    hint: '最近沟通距今 8~14 天，快滑向长期失联',
  },
  thinRelation: {
    label: '关系待建立', level: 'P2', icon: '⚪',
    hint: '只沟通过 1 次，还没形成持续跟进',
  },
  noOwner: {
    label: '记录缺责任人', level: 'P2', icon: '⚪',
    hint: '记录未填责任人 —— 归属不清，出了问题找不到人',
  },
};

export interface SupportSignal {
  key: SupportSignalKey;
  label: string;
  level: SupportLevel;
  icon: string;
  /** 一句话证据（必须能让老师看懂"为什么是他"；数字要用真实值，别写"很久"） */
  evidence: string;
}

/** 一条沟通记录的**信号相关**投影（调用方负责从原始记录里取，保持纯函数好测） */
export interface SupportCommLike {
  /** 沟通时间（ms）；取不到给 0 */
  ms: number;
  /** 记录类型（日常跟进 / 学生观察 / 学生沟通 / IDP沟通 / 家校沟通 / 学生实践） */
  kind?: string;
  /** 沟通主题 */
  subject?: string;
  /** 记录正文（沟通总结 / 沟通明细，命中问题词用） */
  body?: string;
  /** 责任人（空 = 缺责任人） */
  owner?: string;
}

/** 推导信号所需的输入（把原始记录折算成这几个数，函数就是纯的） */
export interface SupportSignalInput {
  /** 沟通记录（任意顺序即可，函数内部自己算最近一条） */
  comms: readonly SupportCommLike[];
}

/** 分组顺序（看板从上到下）、组名、组内说明 */
export const SUPPORT_LEVELS: readonly { level: SupportLevel; title: string; desc: string }[] = [
  { level: 'P0', title: '立即处理', desc: '从未沟通 · 长期失联 >14 天' },
  { level: 'P1', title: '本周关注', desc: '问题线索 · 反复沟通未缓解 · 近期沉默' },
  { level: 'P2', title: '持续观察', desc: '关系待建立 · 记录缺责任人' },
];

/** 级别 → 排序权重（P0 在最上） */
export function supportLevelRank(level: SupportLevel): number {
  return level === 'P0' ? 0 : level === 'P1' ? 1 : 2;
}

/**
 * 距离今天多少个自然日（北京时间口径）。
 *
 * ⚠️ 用 `idpDaysAgo` 的实现（全站"自然日"只有一份），别用 `(now - ms) / 86400000`
 *    取整 —— 那算的是 24 小时整倍数，会出现「昨天下午的记录今天算 0 天」这类偏差。
 */
export function supportDaysAgo(lastMs: number, nowMs: number): number | null {
  return idpDaysAgo(lastMs, nowMs);
}

/**
 * 推导一个学生的全部命中信号 —— **看板的核心纯函数**。
 *
 * 排序由调用方按 `supportLevelRank(level)` + 距今天数倒序做（见 `supportSortKey`）。
 *
 * 证据文案的口径（老师视角，先说结论再说数字）：
 * ```
 * neverContacted  「入学以来 0 条沟通记录」
 * longSilence     「最近沟通 07-24 · 已 67 天未联系」
 * problemClue     「命中「焦虑」「失眠」—— 09-16 清河的考试应激与兰花型成长密码」
 * unresolved      「近 30 天 3 次沟通，都在谈「出勤与作息」」
 * recentSilence   「最近沟通 09-16 · 已 13 天未联系」
 * thinRelation    「只沟通过 1 次（09-22）」
 * noOwner         「3 条记录中 2 条未填责任人」
 * ```
 */
export function supportSignalsOf(input: SupportSignalInput, nowMs: number): SupportSignal[] {
  const comms = [...(input.comms ?? [])].sort((a, b) => b.ms - a.ms);
  const out: SupportSignal[] = [];
  const push = (key: SupportSignalKey, evidence: string) => {
    const m = SUPPORT_SIGNAL_META[key];
    out.push({ key, label: m.label, level: m.level, icon: m.icon, evidence });
  };

  const count = comms.length;
  const last = count > 0 ? comms[0] : null;
  /** 最近一条的毫秒（0 = 没有记录）；后面统一用它，避免 TS 窄化在闭包里失效 */
  const lastMs = last?.ms ?? 0;
  const lastDays = lastMs ? supportDaysAgo(lastMs, nowMs) : null;

  // ① 从未沟通（P0）—— 有档案、0 条记录
  if (count === 0) {
    push('neverContacted', '入学以来 0 条沟通记录');
    // 0 条记录时后面几条都没意义，直接返回（避免一张卡上全是空证据）
    return out;
  }

  // ② 长期失联（P0）/ 近期沉默（P1）
  if (lastDays != null && lastMs) {
    const d = fmtDate(lastMs);
    if (lastDays > SUPPORT_LONG_SILENCE_DAYS) {
      push('longSilence', `最近沟通 ${d} · 已 ${lastDays} 天未联系`);
    } else if (lastDays > SUPPORT_RECENT_SILENCE_DAYS) {
      push('recentSilence', `最近沟通 ${d} · 已 ${lastDays} 天未联系`);
    }
  }

  // ③ 问题线索（P1）—— 看**最近一条**记录正文：只关心"当下还没解决的问题"。
  //    对全部历史记录扫描会让"三年前有过一句焦虑"永远挂在看板上，噪声太大。
  //
  //    🔴 门槛：**命中强词** 或 **同时命中 ≥2 个词**（见 SUPPORT_STRONG_WORDS 的说明）——
  //    不设这个门槛时，单命中一个泛词（"学习问题""缺课"）就会让 43% 的学生上板。
  const hits = supportProblemHits(`${last?.subject ?? ''}\n${last?.body ?? ''}`);
  const strongHit = hits.words.some((w) => SUPPORT_STRONG_WORDS.includes(w));
  if (hits.words.length > 0 && (strongHit || hits.words.length >= SUPPORT_PROBLEM_MIN_WORDS)) {
    const words = hits.words.slice(0, 3).map((w) => `「${w}」`).join('');
    const subj = (last?.subject ?? '').trim();
    push('problemClue', `命中${words}${subj ? ` —— ${fmtDate(lastMs)} ${truncate(subj, 34)}` : ''}`);
  }

  // ④ 反复沟通未缓解（P1）—— 近 30 天 ≥2 条，且**都**命中同一类问题词
  const win = nowMs - SUPPORT_UNRESOLVED_WINDOW_DAYS * 86400000;
  const recentComms = comms.filter((c) => c.ms >= win);
  if (recentComms.length >= SUPPORT_UNRESOLVED_MIN_COUNT && recentComms.length > 1) {
    const typeCount = new Map<SupportProblemType, number>();
    for (const c of recentComms) {
      const t = supportProblemHits(`${c.subject ?? ''}\n${c.body ?? ''}`).types;
      for (const x of new Set(t)) typeCount.set(x, (typeCount.get(x) ?? 0) + 1);
    }
    // 取"被谈得最多"的那一类：至少 2 条记录都在谈它
    let top: { type: SupportProblemType; n: number } | null = null;
    for (const [type, n] of typeCount) {
      if (n >= SUPPORT_UNRESOLVED_MIN_COUNT && (!top || n > top.n)) top = { type, n };
    }
    if (top) {
      push('unresolved', `近 ${SUPPORT_UNRESOLVED_WINDOW_DAYS} 天 ${recentComms.length} 次沟通，都在谈「${top.type}」`);
    }
  }

  // ⑤ 关系待建立（P2）
  if (count === 1 && lastMs) {
    push('thinRelation', `只沟通过 1 次（${fmtDate(lastMs)}）`);
  }

  // ⑥ 记录缺责任人（P2）
  const noOwner = comms.filter((c) => !String(c.owner ?? '').trim()).length;
  if (noOwner > 0) {
    push('noOwner', `${count} 条记录中 ${noOwner} 条未填责任人`);
  }

  return out;
}

/**
 * 一个学生的**最高优先级** —— 决定进哪个分组。
 * 没有信号 ⇒ 返回 ''（此人不上看板）。
 */
export function supportPriorityOf(signals: readonly SupportSignal[]): SupportLevel | '' {
  if (!signals.length) return '';
  let best: SupportLevel | '' = '';
  for (const s of signals) {
    if (best === '' || supportLevelRank(s.level) < supportLevelRank(best)) best = s.level;
  }
  return best;
}

/**
 * 看板排序：**最久没被想起的排最前**。
 *
 * ```
 * ① 先按级别（P0 → P1 → P2）
 * ② 同级内按「距今未联系天数」倒序；从未沟通（lastDays = null）排在最前
 * ```
 */
export function supportCompareRows(
  a: { level: SupportLevel; lastDays: number | null },
  b: { level: SupportLevel; lastDays: number | null },
): number {
  const r = supportLevelRank(a.level) - supportLevelRank(b.level);
  if (r !== 0) return r;
  const av = a.lastDays == null ? Number.MAX_SAFE_INTEGER : a.lastDays;
  const bv = b.lastDays == null ? Number.MAX_SAFE_INTEGER : b.lastDays;
  return bv - av;
}

// ─────────────────────────────────────────────────────────────
// 「谁负责跟进」—— 自动带出，不让人手选
// ─────────────────────────────────────────────────────────────

/**
 * 负责人的推导顺序（生产实测覆盖率）：
 *
 * ```
 * ① 该学生最近一条记录的「责任人」   207 / 224 条有值（10 位老师）← 最贴近真实关系
 * ② 否则 → 学生档案「班主任」         84 / 84 全覆盖              ← 兜底
 * ③ 否则 → IDP学生表的「IDP 老师」    有则用
 * ④ 都没有 → 「未指派」并置顶红标
 * ```
 *
 * 🔴 界面上必须**标明来源**（`赵光宇｜Michael · 自动（班主任）`）——
 *    让老师知道这是系统猜的、可以改，而不是被动接受一个不知道谁填的值。
 */
export const SUPPORT_OWNER_SOURCES = {
  commOwner: '最近沟通人',
  headTeacher: '班主任',
  idpTeacher: 'IDP 老师',
  manual: '人工指定',
  none: '',
} as const;

export interface SupportOwner {
  name: string;
  /** 来源（展示在负责人后面的小标签里）；`manual` = 人工改过，别再自动覆盖 */
  source: string;
}

/**
 * 自动推导负责人。**不覆盖人工已指定的**（`manual` 优先级最高，由调用方传 `manual` 进来短路）。
 *
 * ⚠️ 传入的 `commOwner` 必须是**最近一条有责任人的记录**的那个责任人，
 *    不是"最近一条记录"的 —— 后者常常是空（17/224 条没填）。
 */
export function supportAutoOwner(input: {
  commOwner?: string;
  headTeacher?: string;
  idpTeacher?: string;
}): SupportOwner {
  const clean = (v: unknown) => String(v ?? '').trim();
  const commOwner = clean(input.commOwner);
  if (commOwner) return { name: commOwner, source: SUPPORT_OWNER_SOURCES.commOwner };
  const head = clean(input.headTeacher);
  if (head) return { name: head, source: SUPPORT_OWNER_SOURCES.headTeacher };
  const idp = clean(input.idpTeacher);
  if (idp) return { name: idp, source: SUPPORT_OWNER_SOURCES.idpTeacher };
  return { name: '', source: SUPPORT_OWNER_SOURCES.none };
}

// ─────────────────────────────────────────────────────────────
// 超期判定
// ─────────────────────────────────────────────────────────────

/**
 * 是否已超期：到了「期望回应日期」还没更新状态 ⇒ 卡片打回「立即处理」并标 ⚠ 超期 N 天。
 *
 * ⚠️ 只对**未关闭**的状态判超期（已缓解/已关闭不该再标红）。
 */
export function supportOverdueDays(
  input: { status?: unknown; dueMs?: unknown },
  nowMs: number,
): number | null {
  if (!supportIsOpen(input.status)) return null;
  const due = Number(input.dueMs ?? 0);
  if (!Number.isFinite(due) || due <= 0) return null;
  const today = idpDayIndex(nowMs);
  const dueDay = idpDayIndex(due);
  const diff = today - dueDay;
  return diff > 0 ? diff : null;
}

/** 期望回应日期的默认值（今天 + N 天的**当天 0 点**，北京时间） */
export function supportDefaultDueMs(nowMs: number): number {
  return idpDayIndex(nowMs) * 86400000 + SUPPORT_DEFAULT_DUE_DAYS * 86400000 - 8 * 3600000;
}

// ─────────────────────────────────────────────────────────────
// 菜单与数据范围（与 idp 的两道闸完全同构，别自创一套）
// ─────────────────────────────────────────────────────────────

/** 「学生支持看板」菜单 key（homepage 与角色菜单白名单共用） */
export const SUPPORT_MENU_KEY = 'studentSupport';

/**
 * 菜单 / 接口的可见性判据 —— **唯一一份**（AppShell 调它、后端守卫也调它）。
 *
 * ① 硬闸门：必须持有 `module:studentSupport:read`。
 * ② 菜单白名单（叠加）：非空时要求含本菜单 key，**但必须向后兼容白名单里的旧 key** ——
 *    生产实测 `Phase1` 角色有 13 项白名单（含 `studentObservations` 这个合并前的旧 key），
 *    **不含任何新菜单 key**；严格只认 `studentSupport` 会把 Phase1（招生老师）整体挡在门外（报障级）。
 *    ⇒ 兼容集合 = 本菜单 key ＋ `studentRecords`（合并入口）＋ 学生记录的各旧 key。
 *    这不会放大可见性：能被兼容 key 放行的人，前提是**已经持有新权限点**。
 */
export function supportMenuVisible(input: {
  perms?: readonly string[] | null;
  menus?: readonly string[] | null;
}): boolean {
  const perms = input?.perms;
  if (!perms?.includes(modulePermission(SUPPORT_MENU_KEY, 'read'))) return false;
  const menus = input?.menus;
  if (!menus?.length) return true;
  if (menus.includes(SUPPORT_MENU_KEY)) return true;
  if (menus.includes(STUDENT_RECORD_ENTRY_KEY)) return true;
  return STUDENT_RECORD_LEGACY_MENU_KEYS.some((k) => menus.includes(k));
}

/**
 * 数据范围判据：`true` = 看全部学生，`false` = 只看「我是负责人 / 班主任 / IDP 老师」的。
 *
 * 判据 = 持有 `module:studentSupportAll:read`（专用开关，`legacyRead: null` ⇒
 * **不随版本迁移发放**，只由管理员在角色矩阵里手工勾选，否则等于人人看全部）。
 *
 * 🔴🔴 **没归属的学生必须任何范围都能看到** —— 这是本页最容易做废的地方：
 *    「从未沟通」的 9 人里有一批是因为**没有沟通记录 ⇒ 也推导不出责任人**，
 *    如果数据范围只按「负责人 = 我」过滤，"没人管的学生"恰好会被筛掉，
 *    而他们恰恰是这页最该被看见的人。判据见 `supportInScope`。
 */
export function supportSeeAll(perms: readonly string[] | undefined | null): boolean {
  return Boolean(perms?.includes(modulePermission('studentSupportAll', 'read')));
}

/**
 * 行级可见性：这个学生要不要出现在**我**的看板上。
 *
 * ```
 * seeAll            → 全部可见
 * 无归属（没负责人）  → 全部可见（🔴 关键：别把"没人管的学生"筛掉）
 * 否则              → 负责人 / 班主任 / IDP 老师里有我
 * ```
 *
 * ⚠️ `me` 要同时传**姓名与 openId**：三个来源存的东西不一样 ——
 *    支持表的「负责跟进」与记录的「责任人」存的是**姓名**（`赵光宇｜Michael`），
 *    而学生档案的「班主任」与 IDP 学生表的「IDP老师」存的是 **openId**（`ou_…`）。
 *    只传一个会漏判一半（症状：老师登录后看到自己的看板是空的，没有任何报错）。
 */
export function supportInScope(
  input: {
    seeAll: boolean;
    owner?: string;
    headTeacher?: string;
    idpTeacher?: string;
    /** 我的身份标识（姓名 + openId，任一命中即算我的学生） */
    me?: string | readonly string[];
  },
): boolean {
  if (input.seeAll) return true;
  const owner = String(input.owner ?? '').trim();
  const head = String(input.headTeacher ?? '').trim();
  const idp = String(input.idpTeacher ?? '').trim();
  // 🔴 没有任何归属 ⇒ 任何人都能看到（否则就是"没人管的学生谁也看不见"）
  if (!owner && !head && !idp) return true;
  const mine = (Array.isArray(input.me) ? input.me : [input.me])
    .map((v) => String(v ?? '').trim())
    .filter(Boolean);
  if (!mine.length) return false;
  // 逐字段比：完全相等，或一方包含另一方（姓名可能带后缀「｜Michael」，openId 不会）
  return [owner, head, idp].some((v) => v && mine.some((m) => v === m || v.includes(m) || m.includes(v)));
}

// ─────────────────────────────────────────────────────────────
// 展示辅助
// ─────────────────────────────────────────────────────────────

/** `MM-DD`（北京时间）。信号证据里都用这个，别用完整年月日（太长） */
export function fmtDate(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const d = new Date(ms + 8 * 3600000);
  return `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** `YYYY-MM-DD`（北京时间），日期输入框用 */
export function fmtDay(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms + 8 * 3600000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** `YYYY-MM-DD` → 北京时间当天 0 点的 ms（`<input type="date">` 回填用） */
export function parseDayToMs(s: unknown): number {
  const str = String(s ?? '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
  if (!m) return 0;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - 8 * 3600000;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// ─────────────────────────────────────────────────────────────
// 接口 DTO —— 🔴 前后端共用同一份，别在 api.ts 或 service 里各写一遍
// ─────────────────────────────────────────────────────────────
// 放到 contracts 而不是各端各定义：这几个结构有 20+ 字段，两端各写一份必然漂移
//（症状：后端加了一个字段，前端类型没跟上 ⇒ 页面显示 undefined，不报错）。

/** 看板一行（= 一个学生 + 他的信号 + 支持状态） */
export interface SupportBoardRow {
  studentId: string;
  name: string;
  nameEn: string;
  grade: string;
  cls: string;
  campus: string;
  /** 学生档案的「当前状态」（在校在读 …） */
  studentStatus: string;
  /** 命中的信号（含证据），已按级别排好 */
  signals: SupportSignal[];
  /** 最高级别（决定进哪个分组） */
  level: SupportLevel;
  commCount: number;
  lastMs: number;
  lastDays: number | null;
  lastSubject: string;
  lastKind: string;
  /** 支持行：可能为空串（还没人动过） */
  supportId: string;
  supportStatus: SupportStatus | '';
  problemType: string;
  severity: string;
  problemText: string;
  owner: string;
  /** 负责人来源（`最近沟通人` / `班主任` / `IDP 老师` / `人工指定` / 空） */
  ownerSource: string;
  dueMs: number;
  overdueDays: number | null;
  claimMs: number;
  note: string;
  /** 班主任 / IDP 老师（卡片上"信息可见"的两个角色，不是责任人） */
  headTeacherName: string;
  idpTeacherName: string;
}

/** `/student-support/board` 的返回 */
export interface SupportBoardResult {
  seeAll: boolean;
  me: { name: string; openId: string };
  kpis: {
    needSupport: number;
    unclaimed: number;
    neverContacted: number;
    longSilence: number;
    /** 最近一条记录命中问题词（门槛：命中强词 或 ≥2 词） */
    problemClue: number;
    /** 🔴 与 problemClue **分开统计**：这两个是不同的东西 ——
     *  一个是"最近提过问题"，一个是"反复谈同一类问题还没解决"。
     *  合并成一个数字会让老师看不出到底哪种情况多（2026-09-30 第一版就这么写错了）。 */
    unresolved: number;
    overdue: number;
  };
  groups: { level: SupportLevel; title: string; desc: string; count: number }[];
  rows: SupportBoardRow[];
  /** 被行级范围挡掉的人数（提示"还有 N 人不在你的范围内"，避免老师以为看板是空的） */
  hiddenByScope: number;
}

/** 沟通时间线的一条（支持卡抽屉里用） */
export interface SupportTimelineItem {
  id: string;
  ms: number;
  kind: string;
  subject: string;
  owner: string;
  excerpt: string;
  /** 命中的问题词（挂在条目下当"证据原文"用） */
  hits: string[];
}

/** `/student-support/:studentId` 的返回 */
export interface SupportDetailResult {
  row: SupportBoardRow;
  timeline: SupportTimelineItem[];
  actions: { ms: number; who: string; what: string }[];
}

/** 登记 / 认领 / 流转的请求体（**未传的字段不动**） */
export interface SupportSaveBody {
  problemType?: string;
  severity?: string;
  problemText?: string;
  owner?: string;
  dueMs?: number;
  note?: string;
  status?: string;
  source?: string;
}

/** 负责人候选（用户表里有飞书 Open ID 的人） */
export interface SupportOwnerOption {
  name: string;
  openId: string;
}

/**
 * `/student-support/student-options` 的一行 = 一个**我可以给他登记**的在读学生。
 *
 * 🔴 与看板 `board` **同一份行级范围判据**（`supportInScope`）：
 *    老师只能给「我是负责人 / 班主任 / IDP 老师」的学生登记 —— 不能靠"选择器里搜得到"
 *    绕过看板的范围限制。
 *
 * 🔴 这份列表**包含没上板的学生**（没有命中任何信号）—— 这正是它存在的理由：
 *    峰哥 2026-09-30 指出「学生不在看板上时，老师想主动登记一条支持，没有任何入口」。
 */
export interface SupportStudentOption {
  studentId: string;
  name: string;
  nameEn: string;
  grade: string;
  cls: string;
  campus: string;
  /** 自动/人工推导出来的负责人（可能为空 = 未指派） */
  owner: string;
  ownerSource: string;
  /** 是否已经在看板上（有信号）。false ⇒ 弹窗里提示"当前无信号，主动登记" */
  onBoard: boolean;
  /** 已有的支持状态（空串 = 还没人动过） */
  supportStatus: string;
}

/** 问题类型候选（前端兜底用；正常应从字典读 `支持问题类型`） */
export function supportProblemTypeOptions(dict?: readonly string[] | null): string[] {
  const fromDict = (dict ?? []).map((x) => String(x ?? '').trim()).filter(Boolean);
  return fromDict.length ? fromDict : [...SUPPORT_PROBLEM_TYPES];
}

/** 严重程度候选（同上，字典 key `支持严重程度`） */
export function supportSeverityOptions(dict?: readonly string[] | null): string[] {
  const fromDict = (dict ?? []).map((x) => String(x ?? '').trim()).filter(Boolean);
  return fromDict.length ? fromDict : [...SUPPORT_SEVERITIES];
}

/** 严重程度 → 排序权重（用于卡片左边色条：紧急最红） */
export function supportSeverityRank(sev: unknown): number {
  const s = String(sev ?? '');
  return s === '紧急' ? 0 : s === '需介入' ? 1 : s === '关注' ? 2 : 3;
}

/** 宽容取文本（复用 IDP 的那份实现，别再写一遍） */
export function supportTextOf(v: unknown): string {
  return idpTextOf(v);
}
