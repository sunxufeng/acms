import type { CrudColumn } from '../../components/CrudPage';
import { COMM_SPEC, enrichFromNotes } from '../../lib/noteAutoFill';
import { STUDENT_ENGLISH_KEY, studentLabel } from '../../components/CrudPage';
import { STUDENT_RECORD_TYPES, STUDENT_RECORD_TYPE_FIELD } from '@acms/contracts';

/**
 * 「学生记录」列定义（2026-09-18 三合一）。
 *
 * 一张表装着三类记录（日常跟进 / 家校沟通 / 学生观察），靠「记录类型」区分。
 * 两条设计线索，别混：
 *
 *  ① **词表随类型切换**（表头措辞）：日常跟进与家校沟通用「沟通人 / 沟通主题 / 沟通时间」，
 *     学生观察用「观察人 / 主题 / 观察时间」，看「全部」时用中性词。
 *     实现方式是**按当前筛选的类型重新生成列**（见 `buildStudentRecordColumns(activeType)`），
 *     而不是给 CrudPage 加动态 label —— 后者要改 9 处消费点（表头 / 表单 / 筛选 / 导出），
 *     收益不抵风险。
 *
 *  ② **字段随类型显隐**（表单里出现什么）：用 CrudPage 既有的 `showIf`。
 *     ⚠️ 显隐只作用于**表单**；已填的值提交时照常提交，不会因为切类型被清空
 *     （CrudPage 的既有语义，避免「改成家校沟通再改回来」丢数据）。
 *
 * 数据库字段名一律保持「沟通X」不变 —— 只有**界面措辞**随类型走。这样既不用迁移字段，
 * 也复用了既有的字典同步逻辑（dict.service 按字段名找字典）。
 */

/** 三类记录的类型值（真源在 contracts，与后端权限映射共用同一份） */
export const RECORD_TYPES: string[] = STUDENT_RECORD_TYPES.map((t) => t.value);

interface TypeWords {
  person: string;
  theme: string;
  time: string;
  summary: string;
  detail: string;
  note: string;
}

const WORDS: Record<string, TypeWords> = {
  日常跟进: { person: '沟通人', theme: '沟通主题', time: '沟通时间', summary: '沟通总结（报告）', detail: '沟通明细（MD 对话记录）', note: '沟通人备注' },
  家校沟通: { person: '沟通人', theme: '沟通主题', time: '沟通时间', summary: '沟通总结（报告）', detail: '沟通明细（MD 对话记录）', note: '沟通人备注' },
  学生观察: { person: '观察人', theme: '主题', time: '观察时间', summary: '观察总结（MD）', detail: '观察明细（MD）', note: '观察人备注' },
};

/** 未指定类型（列表切在「全部」）时的中性词 */
const NEUTRAL_WORDS: TypeWords = {
  person: '记录人',
  theme: '主题',
  time: '时间',
  summary: '总结（MD）',
  detail: '明细（MD）',
  note: '记录人备注',
};

export function wordsForType(type?: string): TypeWords {
  return (type && WORDS[type]) || NEUTRAL_WORDS;
}

/**
 * 生成列定义。
 * @param activeType 列表当前筛选的记录类型；'全部'/undefined 时用中性词表
 */
