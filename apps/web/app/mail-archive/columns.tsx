import type { CrudColumn } from '../../components/CrudPage';

export const COLUMNS: CrudColumn[] = [
  { key: '发件人', label: '发件人', width: '200px', filter: true, openRecord: true },
  { key: '收件人', label: '收件人', width: '200px', filter: true },
  { key: '主题', label: '主题', width: '320px', openRecord: true },
  { key: '归属账户', label: '归属账户', width: '130px', filter: true },
  { key: '邮箱文件夹', label: '文件夹', width: '140px', filter: true },
  { key: '关联学生', label: '关联学生', width: '120px', filter: true },
  { key: '发送时间', label: '发送时间', width: '170px', type: 'datetime' },
  { key: '附件数', label: '附件', width: '80px', type: 'number' },
  { key: '是否已读', label: '已读', width: '90px', type: 'select', options: ['是', '否'], filter: true },
];
