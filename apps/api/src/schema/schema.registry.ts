import {
  LIFECYCLE_METAS,
  CONFIG_METAS,
  AUDIT_METAS,
  AI_ROUTE_METAS,
  TEACHING_CONFIG_METAS,
} from '../shared/lifecycle.meta.js';
import { MARKBOOK_METAS } from '../markbook/markbook.meta.js';
import { CURRICULUM_METAS } from '../curriculum/curriculum.meta.js';
import { BEHAVIOUR_METAS } from '../behaviour/behaviour.meta.js';
import { EXAM_GRADE_METAS } from '../exam-grade/exam-grade.meta.js';
import { OWNER_MAPPING_METAS } from '../owner-mapping/owner-mapping.meta.js';
import type { RecordMeta } from '../shared/generic-crud.module.js';

/**
 * 全部通用 CRUD 元数据的**扁平注册表**（2026-09-16，为 CLI / MCP 的 `acms schema` 建的）。
 *
 * 为什么需要它：仓库里 8 个 `*_METAS` 数组散落在各自的模块目录，
 * 只有 `app.module.ts` 在注册路由时把它们拼起来（那是运行时行为，读不到）。
 * agent 要「自己发现能干什么」就必须有一份可查询的清单 ——
 * 这份注册表是那个清单的**唯一真源**，新增模块时**必须同步加到这里**，
 * 否则 `acms schema` 会静默缺项（agent 以为系统没这个能力）。
 *
 * ⚠️ 仓库没有 OpenAPI / Swagger，所以这份注册表 + `acms_fields`（运行时字段定义）
 * 合起来就是 agent 的「接口文档」。
 */
export const ALL_METAS: RecordMeta[] = [
  ...LIFECYCLE_METAS,
  ...CONFIG_METAS,
  ...AUDIT_METAS,
  ...AI_ROUTE_METAS,
  ...TEACHING_CONFIG_METAS,
  ...MARKBOOK_METAS,
  ...CURRICULUM_METAS,
  ...BEHAVIOUR_METAS,
  ...EXAM_GRADE_METAS,
  ...OWNER_MAPPING_METAS,
];

/** 路径 → 元数据（前端调用路径与 RecordMeta.path 一致，可直接按它查表） */
export const META_BY_PATH: Map<string, RecordMeta> = new Map(ALL_METAS.map((m) => [m.path, m]));

/** 表 ID → 元数据（一个表可能被多个路径共用，取第一个即可满足「反查字段」的用途） */
export const META_BY_TABLE: Map<string, RecordMeta> = (() => {
  const out = new Map<string, RecordMeta>();
  for (const m of ALL_METAS) if (!out.has(m.tableId)) out.set(m.tableId, m);
  return out;
})();
