import { TABLES } from '@acms/contracts';
import type { RecordMeta } from '../shared/generic-crud.module.js';

export const MAIL_ACCOUNT_META: RecordMeta = {
  path: 'mail-accounts',
  tableId: TABLES.mailAccount.tableId,
  readPerm: 'mail:read',
  writePerm: 'mail:write',
  dateFields: ['最后收取时间'],
  // 密码为敏感字段：服务端存储密文，列表/详情以掩码返回，不在列表直接展示
  readonly: ['最后收取时间', '最后收取结果'],
  searchField: '账户名称',
  sortField: '账户名称',
};
