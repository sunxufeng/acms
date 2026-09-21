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

/**
 * ⚠️ 2026-09-21：**界面入口已收起** —— IDP 沟通并入「学生记录」
 * （记录类型 = IDP沟通，内容与日常跟进完全相同）。
 *
 * 收起的只是**入口**，这张表与这个 meta 都保留：
 *   · 表当时 **0 行** ⇒ 收起入口没有丢数据；
 *   · 保留接口的代价是「理论上仍可调 API 写入」，但界面上已无任何入口
 *     （IDP管理页的行级按钮、方案详情页内嵌列表、`/idp-plans/[id]/communications/**`
 *     三个路由都已改掉或改为重定向），实际不会有人用到；
 *   · 将来若要挪回方案下（按方案归档），恢复成本是"把前端入口与页面改回来"，
 *     不需要动这里的注册。
 *
 * 🔴 别在别处新增引用：那会重新造出「同一件事两处都能记、而学生全景 / 搜索 / AI 各读一处」。
 */
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
