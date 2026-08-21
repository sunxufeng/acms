import type { CrudColumn } from '../../components/CrudPage';

// 列表仅展示：学生 / 沟通人 / 沟通方式 / 沟通主题，外加组件自动的「操作」列。
// 其余字段设为 list:false，仅在新建/编辑表单中可用。
// 与「家校沟通」几乎一致，仅去掉 家长 / 家长反馈态度 / 家长反馈 三个家长相关字段。
// 学生列点击直接跳转到「这一条日常跟进记录」的只读详情页（不再打开编辑表单、不再跳转学生全景）。
export const COLUMNS: CrudColumn[] = [
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
  { key: '沟通人', label: '沟通人', width: '100px', form: true, type: 'person' },
  { key: '沟通方式', label: '沟通方式', width: '110px', filter: true, form: true, type: 'select', dictKey: '沟通方式' },
  { key: '沟通主题', label: '沟通主题', width: '120px', form: true },
  { key: '沟通时间', label: '沟通时间', width: '150px', form: true, type: 'datetime' },
  { key: '沟通附件清单', label: '附件', width: '180px', list: false, form: true, type: 'attachment' },
  { key: '沟通时长(分钟)', label: '沟通时长(分钟)', width: '130px', list: false, form: true, type: 'number' },
  { key: '沟通明细', label: '沟通明细（MD 对话记录）', list: false, form: true, type: 'markdown' },
  { key: '沟通总结', label: '沟通总结（报告）', list: false, form: true, type: 'markdown' },
  { key: '沟通人备注', label: '沟通人备注', list: false, form: true, type: 'markdown' },
  { key: '待办事项', label: '待办事宜', list: false, form: true, type: 'textarea' },
  { key: '责任人', label: '责任人', width: '110px', list: false, form: true, type: 'person' },
  { key: '跟进截止日期', label: '截止时间', width: '130px', list: false, form: true, type: 'date' },
  { key: '闭环状态', label: '闭环状态', width: '100px', list: false, filter: true, form: true, type: 'select', dictKey: '家校闭环状态' },
  { key: '闭环日期', label: '闭环日期', width: '130px', list: false, form: true, type: 'date' },
  { key: '信息敏感级别', label: '敏感级别', width: '100px', list: false, filter: true, form: true, type: 'select', dictKey: '信息敏感级别' },
];

export function studentName(row: Record<string, unknown>): string {
  const v = row['关联学生'];
  if (Array.isArray(v) && v.length > 0) {
    const first = v[0];
    if (first && typeof first === 'object') return String((first as { text?: string }).text ?? '');
    return String(first ?? '');
  }
  if (v && typeof v === 'object') return String((v as { text?: string }).text ?? '');
  return String(v ?? '');
}
