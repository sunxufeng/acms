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
}