export function buildStudentRecordColumns(activeType?: string): CrudColumn[] {
  const w = wordsForType(activeType);
  const onlyObservation = activeType === '学生观察';
  /** 表单条件显隐：只有家校沟通才有家长相关字段 */
  const isHomeSchool = (f: Record<string, unknown>) => f[STUDENT_RECORD_TYPE_FIELD] === '家校沟通';
  /** 表单条件显隐：只有学生观察才有观察类型 */
  const isObservation = (f: Record<string, unknown>) => f[STUDENT_RECORD_TYPE_FIELD] === '学生观察';

  return [
    {
      // 记录类型放第一列：这是三类记录唯一的区分维度，不看它就看不懂这张列表。
      // ⚠️ 只在「全部」Tab 下显示该列（切到某一类型后所有行都一样，列没有信息量）；
      //    `filter` 关掉 —— 类型由页面顶部 Tab 控制，两套筛选并存会互相矛盾
      //    （筛选器说「学生观察」而 Tab 传的是「日常跟进」）。
      key: STUDENT_RECORD_TYPE_FIELD,
      label: '记录类型',
      width: '110px',
      form: true,
      type: 'select',
      dictKey: STUDENT_RECORD_TYPE_FIELD,
      required: true,
      list: !activeType,
      filter: false,
    },
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
        return <span style={{ color: 'var(--accent)', fontWeight: 700 }}>{studentLabel(name, row[STUDENT_ENGLISH_KEY])}</span>;
      },
    },
    // 观察类不用「沟通方式」，用「观察类型」这个分类维度（沿用学生观察模块的既有做法）
    {
      key: '沟通方式',
      label: '沟通方式',
      width: '110px',
      filter: true,
      filterOp: 'contains',
      form: true,
      type: 'select',
      dictKey: '沟通方式',
      list: !onlyObservation,
      showIf: (f) => !isObservation(f),
    },
    {
      key: '观察类型',
      label: '观察类型',
      width: '110px',
      filter: true,
      filterOp: 'contains',
      form: true,
      type: 'select',
      dictKey: '观察类型',
      list: onlyObservation,
      showIf: isObservation,
    },
    // ── 家校沟通专有 ────────────────────────────────
    {
      key: '家长',
      label: '家长',
      width: '110px',
      list: false,
      form: true,
      type: 'parent',
      dependsOn: '关联学生',
      showIf: isHomeSchool,
    },
    {
      key: '家长反馈态度',
      label: '家长反馈态度',
      width: '130px',
      list: false,
      filter: true,
      filterOp: 'contains',
      form: true,
      type: 'select',
      dictKey: '家长反馈态度',
      showIf: isHomeSchool,
    },
    { key: '家长反馈', label: '家长反馈', list: false, form: true, type: 'markdown', showIf: isHomeSchool },
    // ── 公共字段 ────────────────────────────────────
    { key: '沟通主题', label: w.theme, width: '120px', form: true },
    { key: '沟通时间', label: w.time, width: '150px', form: true, type: 'datetime' },
    // 「记录人」放在「时间」之后（2026-09-19 峰哥要求）：列表从左到右读成
    // 「谁的学生 → 什么方式 → 什么事 → 什么时候 → 谁记的」，跟进人不是首要信息。
    // ⚠️ 列顺序只影响列表；表单里的顺序仍由 `form` 列数组顺序决定（这里也跟着往后挪了一位，
    //    因为同一份数组既管列表也管表单，若要拆开得另加 formOrder 之类的机制）。
    { key: '沟通人', label: w.person, width: '100px', form: true, type: 'person' },
    { key: '沟通附件清单', label: '附件', width: '180px', list: false, form: true, type: 'attachment' },
    { key: '沟通时长(分钟)', label: '时长(分钟)', width: '130px', list: false, form: true, type: 'number' },
    { key: '沟通总结', label: w.summary, list: false, form: true, type: 'markdown' },
    {
      key: '沟通明细',
      label: w.detail,
      list: false,
      form: true,
      type: 'markdown',
      // 原始记录属正式留痕，用专项权限控制：无 md:edit 只能浏览，无 md:import 不显示导入按钮
      mdEditPerm: 'md:edit',
      mdImportPerm: 'md:import',
    },
    { key: '沟通人备注', label: w.note, list: false, form: true, type: 'markdown' },
    { key: '待办事项', label: '待办事宜', list: false, form: true, type: 'textarea' },
    { key: '责任人', label: '责任人', width: '110px', list: false, form: true, type: 'person' },
    { key: '跟进截止日期', label: '截止时间', width: '130px', list: false, form: true, type: 'date' },
    {
      key: '闭环状态',
      label: '闭环状态',
      width: '100px',
      list: false,
      filter: true,
      filterOp: 'contains',
      form: true,
      type: 'select',
      dictKey: '家校闭环状态',
    },
    { key: '闭环日期', label: '闭环日期', width: '130px', list: false, form: true, type: 'date' },
    {
      key: '信息敏感级别',
      label: '敏感级别',
      width: '100px',
      list: false,
      filter: true,
      filterOp: 'contains',
      form: true,
      type: 'select',
      dictKey: '信息敏感级别',
    },
    // 关联字段：由后端在学生/监护人变化时回填，不在表单里手填（与合并前家校沟通一致）
    { key: '关联学生编号', label: '关联学生编号', list: false, form: false },
    { key: '关联监护人', label: '关联监护人', list: false, form: false },
  ];
}

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
 * 笔记转换落地时从「沟通总结」里再解析出结构化字段：
 *   时间 / 时长 / 主题；**记录人默认取「笔记归属人」**（笔记是谁的，记录人就该是谁），
 *   只在拿不到归属人时才回退当前登录用户。只填空字段，笔记映射已写入的值不覆盖。
 *
 * 三类的字段名原本就相同（这也是能合并的原因），所以合并后共用同一份解析规则。
 */
export function parseStudentRecordFromSummary(
  values: Record<string, unknown>,
  ctx?: { userName?: string; noteOwner?: string },
): Record<string, unknown> {
  return enrichFromNotes(values, COMM_SPEC, { 沟通人: ctx?.noteOwner || ctx?.userName || '' });
}
