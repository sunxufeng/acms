'use client';

import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';

// 列表仅展示：学生 / 沟通人 / 沟通方式 / 沟通时间 / 沟通主题，外加组件自动的「操作」列。
// 其余字段设为 list:false，仅在新建/编辑表单中可用。
// 学生列点击直接打开「这一条家校沟通记录」的编辑/详情表单（不再跳转学生全景）。
const COLUMNS: CrudColumn[] = [
  {
    key: '关联学生',
    label: '学生',
    width: '120px',
    form: true,
    type: 'student',
    required: true,
    openRecord: true,
    render: (_v, row) => {
      const name = studentName(row);
      if (!name) return <span style={{ color: 'var(--fg-tertiary)' }}>—</span>;
      return <span style={{ color: 'var(--accent)' }}>{name}</span>;
    },
  },
  { key: '家长', label: '家长', width: '110px', list: false, form: true, type: 'parent', dependsOn: '关联学生', required: true },
  { key: '沟通人', label: '沟通人', width: '100px', form: true, type: 'person' },
  { key: '沟通方式', label: '沟通方式', width: '110px', filter: true, form: true, type: 'select', dictKey: '沟通方式' },
  { key: '家长反馈态度', label: '家长反馈态度', width: '130px', list: false, filter: true, form: true, type: 'select', dictKey: '家长反馈态度' },
  { key: '沟通主题', label: '沟通主题', width: '120px', form: true },
  { key: '沟通内容', label: '沟通内容', list: false, form: true, type: 'textarea' },
  { key: '沟通时间', label: '沟通时间', width: '130px', form: true, type: 'date' },
  { key: '沟通明细', label: '沟通明细（MD 对话记录）', list: false, form: true, type: 'markdown' },
  { key: '沟通总结', label: '沟通总结（报告）', list: false, form: true, type: 'markdown' },
  { key: '沟通附件清单', label: '附件', width: '180px', list: false, form: true, type: 'attachment' },
  { key: '家长反馈', label: '家长反馈', list: false, form: true, type: 'textarea' },
  { key: '待办事项', label: '待办事宜', list: false, form: true, type: 'textarea' },
  { key: '责任人', label: '责任人', width: '110px', list: false, form: true, type: 'person' },
  { key: '跟进截止日期', label: '截止时间', width: '130px', list: false, form: true, type: 'date' },
  { key: '闭环状态', label: '闭环状态', width: '100px', list: false, filter: true, form: true, type: 'select', dictKey: '家校闭环状态' },
  { key: '闭环日期', label: '闭环日期', width: '130px', list: false, form: true, type: 'date' },
  { key: '信息敏感级别', label: '敏感级别', width: '100px', list: false, filter: true, form: true, type: 'select', dictKey: '信息敏感级别' },
];

function studentName(row: Record<string, unknown>): string {
  const v = row['关联学生'];
  if (Array.isArray(v) && v.length > 0) {
    const first = v[0];
    if (first && typeof first === 'object') return String((first as { text?: string }).text ?? '');
    return String(first ?? '');
  }
  if (v && typeof v === 'object') return String((v as { text?: string }).text ?? '');
  return String(v ?? '');
}

export default function HomeSchoolCommsPage() {
  return (
    <CrudPage
      title="家校沟通"
      subtitle="家长沟通与待办闭环（M1 学生域）"
      search={{ placeholder: '搜索学生…' }}
      columns={COLUMNS}
      statusField="闭环状态"
      inlineEdit
      standaloneForm
      api={{
        list: (p) => api.listHomeSchoolComms(p),
        create: (d) => api.createHomeSchoolComm(d),
        update: (id, d) => api.updateHomeSchoolComm(id, d),
        archive: (id) => api.archiveHomeSchoolComm(id),
      }}
      rowExtraActions={[
        {
          label: 'AI 总结',
          run: async (row, reload) => {
            const id = String(row.id);
            const res = await api.aiSummarizePrepare(id);
            const hasSource = (res.attachments?.length ?? 0) > 0 || (res.content ?? '').trim().length > 0;
            if (!hasSource) throw new Error('该记录没有可读取的附件或沟通内容，无法生成总结');
            await api.aiSummarizeMergeAll(id, true, true);
            reload();
          },
        },
      ]}
    />
  );
}
