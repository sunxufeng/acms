import { useCallback, useRef } from 'react';
import { useLocale, useMessages } from 'next-intl';

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
 *
 * 🔴🔴 **返回的函数身份必须稳定（2026-09-18 修，页面「不停闪」的根因）**
 *
 * 原实现是 `return (k) => labels[k] ?? k` —— 每次 render 都返回**新函数**。
 * 而多个页面（`data-levels`、报表组件、`ai-docs`）把 `tl` 写进了 `useEffect` 的依赖数组：
 * ```ts
 * useEffect(() => { …一堆 setState… }, [tl]);   // ← 曾经这样写
 * ```
 * ⇒ tl 每次 render 都变 ⇒ effect 每次都重跑 ⇒ setState ⇒ 再 render ⇒ **无限循环**。
 * 症状是页面**持续闪烁**，而且**每圈都发一次接口**：生产实测一个人打开 `/data-levels` 后
 * 同一秒发出 **49 次** `field-levels/catalog` 请求，当天累计 **812 次**（前一天 0 次）。
 *
 * 修法两件一起做，缺一不可：
 *  ① 函数身份**按 locale 稳定**（`useCallback([locale])`）⇒ `[tl]` 只在**切语言**时才变，
 *     既不循环、又保留「切语言要重新加载」的正确语义；
 *  ② 内部用 ref 指向**最新** labels ⇒ 即便 effect 拿的是"旧"函数引用，
 *     调用时读到的仍是当前语言文案（不会闭包在过期 labels 上）。
 *
 * ⚠️ 通用教训：**任何函数在放进依赖数组前，先确认它的身份是否稳定**。
 *    不稳定就用「useCallback + ref 读最新值」这个组合，别把渲染循环留在页面上。
 */
export type TlFn = (k: string, v?: any) => string;

export function useTl(): TlFn {
  const messages = useMessages() as Record<string, unknown> | undefined;
  const labels = (messages?.labels ?? {}) as Record<string, string>;
  const locale = useLocale();

  // 始终指向最新一份 labels：调用时才查表，因此绝不会拿到过期文案
  const labelsRef = useRef(labels);
  labelsRef.current = labels;

  return useCallback(((k: string) => labelsRef.current[k] ?? k) as TlFn, [locale]);
}
