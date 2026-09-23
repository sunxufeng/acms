import { TABLES, USER_TABLE, modulePermission } from '@acms/contracts';
import type { RecordMeta } from '../shared/generic-crud.module.js';

/**
 * 归属人映射表（owner-mapping）元数据 —— 2026-09-24 新增。
 *
 * 存的是「卫瓴联系人表的归属人」→「ACMS 用户」的对照关系，供「我的跟进」决定
 * 登录人能看到哪些联系人（`my-followups.service` 读它，不再靠姓名猜）。
 *
 * 为什么必须有这张表：卫瓴侧的「归属人」是
 * `致极学院-曹老师｜Dainel|1510` 这种**复合串**（机构前缀 + 称呼 + 英文名 + `|条数`），
 * 与我们系统的用户姓名对不上、英文名还有错拼。靠算法猜（姓 + 英文名近似）只能兜底，
 * 而**猜错等于让人看到别人的联系人** —— 这条关系必须显式配置、由管理员维护。
 *
 * 🔴 权限绑**联系人维护权限**（`module:weilingContacts:update` 的 module 版本，
 *    即 `module:ownerMappings:*`，由 module-permissions 的 legacyWrite `weiling:write` 派生）：
 *    改这张表等于改「谁能看到谁的联系人」，属于与角色管理同级的风险。
 */
const READ = modulePermission('ownerMappings', 'read');
const WRITE = modulePermission('ownerMappings', 'update');

export const OWNER_MAPPING_META: RecordMeta = {
  path: 'owner-mappings',
  tableId: TABLES.ownerMapping.tableId,
  readPerm: READ,
  writePerm: WRITE,
  searchField: '卫瓴归属人',
  sortField: '卫瓴归属人',
  /** 「ACMS用户」是关联字段（存用户表 record id），必须登记 multi，否则数组会被当字符串写入 */
  multi: ['ACMS用户'],
  /** 声明后 API 会额外返回 `ACMS用户__link`（record id 数组）供前端回显 */
  linkFields: [{ field: 'ACMS用户', table: USER_TABLE.tableId, nameField: '姓名' }],
};

export const OWNER_MAPPING_METAS: RecordMeta[] = [OWNER_MAPPING_META];
