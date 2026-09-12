/** 通用记录读写辅助（M2 各模块复用，避免重复 student 模式代码） */
import {
  toWriteSingle,
  toWriteMulti,
  toStringArray,
  toText,
  type FilterCondition,
  type FilterGroup,
  type RecordAudit,
} from '@acms/base-adapter';

/**
 * 审计四件套的展示字段名。
 *
 * ⚠️ 唯一真源是 PostgreSQL 物理列（created_by/created_at/updated_by/updated_at），
 * 不是 data 里的业务字段 —— 历史飞书自动字段在切 PG 后已停止写入，继续读会拿到空值。
 * 这里在展平时统一注入，因此业务表里不需要、也不应该再存这四个键。
 */
export const AUDIT_FIELDS = ['创建人', '创建时间', '更新人', '更新时间'] as const;
const AUDIT_FIELD_SET: ReadonlySet<string> = new Set(AUDIT_FIELDS);

/** 写入时必须剔除审计字段，避免前端回传后被当成业务值写进 data */
export function isAuditField(key: string): boolean {
  return AUDIT_FIELD_SET.has(key);
}

export function buildWriteFields(
  dto: Record<string, unknown>,
  readonly: Set<string>,
  numbers: Set<string>,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(dto)) {
    if (readonly.has(k) || isAuditField(k)) continue;
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
  rec: { recordId: string; fields: Record<string, unknown>; audit?: RecordAudit },
  readonly: Set<string>,
  multiFields: Set<string>,
  linkFields: Set<string> = new Set(),
  /**
   * 业务字段优先于审计字段的白名单（默认空）。
   * 外部同步进来的表（如卫瓴联系人）会自己带「创建时间」这种上游业务时间，
   * 它的含义是「线索什么时候进来的」，跟本系统落库时间完全不是一回事 ——
   * 若被审计值覆盖，按创建时间筛选就变成了「按同步时间筛选」。
   */
  keepBusinessFields: Set<string> = new Set(),
): { id: string } & Record<string, unknown> {
  const obj: { id: string } & Record<string, unknown> = { id: rec.recordId };
  for (const [k, v] of Object.entries(rec.fields)) {
    // 审计字段以物理列为准，data 里的同名历史值一律忽略（历史值已由回填脚本迁走）
    if (isAuditField(k) && !keepBusinessFields.has(k)) continue;
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
  // 注入审计四件套（唯一真源：PG 物理列）。人显示解析后的姓名，DB 里存的仍是 openId
  if (rec.audit) {
    if (!keepBusinessFields.has('创建人')) obj['创建人'] = rec.audit.createdByName;
    if (!keepBusinessFields.has('创建时间')) obj['创建时间'] = rec.audit.createdAt;
    if (!keepBusinessFields.has('更新人')) obj['更新人'] = rec.audit.updatedByName;
    if (!keepBusinessFields.has('更新时间')) obj['更新时间'] = rec.audit.updatedAt;
  }
  return obj;
}

export function buildFilter(
  conditions: (FilterCondition | FilterGroup)[],
): FilterGroup {
  // 飞书拒绝「AND 仅包一个 OR 组」的冗余嵌套（报 99992402 field validation failed）。
  // 当只有一个条件且该条件本身是分组（conjunction）时，直接作为顶层分组返回。
  if (conditions.length === 1 && 'conjunction' in (conditions[0] as FilterGroup)) {
    return conditions[0] as FilterGroup;
  }
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
