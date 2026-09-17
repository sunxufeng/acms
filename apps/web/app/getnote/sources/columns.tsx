import type { CrudColumn } from '../../../components/CrudPage';

/**
 * 知识库配置列表/表单字段。
 *
 * ⚠️ apiKey / clientId **不是飞书表字段**：它们在提交时由后端折叠进「凭证」字段
 *    并做 KMS 信封加密（sources.service.encryptCredInPlace），所以这两个 key 只出现在
 *    表单里（list: false），列表和详情永远拿不到明文（后端会把「凭证」置空串）。
 *    编辑时留空 = 保留原密文，不会把凭证清空。
 *
 * 「笔记类型」与「收取频率」的下拉项来自字典数据（dictKey），改字典即改选项，
 * 不需要动代码。
 */
export const COLUMNS: CrudColumn[] = [
  // ── 列表可见 ──────────────────────────────
  {
    key: '配置名称',
    label: '配置名称',
    form: true,
    required: true,
    width: '180px',
    // 按配置名筛选：容器里的配置名大多是英文（Rin / Elsa Jiang Get Note），
    // 记不全 ⇒ 用模糊匹配（`__contains` → 后端 ILIKE）。走等值会一条都筛不到。
    filter: true,
    filterType: 'text',
    filterOp: 'contains',
    filterPlaceholder: '配置名称',
  },
  /**
   * 「关联用户」（2026-09-17，照邮件账户同一范式）：可多选，被关联的人都能看到
   * 这条配置、以及它对应的「我的笔记」。取代原先的**单人归属**（归属人/归属人ID）。
   *
   * 候选项来自用户目录（`linkSource: 'users'`，value 是用户 record id）。
   * ⚠️ 存的是 record id 而不是姓名/openId：姓名会重名，openId 跨应用不一致。
   * ⚠️ 后端可见性判据是 `source-cred.ts` 的 `sourceVisibleTo()`（唯一一处），
   *    旧的「归属人ID」作为**存量兼容**分支保留，两者任一命中即可见。
   */
  {
    key: '关联用户',
    label: '用户',
    width: '160px',
    form: true,
    type: 'link',
    linkMulti: true,
    linkSource: 'users',
    readonlyPerm: 'getnote:write',
    hint: '可关联多人，被关联的人能共同查看本配置对应的笔记。新建配置时自动归属本人。',
    /**
     * 按用户筛选：字段存的是 record id **数组**，等值匹配必然落空（而且选完之后
     * 内存路径里展示值已换成姓名）⇒ 必须用 `<字段>__has`（成员包含，后端同时认 id 与名称）。
     * 选项走 `linkSource: 'users'` 的人员目录，提交的是 record id。
     */
    filter: true,
    filterParam: '关联用户__has',
  },
  // 「归属人ID」是单人归属时代的字段：后端可见性判据仍兼容它，但**不再作为界面筛选项**
  // （2026-09-17 峰哥要求隐藏 —— 它已被「关联用户」取代，留在筛选区只会让人困惑）。
  // 列定义整个去掉即可，数据与后端逻辑都不受影响。
  {
    key: '笔记类型',
    label: '笔记类型',
    form: true,
    type: 'select',
    dictKey: '笔记类型',
    required: true,
    width: '130px',
    filter: true,
    filterType: 'select',
  },
  {
    key: '收取频率',
    label: '收取频率',
    form: true,
    type: 'select',
    dictKey: '收取频率',
    required: true,
    width: '120px',
    hint: '后台每 15 分钟巡检一次，按这里配的节奏决定这条是否真的去拉',
  },
  {
    key: '启用状态',
    label: '启用状态',
    form: true,
    type: 'select',
    options: ['启用', '停用'],
    required: true,
    width: '100px',
    filter: true,
    filterType: 'select',
  },
  { key: '上次同步时间', label: '上次同步时间', form: false, type: 'datetime', width: '170px' },
  { key: '上次同步结果', label: '上次同步结果', form: false, width: '320px' },

  // ── 仅表单（列表不展示）────────────────────
  {
    key: 'apiKey',
    label: 'API Key',
    form: true,
    type: 'text',
    list: false,
    width: '100%',
    hint: '得到大脑开放平台创建应用后拿到的 API Key（形如 gk_live_xxx）。编辑时留空表示不修改',
  },
  {
    key: 'clientId',
    label: 'Client ID',
    form: true,
    type: 'text',
    list: false,
    width: '100%',
    hint: '形如 cli_xxx，与 API Key 成对拿到的。编辑时留空表示不修改',
  },
  { key: '备注', label: '备注', form: true, type: 'textarea', list: false },
];
