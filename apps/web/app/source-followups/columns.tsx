import Link from 'next/link';
import type { CrudColumn } from '../../components/CrudPage';
import { enrichFromNotes, type NoteAutoFillSpec } from '../../lib/noteAutoFill';
import { STUDENT_ENGLISH_KEY, studentLabel } from '../../components/CrudPage';

// 列表列顺序（listOrder）：联系人 → 沟通主题 → 跟进时间 → 跟进状态 → 活动类型 → 负责人，
// 外加组件自动追加的「操作」列（含 AI 总结）。付款状态 在列表中隐藏（保留在表单）。
// 联系人列点击跳转「联系人管理」的只读详情页（招生阶段人还没入学，对象是卫瓴线索）。
// 「学生」改为非必填且从列表移除：确认入学后再回填，学生 360 聚合仍靠「关联学生编号」。
// 其余字段设为 list:false，仅在新建/编辑表单中可用；新建/编辑表单参考家校沟通编辑页面。
export const COLUMNS: CrudColumn[] = [
  {
    key: '关联联系人',
    label: '联系人',
    width: '200px',
    form: true,
    type: 'weilingContact',
    required: true,
    listOrder: 1,
    render: (v, row) => {
      const name = String(v ?? '');
      if (!name) return <span style={{ color: 'var(--fg-tertiary)' }}>—</span>;
      // 后端已把 contact_id 解析成姓名，__link 里保留 id，用于跳联系人详情
      const ids = row['关联联系人__link'] as string[] | undefined;
      const id = Array.isArray(ids) ? ids[0] : '';
      return id ? (
        <Link href={`/weiling-contacts/${id}`} style={{ color: 'var(--accent)', fontWeight: 700 }}>{name}</Link>
      ) : (
        <span style={{ fontWeight: 700 }}>{name}</span>
      );
    },
  },
  {
    key: '关联学生',
    label: '学生',
    width: '180px',
    form: true,
    type: 'student',
    required: false,
    list: false,
    render: (_v, row) => {
      const name = studentName(row);
      if (!name) return <span style={{ color: 'var(--fg-tertiary)' }}>—</span>;
      return <span style={{ color: 'var(--accent)', fontWeight: 700 }}>{studentLabel(name, row[STUDENT_ENGLISH_KEY])}</span>;
    },
  },
  { key: '跟进时间', label: '跟进时间', width: '150px', form: true, type: 'datetime', listOrder: 3 },
  { key: '跟进状态', label: '跟进状态', width: '110px', filter: true, form: true, type: 'select', dictKey: '跟进状态', listOrder: 4 },
  { key: '活动类型', label: '活动类型', width: '110px', filter: true, form: true, type: 'select', dictKey: '活动类型', listOrder: 5 },
  { key: '跟进负责人', label: '负责人', width: '110px', listOrder: 6 },
  { key: '付款状态', label: '付款状态', width: '110px', filter: true, form: true, type: 'select', dictKey: '付款状态', list: false },
  // ── 参考家校沟通编辑页面新增的字段 ──
  { key: '家长', label: '家长', width: '110px', list: false, form: true, type: 'parent', dependsOn: '关联学生', required: true },
  { key: '家长反馈态度', label: '家长反馈态度', width: '130px', list: false, filter: true, form: true, type: 'select', dictKey: '家长反馈态度' },
  // openRecord：首列已让给联系人（跳联系人详情），这里点击主题进入本条跟进的只读详情页
  { key: '沟通主题', label: '沟通主题', width: '120px', form: true, listOrder: 2, openRecord: true },
  { key: '沟通总结', label: '沟通总结（报告）', list: false, form: true, type: 'markdown' },
  { key: '沟通明细', label: '沟通明细（MD 对话记录）', list: false, form: true, type: 'markdown',
    // 原始记录属正式留痕，用专项权限控制：无 md:edit 只能浏览，无 md:import 不显示导入按钮
    mdEditPerm: 'md:edit', mdImportPerm: 'md:import' },
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

/** 关联联系人（后端已解析为姓名；拿不到时回退「关联学生」） */
export function contactName(row: Record<string, unknown>): string {
  const raw = row['关联联系人'];
  const name = Array.isArray(raw)
    ? String((raw[0] as { text?: string } | undefined)?.text ?? raw[0] ?? '')
    : String(raw ?? '');
  return name || studentName(row);
}

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

/**
 * 笔记转换预填：从「沟通总结/沟通明细」里解析出时间与负责人。
 *
 * 解析实现统一在 `lib/noteAutoFill.ts`（全站共用一套），这里只声明本模块的字段规则。
 * ⚠️ 只填当前为空的字段，笔记映射已写入或用户已改的值不覆盖。
 */
const SPEC: NoteAutoFillSpec = {
  sourceKeys: ['沟通总结', '沟通明细'],
  patterns: [
    {
      key: '沟通主题',
      patterns: [/沟通主题\s*[:：]\s*(.+)/, /主题\s*[:：]\s*(.+)/, /事由\s*[:：]\s*(.+)/, /跟进事项\s*[:：]\s*(.+)/],
    },
  ],
  // 跟进时间是 datetime 字段
  datetime: {
    key: '跟进时间',
    dateKeywords: ['跟进时间', '跟进日期', '沟通时间', '时间', '日期'],
    timeKeywords: ['跟进时间', '沟通时间', '时间'],
  },
};

export function parseSourceFollowupFromSummary(
  values: Record<string, unknown>,
  ctx?: { userName?: string },
): Record<string, unknown> {
  return enrichFromNotes(values, SPEC, { 跟进负责人: ctx?.userName ?? '' });
}
