/**
 * IDP 管理两张表的元数据。
 *  - idp-plans：IDP 方案（父表，纳入学生 360 聚合，关联学生按姓名匹配）
 *  - idp-communications：IDP 沟通记录（子表，必须挂在某个 IDP 方案下，不进 360 聚合）
 * 字段严格对应飞书实际字段（recreate_idp_tables.mjs 建表）。
 */
import { TABLES } from '@acms/contracts';
import type { RecordMeta } from '../shared/generic-crud.module.js';

const PERM_R = 'student:read';
const PERM_W = 'student:write';

export const IDP_PLAN_META: RecordMeta = {
  path: 'idp-plans',
  tableId: TABLES.idpPlan.tableId,
  readPerm: PERM_R,
  writePerm: PERM_W,
  dateFields: ['学生确认时间', '导师确认时间', '制定日期'],
  // 注意：原始文档（附件）必须可写，不能放入 readonly
  readonly: [],
  studentMatch: { field: '关联学生', by: 'name' },
  studentScoped: true,
  statusField: '状态',
  defaultStatus: '草稿',
  searchField: '关联学生',
  sortField: '制定日期',
};

export const IDP_COMM_META: RecordMeta = {
  path: 'idp-communications',
  tableId: TABLES.idpCommunication.tableId,
  readPerm: PERM_R,
  writePerm: PERM_W,
  dateFields: ['沟通日期'],
  readonly: [],
  /**
   * 沟通记录不直接关联学生，挂在 IDP 方案下 —— 按「可见方案」间接过滤。
   * 不这样做的话，班主任在 IDP 沟通记录列表里仍能看到别的班学生的沟通内容。
   */
  studentVia: {
    linkField: '关联IDP方案',
    linkTable: TABLES.idpPlan.tableId,
    innerMatchField: '关联学生',
    innerMatchBy: 'name',
  },
  searchField: '关联IDP方案',
  sortField: '沟通日期',
};
