/** 通用记录读写辅助（M2 各模块复用，避免重复 student 模式代码） */
import { toWriteSingle, toWriteMulti, toStringArray, toText, type FilterCondition, type FilterGroup } from '@acms/base-adapter';

export function buildWriteFields(
  dto: Record<string, unknown>,
  readonly: Set<string>,
  numbers: Set<string>,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(dto)) {
    if (readonly.has(k)) continue;
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) fields[k] = toWriteMulti(v);
    else if (typeof v === 'string') {
      if (numbers.has(k)) {
        const n = Number(v);
        if (!Number.isNaN(n)) fields[k] = n;
      } else fields[k] = toWriteSingle(v);
    } else fields[k] = v;
  }
  return fields;
}

export function toFlatRecord(
  rec: { recordId: string; fields: Record<string, unknown> },
  readonly: Set<string>,
  multiFields: Set<string>,
  linkFields: Set<string> = new Set(),
): { id: string } & Record<string, unknown> {
  const obj: { id: string } & Record<string, unknown> = { id: rec.recordId };
  for (const [k, v] of Object.entries(rec.fields)) {
    if (multiFields.has(k)) obj[k] = toStringArray(v);
    else if (linkFields.has(k)) {
      // type=18 关联字段返回值形如 [{ record_ids:[id], table_id, text:null, ... }]
      // 先暂存 id（解析后由 BaseRecordService.resolveLinks 替换为可读名），并附 __link 数组供前端跳转
      const ids = linkIds(v);
      obj[k] = ids.join('、');
      (obj as Record<string, unknown>)[k + '__link'] = ids;
    } else if (readonly.has(k)) obj[k] = toText(v);
    else obj[k] = toText(v);
  }
  return obj;
}

export function buildFilter(
  conditions: (FilterCondition | FilterGroup)[],
): FilterGroup {
  return { conjunction: 'and', conditions };
}

/** 从飞书关联/lookup 字段原始值提取关联记录 id 数组。
 *  兼容多种形态：
 *   - POST /records/search 返回：{ link_record_ids:[...] }（单对象，最常见）
 *   - GET /records 返回：[{ record_ids:[...], table_id, text:null, ... }]（数组）
 *   - 双向关联：[{ record_id }] / [{ link_record_id }]
 *   - 纯字符串 id */
export function linkIds(v: unknown): string[] {
  if (v == null) return [];
  const arr = Array.isArray(v) ? v : [v];
  const out: string[] = [];
  for (const it of arr) {
    if (typeof it === 'string') out.push(it);
    else if (it && typeof it === 'object') {
      const o = it as {
        record_ids?: string[];
        link_record_ids?: string[];
        record_id?: string;
        link_record_id?: string;
        id?: string;
      };
      if (Array.isArray(o.record_ids)) out.push(...o.record_ids);
      else if (Array.isArray(o.link_record_ids)) out.push(...o.link_record_ids);
      else if (o.record_id) out.push(o.record_id);
      else if (o.link_record_id) out.push(o.link_record_id);
      else if (o.id) out.push(o.id);
    }
  }
  return out.filter(Boolean);
}
