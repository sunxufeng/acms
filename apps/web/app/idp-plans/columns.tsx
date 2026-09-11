import type { CrudColumn } from '../../components/CrudPage';
import { enrichFromNotes, type NoteAutoFillSpec } from '../../lib/noteAutoFill';
import { STUDENT_ENGLISH_KEY, studentLabel } from '../../components/CrudPage';

// IDP 方案列表仅展示：学生 / 学期 / 导师 / 状态 / 制定日期。
// 复杂结构化字段（人生平衡轮 / 目标列表 / 阶段成果）在「新建 / 编辑」独立页通过可视化编辑器填写，
// 故这里 list:false；列表页通过 createHref/editHref/detailHref 跳转到独立页，不启用 CrudPage 内置表单。
export const COLUMNS: CrudColumn[] = [
  {
    key: '关联学生',
    label: '学生',
    width: '180px',
    form: true,
    type: 'student',
    required: true,
    openRecord: true,
    render: (_v, row) => {
      const name = studentName(row);
      if (!name) return <span style={{ color: 'var(--fg-tertiary)' }}>—</span>;
      return <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{studentLabel(name, row[STUDENT_ENGLISH_KEY])}</span>;
    },
  },
  { key: '学期', label: '学期', width: '100px', filter: true, form: true, type: 'select', dictKey: '学期', required: true },
  { key: '导师', label: '导师', width: '120px', filter: true, form: true, type: 'person' },
  { key: '状态', label: '状态', width: '100px', filter: true, form: true, type: 'select', dictKey: 'IDP状态' },
  { key: '制定日期', label: '制定日期', width: '130px', form: true, type: 'date' },
  // 以下字段在独立编辑页处理，列表不展示
  { key: '展示方式', label: '展示方式', width: '100px', list: false, form: true, type: 'select', dictKey: 'IDP展示方式' },
  { key: '展示内容', label: '展示内容', list: false, form: true, type: 'textarea' },
  { key: '展示亮点', label: '展示亮点', list: false, form: true, type: 'textarea' },
  { key: '邀请人员', label: '邀请人员', width: '140px', list: false, form: true },
  { key: '学生确认时间', label: '学生确认时间', width: '150px', list: false, form: true, type: 'datetime' },
  { key: '导师确认时间', label: '导师确认时间', width: '150px', list: false, form: true, type: 'datetime' },
  { key: '原始文档', label: '原始文档', width: '180px', list: false, form: true, type: 'attachment' },
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

/**
 * 笔记转换预填：从「展示内容/原始文档」里解析出时间与负责人。
 *
 * 解析实现统一在 `lib/noteAutoFill.ts`（全站共用一套），这里只声明本模块的字段规则。
 * ⚠️ 只填当前为空的字段，笔记映射已写入或用户已改的值不覆盖。
 */
const SPEC: NoteAutoFillSpec = {
  sourceKeys: ['展示内容', '原始文档'],
  // 导师是师生既定关系，不默认成登录用户
  dateKeys: [{ key: '制定日期', keywords: ['制定日期', '日期', '时间'] }],
};

export function parseIdpFromSummary(
  values: Record<string, unknown>,
  ctx?: { userName?: string },
): Record<string, unknown> {
  return enrichFromNotes(values, SPEC, {});
}
