import { TABLES } from '@acms/contracts';
import type { RecordMeta } from '../shared/generic-crud.module.js';

/**
 * 内部消息（ACMS 模块参考设计：内部消息；2026-10-03 新增）。
 *
 * 用途：教务 / 教师 / 学务之间的轻量内部通知（教务通知 / 作业提醒 / 活动通知 / 温馨提示）。
 * 与「通知任务 / 通知模板」（模板化、面向学生家长群发）是两套独立能力，不重叠。
 *
 * 后端：由 `GenericCrudModule.registerAll(MESSAGE_METAS)` 生成 CRUD 路由（见 app.module.ts）。
 * 表：`TABLES.message`（**占位 tableId，上线前须在飞书 Base 建表并回填真实 tableId**）。
 */
const READ = 'message:read';
const WRITE = 'message:write';

export const MESSAGE_META: RecordMeta = {
  path: 'messages',
  tableId: TABLES.message.tableId,
  readPerm: READ,
  writePerm: WRITE,
  searchFields: ['主题', '关联学生编号', '发件人'],
  dateFields: ['发送时间'],
  statusField: '已读状态',
  defaultStatus: '未读',
  sortField: '发送时间',
  linkFields: [{ field: '关联学生编号', table: TABLES.studentProfile.tableId, nameField: '姓名' }],
};

export const MESSAGE_METAS: RecordMeta[] = [MESSAGE_META];
