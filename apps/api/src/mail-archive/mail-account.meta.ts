import { TABLES, USER_TABLE } from '@acms/contracts';
import type { RecordMeta, RowScopeFilter } from '../shared/generic-crud.module.js';

export const MAIL_ACCOUNT_META: RecordMeta = {
  path: 'mail-accounts',
  tableId: TABLES.mailAccount.tableId,
  readPerm: 'mail:read',
  writePerm: 'mail:write',
  dateFields: ['最后收取时间'],
  // 密码为敏感字段：服务端存储密文，列表/详情以掩码返回，不在列表直接展示。
  // 「归属人员」是 2026-09-15 之前的手填文本，已被「关联用户」取代 → 转只读保留历史值。
  // 「创建者openId」由服务端在新建时写入，是行级范围的依据，用户不可改。
  readonly: ['最后收取时间', '最后收取结果', '归属人员', '创建者openId'],
  searchField: '账户名称',
  sortField: '账户名称',
  // 「关联用户」是**多选关联字段**：存用户表的 record id 数组，展示由 linkFields 解析成姓名。
  // ⚠️ 必须在 multi 里登记，否则数组会被当成字符串写入。
  multi: ['关联用户'],
  linkFields: [{ field: '关联用户', table: USER_TABLE.tableId, nameField: '姓名' }],
  /**
   * 新建时的服务端默认值：
   *  1. 写入「创建者openId」—— 行级范围的唯一依据（谁建的就归谁管）
   *  2. 「关联用户」默认填**本人**（把 openId 换成用户记录 id）。
   *     普通用户建账户时只能关联自己（共管由管理员加人），所以这里不让前端传——
   *     用户显式传了就以用户为准（defaults 只在字段缺省时生效）。
   */
  defaults: async (fields, user, ctx) => {
    const out: Record<string, unknown> = {};
    if (!user?.openId) return out;
    out['创建者openId'] = user.openId;
    if (ctx && !fields['关联用户']) {
      const rows = await ctx.search(USER_TABLE.tableId);
      const me = rows.find((r) => String(r['飞书 Open ID'] ?? '').trim() === user.openId);
      if (me?.id) out['关联用户'] = [me.id];
    }
    return out;
  },
  /**
   * 行级范围：非系统管理员可见 **自己创建的** 或 **在关联名单里的** 账户。
   *
   * 为什么要带「我关联的」这一支：共管者虽然不能改别人的账户配置（见 MailAccountService
   * 的 assertWritable），但应当能看到这个账户的存在与同步状态 —— 否则会出现
   * 「邮件列表里「用户」列写着我的名字，邮件归档设置里却找不到这个账户」的错位观感。
   * 一句话：**可见范围 = 能管到我的范围；可写范围 = 我自己的**，两者刻意不同。
   *
   * ⚠️ 「关联用户」是多选关联字段：
   *  - 服务端路径：列里存的是 JSON 数组文本，必须用 `contains` 做子串匹配（等值恒 false）
   *  - 内存路径：matchFilter 拿到的已解析成「id1、id2」字符串，`contains` 同样成立
   * 两处共用同一份条件对象，所以口径一致。
   *
   * 老账户没有「创建者openId」且没配关联用户 → 只有管理员可见，需要管理员补一遍归属
   *（符合预期，不静默放开）。
   */
  rowScope: async (user, ctx) => {
    const rows = await ctx.search(USER_TABLE.tableId);
    const me = rows.find((r) => String(r['飞书 Open ID'] ?? '').trim() === user.openId);
    const conditions: RowScopeFilter[] = [];
    if (user.openId) conditions.push({ field: '创建者openId', value: [user.openId] });
    if (me?.id) conditions.push({ field: '关联用户', op: 'contains', value: [String(me.id)] });
    if (!conditions.length) return 'none';
    return { conjunction: 'or', conditions };
  },
};
