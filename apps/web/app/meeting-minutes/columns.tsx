import type { CrudColumn } from '../../components/CrudPage';

/**
 * 日期显示：SQL 自建表没有飞书字段元数据，日期字段读出来是毫秒时间戳（number），
 * 直接渲染会显示成一串数字，这里统一格式化。
 */
function fmtTime(v: unknown, withTime: boolean): string {
  if (v == null || v === '') return '—';
  const raw = typeof v === 'number' ? v : /^\d+$/.test(String(v).trim()) ? Number(v) : new Date(String(v)).getTime();
  if (!raw || Number.isNaN(raw)) return String(v);
  const d = new Date(raw);
  const p = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return withTime ? `${date} ${p(d.getHours())}:${p(d.getMinutes())}` : date;
}

/**
 * 会议纪要列定义。
 *
 * 结构照搬「日常跟进」，但主体从「学生」换成「部门」：
 *  - 沟通方式 → 会议类型（字典：周会 / 月度会议 / 年中会 / 临时会议 …）
 *  - 沟通主题 → 会议议题
 *  - 沟通时间 → 会议时间（列表排序与范围筛选字段，另有开始/结束时间存具体时刻）
 *  - 沟通明细 / 沟通总结 → 会议明细 / 会议总结（详情页只读展示）
 *  - 待办事项 → 待办事宜
 * 飞书字段名即 key，与后端 lifecycle.meta.ts 的 dateFields / timeRange / rangeField 严格对齐。
 */
export const COLUMNS: CrudColumn[] = [
  {
    key: '部门',
    label: '部门',
    width: '130px',
    form: true,
    type: 'department',
    required: true,
    filter: true,
    openRecord: true,
    render: (_v, row) => {
      const name = deptName(row);
      if (!name) return <span style={{ color: 'var(--fg-tertiary)' }}>—</span>;
      return <span style={{ color: 'var(--accent)', fontWeight: 700 }}>{name}</span>;
    },
  },
  { key: '会议类型', label: '会议类型', width: '110px', filter: true, form: true, type: 'select', dictKey: '会议类型', required: true },
  { key: '会议议题', label: '会议议题', width: '180px', filter: true, filterType: 'text', form: true, required: true },
  { key: '会议地点', label: '会议地点', width: '120px', filter: true, filterType: 'text', form: true },
  {
    key: '会议时间',
    label: '会议时间',
    width: '120px',
    form: true,
    type: 'date',
    required: true,
    render: (v) => fmtTime(v, false),
  },
  { key: '开始时间', label: '开始时间', width: '150px', form: true, type: 'datetime', render: (v) => fmtTime(v, true) },
  {
    key: '结束时间',
    label: '结束时间',
    width: '150px',
    form: true,
    type: 'datetime',
    // 结束时间必须晚于开始时间（后端 meta.timeRange 也会校验，这里只是给录入提示）
    hint: '结束时间须晚于开始时间',
    render: (v) => fmtTime(v, true),
  },
  { key: '主持人', label: '主持人', width: '100px', form: true, type: 'person' },
  { key: '记录人', label: '记录人', width: '100px', list: false, form: true, type: 'person' },
  { key: '参会人员', label: '参会人员', width: '160px', list: false, form: true, type: 'textarea' },
  { key: '缺席人员', label: '缺席人员', width: '160px', list: false, form: true, type: 'textarea' },
  { key: '列席人员', label: '列席人员', width: '160px', list: false, form: true, type: 'textarea' },
  { key: '会议明细', label: '会议明细（MD 会议记录）', list: false, form: true, type: 'markdown' },
  { key: '会议总结', label: '会议总结（纪要）', list: false, form: true, type: 'markdown' },
  { key: '待办事宜', label: '待办事宜', list: false, form: true, type: 'textarea' },
  {
    key: '状态',
    label: '状态',
    width: '100px',
    filter: true,
    form: true,
    type: 'select',
    dictKey: '会议状态',
  },
  {
    key: '敏感级别',
    label: '敏感级别',
    width: '100px',
    list: false,
    filter: true,
    form: true,
    type: 'select',
    dictKey: '信息敏感级别',
  },
];

export function deptName(row: Record<string, unknown>): string {
  const v = row['部门'];
  if (Array.isArray(v) && v.length > 0) {
    const first = v[0];
    if (first && typeof first === 'object') return String((first as { text?: string }).text ?? '');
    return String(first ?? '');
  }
  if (v && typeof v === 'object') return String((v as { text?: string }).text ?? '');
  return String(v ?? '');
}
