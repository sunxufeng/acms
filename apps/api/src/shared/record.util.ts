/** 通用记录读写辅助（M2 各模块复用，避免重复 student 模式代码） */
import { toWriteSingle, toWriteMulti, toStringArray, toText } from '@acms/base-adapter';

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
): { id: string } & Record<string, unknown> {
  const obj: { id: string } & Record<string, unknown> = { id: rec.recordId };
  for (const [k, v] of Object.entries(rec.fields)) {
    if (multiFields.has(k)) obj[k] = toStringArray(v);
    else if (readonly.has(k)) obj[k] = v;
    else obj[k] = toText(v);
  }
  return obj;
}

export function buildFilter(
  conditions: { field: string; op?: string; value: string[] }[],
): { conjunction: 'and'; conditions: { field: string; op?: string; value: string[] }[] } {
  return { conjunction: 'and', conditions };
}

/** 从飞书关联/lookup 字段原始值提取关联记录 id 数组（兼容 record_id / link_record_id / id） */
export function linkIds(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((it) => {
      if (typeof it === 'string') return it;
      const o = it as { record_id?: string; link_record_id?: string; id?: string };
      return o.record_id ?? o.link_record_id ?? o.id ?? '';
    })
    .filter(Boolean);
}
