import { TABLES, USER_TABLE } from '@acms/contracts';
import type { RecordMeta } from '../shared/generic-crud.module.js';

/** 宽容地把「关联/多值字段」的原始值解析成 id 数组：兼容 数组 / {link_record_ids:[...]} / JSON 字符串。 */
export function idsOf(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (v && typeof v === 'object') {
    const inner = (v as { link_record_ids?: unknown }).link_record_ids;
    if (Array.isArray(inner)) return inner.map((x) => String(x));
    return [];
  }
  if (typeof v === 'string' && v.trim()) {
    try {
      const p = JSON.parse(v);
      if (Array.isArray(p)) return p.map((x) => String(x));
    } catch {
      /* 普通字符串，按单值处理 */
    }
    return [v];
  }
  return [];
}

export const MAIL_ARCHIVE_META: RecordMeta = {
  path: 'mail-archive',
  tableId: TABLES.mailArchive.tableId,
  readPerm: 'mail:read',
  writePerm: 'mail:write',
  dateFields: ['发送时间', '收取时间'],
  // 归档记录由同步任务写入，正文/附件信息等不开放前端直接编辑
  readonly: ['邮件UID', '归属账户', '邮箱文件夹', '邮件方向', '发件人', '收件人', '抄送', '主题', '正文', '发送时间', '收取时间', '附件数', '附件信息', '文件附件', '附件失败原因', '关联学生', '关联联系人', '是否已读'],
  numbers: ['附件数'],
  // 关联字段（多值）：必须在 multi 登记，否则数组会被当成字符串写入
  multi: ['关联联系人'],
  // 「邮箱文件夹」存的是 IMAP 原始路径（INBOX / Sent Items），加入检索便于按路径排查
  // 「关联学生」是飞书单向关联字段（type=18），无法用 contains 检索，故不加入 searchFields
  searchFields: ['发件人', '收件人', '主题', '归属账户', '邮箱文件夹'],
  // 「关联学生」是飞书单向关联字段（type=18，指向学生档案表）。
  // 声明为 linkField 后，API 返回：
  //   - 关联学生      : 解析后的学生姓名（如「陈佳琳」），便于直接展示
  //   - 关联学生__link: 学生记录 id 数组（如 ["recxxx"]），便于前端跳转到学生档案
  // 「关联联系人」同理，指向招生侧的卫瓴联系人 —— 列表里两者合并成一列「关联」并列展示。
  linkFields: [
    { field: '关联学生', table: TABLES.studentProfile.tableId, nameField: '学生姓名' },
    { field: '关联联系人', table: TABLES.weilingContact.tableId, nameField: '联系人姓名' },
  ],
  /**
   * 「关联」列的**联合筛选**：一个输入框同时搜学生姓名与联系人姓名，结果取并集。
   *
   * 为什么走内存深筛而不走服务端条件：两个字段都是**关联字段**，服务端 `contains`
   * 对关联字段无效（会恒返回 0 条），只能先解析出可读名再在内存里匹配。
   * `listDeep` 里已先调 resolveLinks 把 `关联学生` / `关联联系人` 换成姓名串，这里直接读。
   */
  deepParams: ['related'],
  deepFilter: (row, query) => {
    const kw = String(query['related'] ?? '').trim().toLowerCase();
    if (!kw) return undefined;
    const s = String(row['关联学生'] ?? '').toLowerCase();
    const c = String(row['关联联系人'] ?? '').toLowerCase();
    return s.includes(kw) || c.includes(kw);
  },
  /**
   * 行级数据范围：非系统管理员**只能看到自己关联账户的邮件**。
   *
   * ⚠️ 不把「归属用户」冗余写进归档记录，而是**实时按账户关联算**：
   *    管理员改了某个账户的关联人，效果立刻生效，不需要重跑历史数据回填。
   *    代价是列表多一次账户查询（账户只有几十条，可忽略）。
   * ⚠️ 无关联账户的邮件（含所有历史数据）只有管理员可见 —— 这是有意为之：
   *    宁可让管理员补归属，也不要静默放开。
   */
  rowScope: async (user, ctx) => {
    // 1) 用 openId 找到「我」在用户表里的记录 id
    const users = await ctx.search(USER_TABLE.tableId);
    const me = users.find((r) => String(r['飞书 Open ID'] ?? '').trim() === user.openId);
    const myId = String(me?.id ?? '');
    if (!myId) return 'none';
    // 2) 找出「关联用户」里包含我的邮件账户
    const accounts = await ctx.search(TABLES.mailAccount.tableId);
    const myAccountNames = accounts
      .filter((r) => idsOf(r['关联用户']).includes(myId))
      .map((r) => String(r['账户名称'] ?? '').trim())
      .filter(Boolean);
    // 3) 一条都没有 → 一封邮件都看不到
    if (!myAccountNames.length) return 'none';
    return {
      conjunction: 'or',
      conditions: myAccountNames.map((n) => ({ field: '归属账户', value: [n] })),
    };
  },
  sortField: '发送时间',
};
