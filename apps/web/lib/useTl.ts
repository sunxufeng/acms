import { useMessages } from 'next-intl';

/**
 * 全站统一的「中文原文 → 目标语言」翻译器（labels 命名空间）。
 *
 * 背景：飞书多维表的字段名、字典选项值都以中文存储，它们**既是数据 key 也是显示文本**。
 * 因此不能像常规 i18n 那样把中文替换成英文 key——真替换了就读不到数据。
 * 正确做法是：数据层保持中文原文，只在**渲染时**拿中文原文去 labels 命名空间查译文。
 *
 * 中文环境下 labels 中该 key 的译文就是原文，查不到也回退原文，因此中文显示永远不变。
 * 英文环境下返回对应英译。
 *
 * ⚠️ 必须直接查表，不能用 useTranslations('labels') 的 t(key)：
 * next-intl 会把 key 里的「.」当嵌套路径分隔符、「{}」当 ICU 占位符，而 labels 的 key
 * 是含标点的整句（如 "如 imap.qq.com / imap.gmail.com"、"可选，如 {"fromDomain":...}"），
 * 走路径解析必然查不到，还会刷 MISSING_MESSAGE。
 * 改为取到 labels 对象后按原样 key 直接取值，不经过路径解析与 ICU 解析。
 *
 * 回退规则：查不到时返回原文，中文环境因此永远显示不变。
 */
export type TlFn = (k: string, v?: any) => string;

export function useTl(): TlFn {
  const labels = ((useMessages() as Record<string, unknown> | undefined)?.labels ?? {}) as Record<string, string>;
  return ((k: string) => labels[k] ?? k) as TlFn;
}
