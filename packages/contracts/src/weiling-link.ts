/**
 * 卫瓴联系人 ↔ 学生档案：**关联来源三态** 与「取消 / 改指 / 恢复自动」的写库判据。
 *
 * 背景（2026-09-30 峰哥）：联系人「丁点儿-万美妗妈妈转介绍」被自动关联到了学生「万美妗」，
 * 但那其实是**妈妈的朋友**在推荐，不是家长 —— 而且系统里**根本没有取消关联的功能**。
 *
 * 🔴 为什么只做「取消」会白做（两条，缺一条这个功能就是假的）：
 *   ① `matchStudents()` 对这 5 个字段是**无条件覆盖**的，且每天 07:00 随同步跑一次
 *      ⇒ 今天点了取消，明天早上它自己回来。**必须有「已忽略」这个状态位**。
 *   ② 它的 patch 写的是 `hit?.name ?? ''` —— **本轮没算出来就把字段清空**
 *      ⇒ 连"以前有人手工关联过"的都会被抹掉。**没命中就不该写**。
 *
 * 🔴 为什么是「一个字段三态」而不是「两个布尔开关」：
 *   两个布尔会出现 `人工锁定=true` + `已忽略=true` 这种无意义组合，
 *   而它**不会报错**，只会让人猜"到底哪个生效"。三态从结构上排除了这种状态。
 *
 * 这里只放**判据**（纯函数）。真正落库在 `apps/api/src/weiling/weiling.service.ts`。
 */

/** 关联来源三态 */
export const LINK_SOURCES = ['自动', '人工', '已忽略'] as const;
export type LinkSource = (typeof LINK_SOURCES)[number];

/** 缺省：存量数据都没有这个字段，语义上全是自动匹配来的 */
export const DEFAULT_LINK_SOURCE: LinkSource = '自动';

export const LINK_SOURCE_LABEL: Record<LinkSource, { zh: string; en: string }> = {
  自动: { zh: '自动匹配', en: 'Auto' },
  人工: { zh: '人工指定', en: 'Manual' },
  已忽略: { zh: '已忽略关联', en: 'Ignored' },
};

export const LINK_SOURCE_FIELD = '关联来源';
export const LINK_ACTOR_FIELD = '关联操作人';
export const LINK_ACTED_AT_FIELD = '关联操作时间';

/** 关联事实所在的 5 个字段（写入时要么一起写、要么都不动） */
export const LINK_FIELDS = ['关联学生', '关联学生ID', '匹配置信度', '匹配依据'] as const;

/**
 * 自动匹配的**写库门槛**。
 *
 * 🔴 原来是 55 分就写库，而 55 分正是最后一条规则（昵称包含学生姓名）的分数
 * ⇒ 它**恰好压线**，必然在「XX妈妈的朋友 / 转介绍 / 亲戚」这类昵称上误伤。
 * 提门槛到 70 ⇒ 55 分那档降级为**只提示不写库**，改由人在页面上确认
 * （配合「联系人管理」页新增的手工关联能力）。
 */
export const MATCH_WRITE_MIN_SCORE = 70;

/** 匹配结果的三档处置 */
export type MatchDecision = 'write' | 'advisory' | 'none';

/**
 * 一个**分数**对应哪种处置。
 *
 * - `write`（≥70）：照旧自动写库
 * - `advisory`（1–69）：**有候选但不自动写** —— 供界面提示「疑似：XXX（依据）」
 * - `none`（0 / 空 / 非法）：没匹配上
 *
 * ⚠️ 写成 `score >= MATCH_WRITE_MIN_SCORE` 而不是 `score > 55`：
 *    门槛是一个常量，改的时候只改 `MATCH_WRITE_MIN_SCORE`，别在别处再写死数字。
 */
export function matchDecisionOf(score: unknown): MatchDecision {
  const n = Number(score);
  if (!Number.isFinite(n) || n <= 0) return 'none';
  return n >= MATCH_WRITE_MIN_SCORE ? 'write' : 'advisory';
}

/**
 * 读一条记录的关联来源。
 *
 * ⚠️ **未设置 / 空 / 非法值一律按「自动」**，不能抛错也不能返回空 ——
 *    存量 3706 条联系人里绝大多数没有这个字段，返回空会让它们全部"既不能自动更新、
 *    也不显示任何来源"，看起来像功能坏了。
 */
export function linkSourceOf(record: Record<string, unknown> | null | undefined): LinkSource {
  const raw = String((record ?? {})[LINK_SOURCE_FIELD] ?? '').trim();
  return (LINK_SOURCES as readonly string[]).includes(raw) ? (raw as LinkSource) : DEFAULT_LINK_SOURCE;
}

