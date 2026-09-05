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
  { key: '配置名称', label: '配置名称', form: true, required: true, width: '180px' },
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
    hint: '得到大脑开放平台创建应用后拿到的 API Key（形如 gk_live_xxx）。编辑时留空表示不修改',
  },
  {
    key: 'clientId',
    label: 'Client ID',
    form: true,
    type: 'text',
    list: false,
    hint: '形如 cli_xxx，与 API Key 成对拿到的。编辑时留空表示不修改',
  },
  { key: '备注', label: '备注', form: true, type: 'textarea', list: false },
];
