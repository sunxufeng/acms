import { useTranslations } from 'next-intl';

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
 * 回退规则：next-intl 查不到 key 时返回 key 本身，或返回 `labels.xxx` 形式的完整路径，
 * 这两种情况都视为「无译文」，直接返回原文。
 */
export type TlFn = (k: string, v?: any) => string;

export function useTl(): TlFn {
  const __t = useTranslations('labels');
  return ((k: string, v?: any) => {
    const r = __t(k as any, v) as unknown as string;
    return r === k || r.startsWith('labels.') ? k : r;
  }) as TlFn;
}
