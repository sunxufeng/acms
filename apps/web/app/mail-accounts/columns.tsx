import type { CrudColumn } from '../../components/CrudPage';

export const COLUMNS: CrudColumn[] = [
  { key: '账户名称', label: '账户名称', width: '140px', form: true, required: true, filter: true },
  { key: '邮箱地址', label: '邮箱地址', width: '200px', form: true },
  { key: '归属人员', label: '归属人员', width: '120px', form: true, filter: true },
  { key: 'IMAP服务器', label: 'IMAP服务器', width: '160px', form: true, required: true, hint: '如 imap.qq.com / imap.gmail.com' },
  { key: 'IMAP端口', label: '端口', width: '90px', form: true, required: true, type: 'number' },
  { key: '使用SSL', label: 'SSL', width: '90px', form: true, type: 'select', options: ['是', '否'], required: true },
  { key: '用户名', label: '登录用户名', width: '180px', form: true, hint: '多数邮箱与邮箱地址相同' },
  {
    key: '密码',
    label: '密码/授权码',
    width: '160px',
    form: true,
    type: 'text',
    list: false,
    hint: '使用邮箱「授权码」而非登录密码；编辑时若显示 •••••• 或留空，表示保留原密码',
  },
  { key: '收取频率', label: '收取频率', width: '120px', form: true, type: 'select', options: ['每15分钟', '每30分钟', '每小时', '每天'], required: true },
  {
    key: '发件箱文件夹',
    label: '发件箱文件夹',
    width: '160px',
    form: true,
    list: false,
    hint: '留空则自动探测（按 \\Sent 标志或 Sent / 已发送 / 发件箱 等常见名称）。探测不到时在这里手填 IMAP 文件夹完整路径，如 Sent Messages、INBOX.已发送',
  },
  { key: '过滤规则', label: '过滤规则(JSON)', width: '160px', form: true, type: 'textarea', list: false, hint: '可选，如 {"fromDomain":"school.edu","onlyWithAttachment":true}' },
  { key: '启用', label: '状态', width: '100px', form: true, type: 'select', options: ['启用', '停用'], filter: true, required: true },
  { key: '最后收取时间', label: '最后收取时间', width: '160px', form: false, type: 'datetime' },
  { key: '最后收取结果', label: '最后收取结果', width: '280px', form: false },
];
