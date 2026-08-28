import { TABLES } from '@acms/contracts';
import type { RecordMeta } from '../shared/generic-crud.module.js';

export const MAIL_ARCHIVE_META: RecordMeta = {
  path: 'mail-archive',
  tableId: TABLES.mailArchive.tableId,
  readPerm: 'mail:read',
  writePerm: 'mail:write',
  dateFields: ['发送时间', '收取时间'],
  // 归档记录由同步任务写入，正文/附件信息等不开放前端直接编辑
  readonly: ['邮件UID', '归属账户', '邮箱文件夹', '发件人', '收件人', '抄送', '主题', '正文', '发送时间', '收取时间', '附件数', '附件信息', '关联学生', '是否已读'],
  numbers: ['附件数'],
  searchFields: ['发件人', '收件人', '主题', '归属账户', '关联学生'],
  sortField: '发送时间',
};