/**
 * 这条联系人**能不能被自动匹配覆盖**。
 *
 * 🔴 这是「取消关联」能不被打回去的唯一依据 —— `matchStudents()` 主循环里
 *    必须用**这一个函数**做跳过判据（别在 service 里再写一遍字符串比较）。
 */
export function isAutoMatchable(record: Record<string, unknown> | null | undefined): boolean {
  return linkSourceOf(record) === '自动';
}

export type LinkWriteContext = {
  /** 操作人显示名（取不到就写空串，不要写 'undefined'） */
  actor?: string;
  /** 毫秒时间戳 */
  nowMs: number;
};

/**
 * 「取消关联」要写的字段。
 *
 * - `关联学生` 与 `关联学生ID` **必须一起清**：PG 模式没有飞书双向关联自动回填，
 *   只清一个会留下"看着有关联、点进去 404"的悬空壳值。
 * - 原依据**保留在文本里**（`人工取消关联（原：昵称包含学生姓名）：误关联`）——
 *   以后回看才知道它当初是靠什么匹配上的。
 * - ⚠️ **不动 `匹配时间`**：它的语义是"算法最后一次匹配的时间"，
 *   人工操作写进去会让它变成第三种含义。
 */
export function unlinkPatch(
  opts: LinkWriteContext & { reason?: string; prevReason?: string; prevScore?: number },
): Record<string, unknown> {
  const prev = String(opts.prevReason ?? '').trim();
  const reason = String(opts.reason ?? '').trim() || '误关联';
  const prevScore = Number(opts.prevScore ?? 0);
  return {
    关联学生: '',
    关联学生ID: '',
    匹配置信度: 0,
    匹配依据: `人工取消关联（原：${prev || '无'}${prevScore > 0 ? ` · ${prevScore} 分` : ''}）：${reason}`,
    [LINK_SOURCE_FIELD]: '已忽略',
    [LINK_ACTOR_FIELD]: String(opts.actor ?? '').trim(),
    [LINK_ACTED_AT_FIELD]: opts.nowMs,
  };
}

/**
 * 「手工关联 / 改为关联到指定学生」要写的字段。
 *
 * 与「入学」的关联分支同一套写法（`关联学生ID` 存学生 record id 文本，
 * `关联学生` 存展示名 —— 读侧一律宽容解析，见 `linkIds()` 的注释）。
 */
export function relinkPatch(
  opts: LinkWriteContext & { studentId: string; studentName: string },
): Record<string, unknown> {
  return {
    关联学生: String(opts.studentName ?? '').trim(),
    关联学生ID: String(opts.studentId ?? '').trim(),
    匹配置信度: 100,
    匹配依据: '人工指定',
    [LINK_SOURCE_FIELD]: '人工',
    [LINK_ACTOR_FIELD]: String(opts.actor ?? '').trim(),
    [LINK_ACTED_AT_FIELD]: opts.nowMs,
  };
}

/**
 * 「恢复自动匹配」要写的字段。
 *
 * 为什么必须有这个动作：没有它，「已忽略」就是**单向门** ——
 * 人点错了取消（其实这条是对的）之后，再也回不到自动匹配，
 * 只能靠手工指定，而手工指定的置信度恒为 100、依据恒为「人工指定」，
 * 信息量反而比自动匹配少。灰掉的按钮必须有回到默认态的路。
 */
export function restoreAutoPatch(opts: LinkWriteContext): Record<string, unknown> {
  return {
    [LINK_SOURCE_FIELD]: '自动',
    [LINK_ACTOR_FIELD]: String(opts.actor ?? '').trim(),
    [LINK_ACTED_AT_FIELD]: opts.nowMs,
  };
}

/**
 * 列表里怎么显示「关联学生」这一格。
 *
 * 关键：**已忽略的行必须说清"它为什么一直没关联"**，
 * 否则过一段时间没人知道这条是被人工否掉的、还是同步坏了。
 */
export function linkCellState(record: Record<string, unknown> | null | undefined): {
  source: LinkSource;
  studentId: string;
  studentName: string;
  /** 是否显示成"已忽略关联"（有来源标记但当前没有关联） */
  ignored: boolean;
  /** 是否显示"已关联"的 chip */
  linked: boolean;
} {
  const r = (record ?? {}) as Record<string, unknown>;
  const studentId = String(r['关联学生ID'] ?? '').trim();
  const studentName = String(r['关联学生'] ?? '').trim();
  const source = linkSourceOf(r);
  return {
    source,
    studentId,
    studentName,
    ignored: source === '已忽略' && !studentId,
    linked: !!studentId,
  };
}
