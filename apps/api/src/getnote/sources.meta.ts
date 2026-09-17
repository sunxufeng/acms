import { TABLES, USER_TABLE } from '@acms/contracts';
import type { RecordMeta, RowScopeFilter } from '../shared/generic-crud.module.js';

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
  /**
   * 🔴 行级数据范围（**服务端过滤**）：非管理员只看「关联用户含我」**或**「归属人ID === 我」的配置。
   *
   * 为什么必须交给引擎、而不是在 `SourcesService.list()` 里过滤：
   * 在 list 里过滤发生在**分页之后**，只能把结果收敛成单页
   * （2026-09-17 实际写成 `{ items: rows, total: rows.length, hasMore: false }`）
   * ⇒ `total` 恒等于「本页条数」、`hasMore` 恒 false ⇒
   * 🔴 **前端分页条永远只有 1 页，用户看不到第 2 页以后的配置**
   *    （峰哥实测报障：「只显示 10 条，数据库里明明更多」）。
   * 放在这里则条件会进 SQL WHERE（`SqlStore.buildWhere`），**total 与分页都是准的**。
   *
   * 判据与 `source-cred.ts` 的 `sourceVisibleTo()` 保持一致（同源的 OR 两个分支）；
   * 管理员由 `rowScopeBypassRoles`（默认 `['系统管理员']`）豁免。
   * 比较只认 **record id / openId**，不认姓名（重名必出事）。
   */
  rowScope: async (user, ctx) => {
    const conditions: RowScopeFilter[] = [];
    // 存量兼容：单人归属时代的数据（openId）
    if (user.openId) conditions.push({ field: '归属人ID', value: [user.openId] });
    // 多用户关联：关联用户里存的是用户表 record id，与 openId 不是同一个东西
    const users = await ctx.search(USER_TABLE.tableId);
    const me = users.find((r) => String(r['飞书 Open ID'] ?? '').trim() === user.openId);
    if (me?.id) conditions.push({ field: '关联用户', op: 'contains', value: [String(me.id)] });
    // 一条都命中不了 ⇒ 什么都看不到（不静默放开）
    if (!conditions.length) return 'none';
    return { conjunction: 'or', conditions };
  },
  /** 状态字段：启用/停用（决定是否被 cron 拾取） */
  statusField: '启用状态',
  defaultStatus: '启用',
};