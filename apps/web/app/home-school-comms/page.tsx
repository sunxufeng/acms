'use client';

import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';

const 沟通方式_OPTS = ['电话', '微信', '邮件', '面谈', '家长会', '其他'];
const 家长反馈态度_OPTS = ['认可', '基本认可', '有异议', '待回复'];
const 闭环状态_OPTS = ['无需跟进', '待跟进', '跟进中', '已闭环'];
const 信息敏感级别_OPTS = ['内部', '敏感', '高度敏感'];

const COLUMNS: CrudColumn[] = [
  { key: '关联学生编号', label: '学生', width: '110px' },
  { key: '家长', label: '家长', width: '100px', form: true, type: 'text' },
  { key: '沟通内容', label: '沟通内容', form: true, type: 'textarea' },
  { key: '沟通时间', label: '沟通时间', width: '120px', form: true, type: 'date' },
  { key: '沟通方式', label: '沟通方式', width: '100px', filter: true, filterOptions: 沟通方式_OPTS, form: true, type: 'select', options: 沟通方式_OPTS },
  { key: '沟通主题', label: '沟通主题', width: '100px' },
  { key: '关联监护人', label: '关联监护人', width: '110px' },
  { key: '沟通人', label: '沟通人', width: '100px' },
  { key: '家长反馈态度', label: '家长反馈态度', width: '120px', filter: true, filterOptions: 家长反馈态度_OPTS, form: true, type: 'select', options: 家长反馈态度_OPTS },
  { key: '家长反馈', label: '家长反馈', form: true, type: 'textarea' },
  { key: '待办事项', label: '待办事项', form: true, type: 'textarea' },
  { key: '待办负责人', label: '待办负责人', width: '110px' },
  { key: '跟进截止日期', label: '跟进截止', width: '120px', form: true, type: 'date' },
  { key: '闭环状态', label: '闭环状态', width: '100px', filter: true, filterOptions: 闭环状态_OPTS, form: true, type: 'select', options: 闭环状态_OPTS },
  { key: '闭环日期', label: '闭环日期', width: '120px', form: true, type: 'date' },
  { key: '信息敏感级别', label: '敏感级别', width: '100px', filter: true, filterOptions: 信息敏感级别_OPTS, form: true, type: 'select', options: 信息敏感级别_OPTS },
];

export default function HomeSchoolCommsPage() {
  return (
    <CrudPage
      title="家校沟通"
      subtitle="家长沟通与待办闭环（M1 学生域）"
      search={{ placeholder: '搜索家长…' }}
      columns={COLUMNS}
      statusField="闭环状态"
      api={{
        list: (p) => api.listHomeSchoolComms(p),
        create: (d) => api.createHomeSchoolComm(d),
        update: (id, d) => api.updateHomeSchoolComm(id, d),
        archive: (id) => api.archiveHomeSchoolComm(id),
      }}
    />
  );
}
