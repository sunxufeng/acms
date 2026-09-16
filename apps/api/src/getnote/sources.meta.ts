import { TABLES, USER_TABLE } from '@acms/contracts';
import type { RecordMeta } from '../shared/generic-crud.module.js';

/**
 * 知识库配置表（getnote_source）元数据。
 *
 * 设计目的：把"我有多少来源 / 哪个来源接的谁 / 多频繁去拉一遍"集中管理，
 * 让我的笔记页只管"展示"，同步逻辑由 SourcesService 在调度器驱动下执行。
 *
 * 写入时间（上次同步时间）与结果（上次同步结果）由后台自动回写，对前端只读。
 * 排序按"上次同步时间"倒序——建表时此字段为 datetime 类型（带时分秒）。
 */
export const GETNOTE_SOURCE_META: RecordMeta = {
  path: 'getnote-sources',
  tableId: TABLES.getnoteSource.tableId,
  readPerm: 'getnote:read',
  writePerm: 'getnote:write',
  searchField: '配置名称',
  sortField: '上次同步时间',
  readonly: ['上次同步时间', '上次同步结果'],
  /**
   * 「关联用户」是**多值**字段（存用户表 record id 数组）。
   * ⚠️ 不在这里登记 multi，数组会被当成字符串写入（关联字段的经典坑）。
   */
  multi: ['关联用户'],
  /**
   * 「关联用户」是飞书 Base 的关联字段，指向用户表。
   * 声明后 API 会额外返回 `关联用户__link`（record id 数组）供前端回显多选。
   */
  linkFields: [{ field: '关联用户', table: USER_TABLE.tableId, nameField: '姓名' }],
  /** 状态字段：启用/停用（决定是否被 cron 拾取） */
  statusField: '启用状态',
  defaultStatus: '启用',
};