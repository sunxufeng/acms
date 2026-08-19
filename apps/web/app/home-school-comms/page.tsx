'use client';

import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';

// 列表仅展示：学生 / 沟通人 / 沟通方式 / 沟通时间 / 沟通主题，外加组件自动的「操作」列。
// 其余字段设为 list:false，仅在新建/编辑表单中可用。
const COLUMNS: CrudColumn[] = [
  { key: '关联学生', label: '学生', width: '120px', form: true, type: 'student', required: true },
  { key: '家长', label: '家长', width: '110px', list: false, form: true, type: 'parent', dependsOn: '关联学生', required: true },
  { key: '沟通人', label: '沟通人', width: '100px', form: true, type: 'person' },
  { key: '沟通方式', label: '沟通方式', width: '110px', filter: true, form: true, type: 'select', dictKey: '沟通方式' },
  { key: '家长反馈态度', label: '家长反馈态度', width: '130px', list: false, filter: true, form: true, type: 'select', dictKey: '家长反馈态度' },
  { key: '沟通主题', label: '沟通主题', width: '120px' },
  { key: '沟通内容', label: '沟通内容', list: false, form: true, type: 'textarea' },
  { key: '沟通时间', label: '沟通时间', width: '130px', form: true, type: 'date' },
  { key: '沟通明细', label: '沟通明细（MD 对话记录）', list: false, form: true, type: 'textarea' },
  { key: '沟通总结', label: '沟通总结（报告）', list: false, form: true, type: 'textarea' },
  { key: '沟通附件清单', label: '附件', width: '180px', list: false, form: true, type: 'attachment' },
  { key: '家长反馈', label: '家长反馈', list: false, form: true, type: 'textarea' },
  { key: '待办事项', label: '待办事项', list: false, form: true, type: 'textarea' },
  { key: '待办负责人', label: '待办负责人', width: '110px', list: false },
  { key: '跟进截止日期', label: '跟进截止', width: '130px', list: false, form: true, type: 'date' },
  { key: '闭环状态', label: '闭环状态', width: '100px', list: false, filter: true, form: true, type: 'select', dictKey: '家校闭环状态' },
  { key: '闭环日期', label: '闭环日期', width: '130px', list: false, form: true, type: 'date' },
  { key: '信息敏感级别', label: '敏感级别', width: '100px', list: false, filter: true, form: true, type: 'select', dictKey: '信息敏感级别' },
];

export default function HomeSchoolCommsPage() {
  return (
    <CrudPage
      title="家校沟通"
      subtitle="家长沟通与待办闭环（M1 学生域）"
      search={{ placeholder: '搜索学生…' }}
      columns={COLUMNS}
      statusField="闭环状态"
      inlineEdit
      api={{
        list: (p) => api.listHomeSchoolComms(p),
        create: (d) => api.createHomeSchoolComm(d),
        update: (id, d) => api.updateHomeSchoolComm(id, d),
        archive: (id) => api.archiveHomeSchoolComm(id),
      }}
    />
  );
}
