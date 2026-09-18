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
 * 是不是「附件数组」—— 飞书 type=17 的值，形如 `[{file_token,name,size,type}]`。
 *
 * 🔴 读、写两侧都**必须原样保留**它，绝不能交给 `toText` / `toStringArray` ——
 * 那两个函数是按**富文本数组**语义写的（取每项的 `.text` 再拼接 / 过滤），
 * 而附件项只有 `file_token` 没有 `text` ⇒ **非空附件被拍成空字符串 / 空数组**。
 *
 * 为什么单独放在这里（而不是在调用方判断）：拍平会发生在**两个**地方 ——
 *   1. `SqlStore.normalize` → `formatReadValue`：按字段元数据 type=1（文本）走 toText。
 *      而「沟通附件清单」这类字段在历史建表时正是被登记成**文本字段**（见字典服务的
 *      建字段逻辑），于是从数据库读出来就已经是空串了；
 *   2. `toFlatRecord` / `buildWriteFields`：字段未登记元数据时同样走 toText。
 * 判据下沉到本文件，两条链路共用一份，避免「改了一处、另一处还在拍平」。
 *
 * 后果（2026-09-18 实测）：「笔记转出带录音」写进业务记录的 `会议附件 / 沟通附件清单`
 * 在页面上完全看不见（列表恒为空、音频播放器也渲染不出来）。这条链路一直是坏的，
 * 只是此前没有哪个模块真的存过附件，直到录音转出才第一次暴露。
 *
 * 判据只认 `file_token`：富文本数组元素只有 `{text}`，不会误判。
 */
export function isAttachmentArray(v: unknown): boolean {
  if (!Array.isArray(v) || v.length === 0) return false;
  return v.every(
    (it) =>
      it != null &&
      typeof it === 'object' &&
      typeof (it as { file_token?: unknown }).file_token === 'string',
  );
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
