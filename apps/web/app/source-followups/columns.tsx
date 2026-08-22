import type { CrudColumn } from '../../components/CrudPage';

// 列表列顺序（listOrder）：学生 → 沟通主题 → 跟进时间 → 跟进状态 → 活动类型 → 负责人，
// 外加组件自动追加的「操作」列（含 AI 总结）。付款状态 在列表中隐藏（保留在表单）。
// 学生列点击直接跳转「这一条招生跟进记录」的只读详情页（不再打开编辑表单）。
// 其余字段设为 list:false，仅在新建/编辑表单中可用；新建/编辑表单参考家校沟通编辑页面。
export const COLUMNS: CrudColumn[] = [
  {
    key: '关联学生',
    label: '学生',
    width: '120px',
    form: true,
    type: 'student',
    required: true,
    openRecord: true,
    listOrder: 1,
    render: (_v, row) => {
      const name = studentName(row);
      if (!name) return <span style={{ color: 'var(--fg-tertiary)' }}>—</span>;
      return <span style={{ color: 'var(--accent)' }}>{name}</span>;
    },
  },
  { key: '沟通主题', label: '沟通主题', width: '120px', form: true, listOrder: 2 },
  { key: '跟进时间', label: '跟进时间', width: '150px', form: true, type: 'datetime', listOrder: 3 },
  { key: '跟进状态', label: '跟进状态', width: '110px', filter: true, form: true, type: 'select', dictKey: '跟进状态', listOrder: 4 },
  { key: '活动类型', label: '活动类型', width: '110px', filter: true, form: true, type: 'select', dictKey: '活动类型', listOrder: 5 },
  { key: '跟进负责人', label: '负责人', width: '110px', listOrder: 6 },
  { key: '付款状态', label: '付款状态', width: '110px', filter: true, form: true, type: 'select', dictKey: '付款状态', list: false },
  // ── 参考家校沟通编辑页面新增的字段 ──
  { key: '家长', label: '家长', width: '110px', list: false, form: true, type: 'parent', dependsOn: '关联学生', required: true },
  { key: '家长反馈态度', label: '家长反馈态度', width: '130px', list: false, filter: true, form: true, type: 'select', dictKey: '家长反馈态度' },
  { key: '沟通主题', label: '沟通主题', width: '120px', form: true },
  { key: '沟通明细', label: '沟通明细（MD 对话记录）', list: false, form: true, type: 'markdown' },
  { key: '沟通总结', label: '沟通总结（报告）', list: false, form: true, type: 'markdown' },
  { key: '沟通附件清单', label: '附件', width: '180px', list: false, form: true, type: 'attachment' },
  // ── 原有招生字段（保留，仅表单内） ──
  { key: '跟进方式', label: '跟进方式', list: false, form: true, type: 'select', dictKey: '跟进方式' },
  { key: '意向等级', label: '意向等级', list: false, form: true, type: 'select', dictKey: '意向等级' },
  { key: '下次跟进日期', label: '下次跟进', list: false, form: true, type: 'date' },
  { key: '下一步行动', label: '下一步', list: false, form: true, type: 'text' },
  { key: '闭环状态', label: '闭环', list: false, form: true, type: 'select', dictKey: '闭环状态' },
  { key: '原学校', label: '原学校', list: false, form: true, type: 'text' },
  { key: '原学校类型', label: '原学校类型', list: false, form: true, type: 'select', dictKey: '原学校类型' },
  { key: '合同状态', label: '合同状态', list: false, form: true, type: 'select', dictKey: '合同状态' },
  { key: '奖学金金额', label: '奖学金金额', list: false, form: true, type: 'text' },
  { key: '家庭关键决策点', label: '家庭关键决策点', list: false, form: true, type: 'select', dictKey: '家庭关键决策点' },
  { key: '跟进内容', label: '跟进内容', list: false, form: true, type: 'textarea' },
  { key: '参观反馈', label: '参观反馈', list: false, form: true, type: 'textarea' },
  { key: '家长或学生诉求', label: '家长或学生诉求', list: false, form: true, type: 'textarea' },
  { key: '活动参与日期', label: '活动参与日期', list: false, form: true, type: 'date' },
];

export function studentName(row: Record<string, unknown>): string {
  const tryKey = (k: string): string => {
    const v = row[k];
    if (Array.isArray(v) && v.length > 0) {
      const first = v[0];
      if (first && typeof first === 'object') return String((first as { text?: string }).text ?? '');
      return String(first ?? '');
    }
    if (v && typeof v === 'object') return String((v as { text?: string }).text ?? '');
    return String(v ?? '');
  };
  return tryKey('关联学生') || tryKey('关联学生编号');
}
