import { TABLES } from '@acms/contracts';
import type { RecordMeta } from '../shared/generic-crud.module.js';

export const MAIL_ARCHIVE_META: RecordMeta = {
  path: 'mail-archive',
  tableId: TABLES.mailArchive.tableId,
  readPerm: 'mail:read',
  writePerm: 'mail:write',
  dateFields: ['发送时间', '收取时间'],
  // 归档记录由同步任务写入，正文/附件信息等不开放前端直接编辑
  readonly: ['邮件UID', '归属账户', '邮箱文件夹', '邮件方向', '发件人', '收件人', '抄送', '主题', '正文', '发送时间', '收取时间', '附件数', '附件信息', '文件附件', '附件失败原因', '关联学生', '是否已读'],
  numbers: ['附件数'],
  // 「邮箱文件夹」存的是 IMAP 原始路径（INBOX / Sent Items），加入检索便于按路径排查
  // 「关联学生」是飞书单向关联字段（type=18），无法用 contains 检索，故不加入 searchFields
  searchFields: ['发件人', '收件人', '主题', '归属账户', '邮箱文件夹'],
  // 「关联学生」是飞书单向关联字段（type=18，指向学生档案表）。
  // 声明为 linkField 后，API 返回：
  //   - 关联学生      : 解析后的学生姓名（如「陈佳琳」），便于直接展示
  //   - 关联学生__link: 学生记录 id 数组（如 ["recxxx"]），便于前端跳转到学生档案
  linkFields: [
    { field: '关联学生', table: TABLES.studentProfile.tableId, nameField: '学生姓名' },
  ],
  sortField: '发送时间',
};
