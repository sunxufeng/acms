/** 飞书字段类型转换：Base 原始值 ⇄ 简化值（踩坑规则固化，见项目记忆 2026-08-08） */

/** list-of-dicts 形如 [{text: 'x', type: 'text'}]，取 .text */
export function toText(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    return v
      .map((it) => (typeof it === 'string' ? it : (it as { text?: string })?.text ?? ''))
      .filter(Boolean)
      .join('');
  }
  if (typeof v === 'object') return String((v as { text?: string }).text ?? '');
  return String(v);
}

/** 多选/人员类字段：字符串数组 */
export function toStringArray(v: unknown): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) {
    return v
      .map((it) => (typeof it === 'string' ? it : (it as { text?: string })?.text ?? ''))
      .filter(Boolean);
  }
  if (typeof v === 'string') return v ? [v] : [];
  return [];
}

/** 写入：单选必须纯字符串；多选必须字符串数组 */
export function toWriteSingle(v: unknown): string | undefined {
  if (v == null) return undefined;
  return typeof v === 'string' ? v : String(v);
}

export function toWriteMulti(v: unknown): string[] {
  return toStringArray(v);
}

/**
 * 人员字段（飞书 User 类型 type=11）。
 * 飞书要求写入值为 [{open_id}]、读取返回也是 [{open_id}]，
 * 因此内部统一以 open_id 字符串数组表示，读写时各自转换。
 */
export function toUserIds(v: unknown): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) {
    return v
      .map((it) => {
        if (typeof it === 'string') return it;
        if (it && typeof it === 'object') {
          const o = it as { open_id?: string; text?: string };
          return o.open_id ?? o.text ?? '';
        }
        return String(it);
      })
      .filter(Boolean);
  }
  if (typeof v === 'string') return v ? [v] : [];
  return [];
}

/** 写入飞书 User 字段：open_id 数组 → [{open_id}] */
export function toUserWrite(v: unknown): { open_id: string }[] {
  return toUserIds(v).map((id) => ({ open_id: id }));
}
