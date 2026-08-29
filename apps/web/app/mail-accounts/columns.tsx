import type { CrudColumn } from '../../components/CrudPage';

/**
 * 列表页只展示 邮箱地址 / 归属人员 / 收取频率 / 最后收取时间 / 最后收取结果 / 状态 / 操作，
 * 其余字段仅出现在新建、编辑表单中（list: false）。
 *
 * 注意：CrudPage 的表格列与表单字段共用这一份数组（表格取 list !== false，表单取 form），
 * 所以数组顺序同时决定两者的排列 —— 这里按列表要求的顺序排，
 * 同时把「账户名称」紧随「邮箱地址」、把 IMAP 技术字段放在靠后，尽量让表单顺序也合理。
 */
export const COLUMNS: CrudColumn[] = [
  // ── 列表可见 ──────────────────────────────
  { key: '邮箱地址', label: '邮箱地址', width: '220px', form: true },
  // 账户名称是归档记录「归属账户」的取值依据，必填但不在列表展示
  { key: '账户名称', label: '账户名称', width: '140px', form: true, required: true, list: false },
  { key: '归属人员', label: '归属人员', width: '120px', form: true, filter: true },
  { key: '收取频率', label: '收取频率', width: '120px', form: true, type: 'select', options: ['每15分钟', '每30分钟', '每小时', '每天'], required: true },
  { key: '最后收取时间', label: '最后收取时间', width: '160px', form: false, type: 'datetime' },
  { key: '最后收取结果', label: '最后收取结果', width: '320px', form: false },
  { key: '启用', label: '状态', width: '100px', form: true, type: 'select', options: ['启用', '停用'], filter: true, required: true },

  // ── 仅表单（列表不展示）────────────────────
  { key: 'IMAP服务器', label: 'IMAP服务器', width: '160px', form: true, required: true, list: false, hint: '如 imap.qq.com / imap.gmail.com' },
  { key: 'IMAP端口', label: '端口', width: '90px', form: true, required: true, type: 'number', list: false },
  { key: '使用SSL', label: 'SSL', width: '90px', form: true, type: 'select', options: ['是', '否'], required: true, list: false },
  { key: '用户名', label: '登录用户名', width: '180px', form: true, list: false, hint: '多数邮箱与邮箱地址相同' },
  {
    key: '密码',
    label: '密码/授权码',
    width: '160px',
    form: true,
    type: 'text',
    list: false,
    hint: '使用邮箱「授权码」而非登录密码；编辑时若显示 •••••• 或留空，表示保留原密码',
  },
  {
    key: '发件箱文件夹',
    label: '发件箱文件夹',
    width: '160px',
    form: true,
    list: false,
    hint: '留空则自动探测（按 \\Sent 标志或 Sent / 已发送 / 发件箱 等常见名称）。探测不到时在这里手填 IMAP 文件夹完整路径，如 Sent Messages、INBOX.已发送',
  },
  { key: '过滤规则', label: '过滤规则(JSON)', width: '160px', form: true, type: 'textarea', list: false, hint: '可选，如 {"fromDomain":"school.edu","onlyWithAttachment":true}' },
];
