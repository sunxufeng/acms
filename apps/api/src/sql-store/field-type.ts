import { toText } from '@acms/base-adapter';

/**
 * 飞书字段类型 → 读取侧格式化。
 *
 * JSONB 存的是原始值，读取时按飞书语义还原：
 *   - type=5 日期：统一输出 "YYYY-MM-DD" 或 "YYYY-MM-DD HH:mm"（取决于字段是否带时间）
 *     与 `BaseClient.fromReadFields` 行为一致，避免上层 `typeof x === 'number'` 之类的判断失灵
 *   - type=1 文本：飞书返回富文本数组，归一化成字符串
 *   - type=4 多选 / 18 关联 / 20 双向关联：保持数组
 */
const DATETIME_FORMATTER_HAS_TIME = /H{1,2}/;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function formatDate(v: unknown, hasTime: boolean): unknown {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').trim());
  if (!Number.isFinite(n) || n <= 0) return v;
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return v;
  const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (!hasTime) return base;
  return `${base} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export interface FieldTypeInfo {
  type: number;
  hasTime?: boolean;
}

/** 按字段类型还原读取值（对应飞书 BaseClient 的 fromReadFields） */
export function formatReadValue(v: unknown, info: FieldTypeInfo | undefined): unknown {
  if (v == null) return v;
  const type = info?.type;
  if (type === 5) return formatDate(v, info?.hasTime ?? false);
  if (type === 1) return toText(v);
  if (type === 4 || type === 18 || type === 20) {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string' && v) return v.split(',');
    return v;
  }
  return v;
}

/** 从 property.date_formatter 判断该日期字段是否带时分 */
export function dateFormatterHasTime(fmt: string | undefined): boolean {
  return DATETIME_FORMATTER_HAS_TIME.test(fmt ?? '');
}

/** 生成飞书风格的记录 id（rec_ + 24 位十六进制），保证上层与关联引用零改动 */
export function newRecordId(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  let hex = '';
  for (const b of bytes) hex += (b as number).toString(16).padStart(2, '0');
  return `rec_${hex}`;
}

/** 生成飞书风格的字段 id */
export function newFieldId(): string {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  let hex = '';
  for (const b of bytes) hex += (b as number).toString(16).padStart(2, '0');
  return `fld_${hex}`;
}
