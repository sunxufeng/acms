/**
 * 「我的笔记」（Get笔记 / 得到大脑）的**共享口径**。
 *
 * 为什么放 contracts：这些规则前端要用来渲染列表列、后端要用来做**服务端筛选** ——
 * 两边各写一份必然漂移（典型翻车姿势：前端按 tags 拆出来源、后端按别的字段筛，
 * 结果「筛选后条数对不上」而且没人说得清以谁为准）。
 */

/**
 * 笔记来源的候选值（= 笔记类型字典）。
 *
 * ⚠️ 存储位置：Get笔记 的 note 对象**没有自定义字段**，所以「来源」复用 `tags` 承载 ——
 *    命中这份列表的那个标签就是来源，其余标签才是普通标签。
 *    这样来源随笔记走（换浏览器也在），不需要在 ACMS 侧再建映射表。
 */
export const NOTE_SOURCE_TYPES = [
  '得到大脑',
  '飞书秒记',
  '钉钉助记',
  '元宝录音',
  '腾讯会议',
] as const;

/** 没有来源标签时（历史笔记、标签功能上线之前的）统一算作它 */
export const NOTE_SOURCE_DEFAULT = '得到大脑';

/** 从 Get笔记 的 tags 原始值里取标签名数组（容忍多种形态，缺字段/脏数据都不抛） */
export function noteTagNames(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return tags
    .map((t) => {
      if (typeof t === 'string') return t;
      if (t && typeof t === 'object') return String((t as { name?: unknown }).name ?? '');
      return '';
    })
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 把一条笔记的 tags 拆成「来源 + 普通标签」。
 *
 * 前端 `toRow()` 与后端筛选都调它 —— 口径必须一致，否则会出现
 * 「明明显示了来源=得到大脑，按得到大脑筛却筛不到」这类问题。
 */
export function splitNoteTags(tags: unknown): { source: string; tags: string[] } {
  const names = noteTagNames(tags);
  const hit = names.find((x) => (NOTE_SOURCE_TYPES as readonly string[]).includes(x));
  return {
    source: hit ?? NOTE_SOURCE_DEFAULT,
    // 来源标签不再重复出现在标签列，与列表展示保持一致
    tags: names.filter((x) => !(NOTE_SOURCE_TYPES as readonly string[]).includes(x)),
  };
}

/** 「我的笔记」列表的可选筛选条件（都由服务端在内存快照上过滤，见 GetnoteService.list） */
export interface NoteListFilters {
  /** 来源（得到大脑 / 飞书秒记 / …）—— 精确匹配 */
  source?: string;
  /** 配置名称（这条笔记属于哪个知识库配置）—— 精确匹配 */
  configName?: string;
  /** 归属人（聚合时打的 `_owner`）—— 精确匹配 */
  owner?: string;
  /** 标签 —— **模糊包含**（一条笔记有多个标签，用等值会全筛空） */
  tag?: string;
  /** 状态（有效 / 归档 / 全部）—— 缺省或「全部」= 不限制，见 `noteStatusMatches` */
  status?: string;
}

/**
 * ── 笔记状态（2026-09-21 新增）──────────────────────────────────────────────
 *
 * 为什么状态不放在 Get笔记 上游：上游 note 对象里**没有**可写的自定义字段
 * （「来源」当初就是被迫复用 `tags` 承载的），归档这类纯 ACMS 侧的业务标记
 * 只能落在本地 —— 即 ACMS 自建的「笔记状态表」（`TABLES.noteStatus`）。
 *
 * ⚠️ **只有「归档」是需要判定的值，其余（空串 / 缺失 / 未知值）一律算「有效」**：
 *   历史笔记（状态功能上线之前）根本没有状态行，若把判据写成「等于有效」，
 *   历史笔记会被全部筛掉 —— 界面症状是「筛了『有效』之后一条笔记都没有」。
 *   所以筛选实现必须调 `noteStatusMatches()`，**不许在页面里手写 `=== '有效'`**。
 */
export const NOTE_STATUS_ACTIVE = '有效';
export const NOTE_STATUS_ARCHIVED = '归档';
/** 筛选项里的「全部」：只出现在筛选控件与 query 参数里，**不会写进数据** */
export const NOTE_STATUS_ALL = '全部';
export const NOTE_STATUSES = [NOTE_STATUS_ACTIVE, NOTE_STATUS_ARCHIVED] as const;
/**
 * 状态筛选下拉的候选 —— **故意不含「全部」**。
 *
 * 🔴 为什么（2026-09-21 峰哥报障：下拉里出现了**两个「全部」**）：
 *    通用筛选控件 `FilterSelect` 自己会在最前面渲染一项「全部」（值是**空串**，
 *    语义 = 不筛），再把这里的候选接在后面 —— 两者都放「全部」就是两个同名项，
 *    用户不知道点哪个（行为其实一样：`noteStatusMatches` 把空串与「全部」都当"不筛"）。
 *    所以「全部」由控件提供，候选里只列**真实状态值**。
 *
 * ⚠️ `NOTE_STATUS_ALL` 仍然要留着：判据侧（`noteStatusMatches` / 后端 `splitByStatus`）
 *    和 URL 参数都认它 —— 老链接里可能带着 `?状态=全部`，不能当未知值处理。
 */
export const NOTE_STATUS_FILTER_OPTIONS = [NOTE_STATUS_ACTIVE, NOTE_STATUS_ARCHIVED] as const;

/** 归一：明确等于「归档」才是归档，其余一切（含 undefined / '' / 未知值）算「有效」 */
export function normalizeNoteStatus(v: unknown): string {
  return String(v ?? '').trim() === NOTE_STATUS_ARCHIVED ? NOTE_STATUS_ARCHIVED : NOTE_STATUS_ACTIVE;
}

/** 这条笔记是不是已归档（前端渲染「已归档」标记、后端拦转换都用它） */
export function isArchivedNote(v: unknown): boolean {
  return normalizeNoteStatus(v) === NOTE_STATUS_ARCHIVED;
}

/**
 * 状态筛选判据：want 为空 / 「全部」⇒ 不限制；否则与归一后的状态比较。
 *
 * 前后端共用（前端在「来源 / 配置名称」那条**客户端内存筛选**分支里也要判，
 * 页面上另写一份必然漂移 —— 会出现「筛了来源之后状态筛选失灵」）。
 */
export function noteStatusMatches(status: unknown, want?: unknown): boolean {
  const w = String(want ?? '').trim();
  if (!w || w === NOTE_STATUS_ALL) return true;
  return normalizeNoteStatus(status) === normalizeNoteStatus(w);
}
