import type { CrudColumn } from '../../components/CrudPage';

// 学生观察：飞书字段结构照搬「日常跟进表」，故 key（飞书字段名）仍是「沟通X」，
// 但界面统一显示为「观察X」——保留原字段名才能复用 dict.service 的字典同步逻辑。
//
// 与日常跟进的两点差异（2026-09-06 需求）：
//   1. 列表与表单都**不展示**「沟通方式」，改用本表独有的「观察类型」
//      （新生观察 / 日常观察 / 招生观察）作为分类维度；「沟通方式」字段仍建在表里，仅不展示。
//   2. 「沟通总结」在表单里显示为「观察总结（MD）」，与「观察明细」同为 Markdown 编辑器。
//
// 列表展示：学生 / 观察人 / 观察类型 / 主题 / 观察时间，外加组件自动的「操作」列。
// 其余字段 list:false，仅在新建/编辑表单中可用。
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
      return <span style={{ color: 'var(--accent)', fontWeight: 700 }}>{name}</span>;
    },
  },
  { key: '沟通人', label: '观察人', width: '100px', form: true, type: 'person' },
  { key: '观察类型', label: '观察类型', width: '110px', filter: true, form: true, type: 'select', dictKey: '观察类型' },
  { key: '沟通主题', label: '主题', width: '120px', form: true },
  { key: '沟通时间', label: '观察时间', width: '150px', form: true, type: 'datetime' },
  { key: '沟通附件清单', label: '附件', width: '180px', list: false, form: true, type: 'attachment' },
  { key: '沟通时长(分钟)', label: '时长(分钟)', width: '130px', list: false, form: true, type: 'number' },
  { key: '沟通明细', label: '观察明细（MD）', list: false, form: true, type: 'markdown' },
  { key: '沟通总结', label: '观察总结（MD）', list: false, form: true, type: 'markdown' },
  { key: '沟通人备注', label: '观察人备注', list: false, form: true, type: 'markdown' },
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
