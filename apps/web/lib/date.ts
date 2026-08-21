/** 把飞书返回的日期/时间戳（毫秒或秒）格式化为 YYYY-MM-DD HH:mm */
export function formatDateTime(v: unknown): string {
  if (v == null || v === '') return '—';
  let ms: number | null = null;
  if (typeof v === 'number') ms = v > 1e12 ? v : v * 1000;
  else if (typeof v === 'string') {
    const s = v.trim();
    if (/^\d+$/.test(s)) ms = Number(s) > 1e12 ? Number(s) : Number(s) * 1000;
    else {
      const t = Date.parse(s);
      if (!Number.isNaN(t)) ms = t;
    }
  }
  if (ms != null) {
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) {
      const pad = (x: number) => String(x).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
  }
  return String(v);
}

/** 仅日期部分 */
export function formatDate(v: unknown): string {
  const s = formatDateTime(v);
  return s === '—' ? s : s.slice(0, 10);
}
