/**
 * 笔记转换：「我的笔记」→ 任意业务模块新建记录的跨页传值与留痕。
 *
 * 之所以走 sessionStorage 而不是 URL 参数：预填内容是一整篇笔记的总结 +
 * 原始记录（动辄几千字），塞进 URL 会被截断、也会污染历史记录。
 * 用 sessionStorage 的另一个好处是多标签页互不干扰，关掉标签页自动失效。
 *
 * ── 留痕为什么不在 Get笔记 上打标签 ──────────────────────────────
 * Get笔记 上游硬限制**单篇笔记最多 5 个标签**（越界报
 * `invalid_request: tags length must be less than 5`），而 system 标签 + AI
 * 自动标签往往已经占掉 4 个，留痕只剩 1 个位 —— 实际表现是一篇笔记只能成功
 * 留痕第一个模块，之后转成其他模块全部静默失败（错误还被 try/catch 吞掉）。
 * 所以留痕改记在 ACMS 自己的「笔记转换记录」表里：次数可无限累加，
 * 还能额外记住「转成了哪条业务记录」。
 */

/** 目标页面靠这个 URL 标记判断「需要消费一次预填」，只读一次即清 */
export const CONVERT_QUERY_FLAG = 'acmsConvert';
export const CONVERT_QUERY_VALUE = '1';

/** 预填暂存多久算过期（毫秒）。超时丢弃，避免隔天回来突然弹出一个旧表单。 */
const TTL_MS = 10 * 60 * 1000;
const STORAGE_KEY = 'acms:note-convert-payload';

export interface ConvertPayload {
  /** 目标模块菜单 key */
  key: string;
  /** 目标模块中文名 */
  label: string;
  /** 目标页路径 */
  href: string;
  /** 预填到目标新建表单的字段值：目标模块字段名 → 值 */
  values: Record<string, unknown>;
  /** 来源笔记 id */
  noteId: string;
  noteTitle: string;
  /** 留痕记录 id：目标页保存成功后要回填「转成了哪条记录」 */
  logId?: string;
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

/** 把留痕列表格式化成人话：「家校沟通×2、日常跟进」 */
export function formatConvertLogs(
  items: { moduleLabel?: string; count?: number }[] | undefined,
): string {
  if (!items?.length) return '';
  return items
    .map((i) => {
      const label = String(i.moduleLabel ?? '').trim();
      // 模块名为空的脏数据直接跳过，否则会渲染成孤零零的「×2」
      if (!label) return '';
      const count = Number(i.count ?? 1) || 1;
      return count > 1 ? `${label}×${count}` : label;
    })
    .filter(Boolean)
    .join('、');
}

/** 留痕总次数（列表行显示「已转 N 次」用） */
export function totalConvertCount(
  items: { count?: number }[] | undefined,
): number {
  if (!items?.length) return 0;
  return items.reduce((sum, i) => sum + (Number(i.count ?? 1) || 1), 0);
}
