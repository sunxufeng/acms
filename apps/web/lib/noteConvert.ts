/**
 * 笔记转换：「我的笔记」→ 任意业务模块新建记录的跨页传值与留痕。
 *
 * 之所以走 sessionStorage 而不是 URL 参数：预填内容是一整篇笔记的总结 +
 * 原始记录（动辄几千字），塞进 URL 会被截断、也会污染历史记录。
 * 用 sessionStorage 的另一个好处是多标签页互不干扰，关掉标签页自动失效。
 */

/** 目标页面靠这个 URL 标记判断「需要消费一次预填」，只读一次即清 */
export const CONVERT_QUERY_FLAG = 'acmsConvert';
export const CONVERT_QUERY_VALUE = '1';

/** 预填暂存多久算过期（毫秒）。超时丢弃，避免隔天回来突然弹出一个旧表单。 */
const TTL_MS = 10 * 60 * 1000;
const STORAGE_KEY = 'acms:note-convert-payload';

/** 留痕标签前缀：最终形如「已转家校沟通」「已转家校沟通×2」 */
export const CONVERT_TAG_PREFIX = '已转';

export interface ConvertPayload {
  /** 目标模块菜单 key */
  key: string;
  /** 目标模块中文名（留痕标签用） */
  label: string;
  /** 目标页路径 */
  href: string;
  /** 预填到目标新建表单的字段值：目标模块字段名 → 值 */
  values: Record<string, unknown>;
  /** 来源笔记 id（留痕用） */
  noteId: string;
  noteTitle: string;
  /** 写入时间戳，用于过期判断 */
  ts: number;
}

export function putConvertPayload(p: Omit<ConvertPayload, 'ts'>): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ ...p, ts: Date.now() }));
  } catch {
    /* 隐私模式 / 容量超限：转换降级为不带预填的跳转，不阻断主流程 */
  }
}

/** 读取并立即清除（读后即清，避免刷新页面时重复弹出预填表单） */
export function takeConvertPayload(): ConvertPayload | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    window.sessionStorage.removeItem(STORAGE_KEY);
    const p = JSON.parse(raw) as ConvertPayload;
    if (!p || typeof p !== 'object' || !p.href) return null;
    if (Date.now() - Number(p.ts ?? 0) > TTL_MS) return null;
    return p;
  } catch {
    return null;
  }
}

/** Get笔记 的 tags 是 [{ id, name, type }] 对象数组，取纯名字列表 */
export function tagNamesOf(note: Record<string, unknown>): string[] {
  const tags = Array.isArray(note.tags) ? (note.tags as { name?: string }[]) : [];
  return tags.map((t) => String(t?.name ?? '').trim()).filter(Boolean);
}

/**
 * 计算下一次转换的留痕标签，并返回替换后的完整标签列表。
 *
 * Get笔记 的 tags 是**整体替换**语义（编辑笔记时就是这么提交的），
 * 所以这里不能只做追加 —— 否则会同时留下「已转家校沟通」和「已转家校沟通×2」两个标签。
 * 做法是找出旧的同前缀标签、解析出次数 +1 后原地替换。
 */
export function nextConvertTag(
  existing: string[],
  moduleLabel: string,
): { tag: string; tags: string[] } {
  const prefix = `${CONVERT_TAG_PREFIX}${moduleLabel}`;
  const hit = existing.find((t) => t === prefix || t.startsWith(`${prefix}×`));
  const count = hit ? (parseInt(hit.slice(prefix.length).replace('×', ''), 10) || 1) + 1 : 1;
  const tag = count === 1 ? prefix : `${prefix}×${count}`;
  return { tag, tags: [...existing.filter((t) => t !== hit), tag] };
}
