import Link from 'next/link';
import type { CrudColumn } from '../../components/CrudPage';
import { COMM_SPEC, enrichFromNotes } from '../../lib/noteAutoFill';
import { STUDENT_ENGLISH_KEY, studentLabel } from '../../components/CrudPage';
import { STUDENT_RECORD_TYPES, STUDENT_RECORD_TYPE_FIELD, defaultFollowupOwner } from '@acms/contracts';

/**
 * 「学生记录」列定义（2026-09-19 三合一的第二轮改版）。
 *
 * 一张表装着三类记录（日常跟进 / 家校沟通 / 学生观察），靠「记录类型」区分。
 * 四条设计线索，别混：
 *
 *  ① **词表随类型切换**（表头措辞）：日常跟进与家校沟通用「沟通人 / 沟通主题 / 沟通时间」，
 *     学生观察用「观察人 / 主题 / 观察时间」，看「全部」时用中性词。
 *     实现方式是**按当前筛选的类型重新生成列**，而不是给 CrudPage 加动态 label。
 *
 *  ② **字段随类型显隐**：用 CrudPage 既有的 `showIf`。表单与**只读详情页**共用同一判据
 *     （CrudView 也按 showIf 过滤），所以三种类型的界面看到的字段集合一致，风格统一。
 *
 *  ③ **列表顺序与表单顺序分离**：
 *     - 列表列序由 `listOrder` 决定（峰哥要求：主题在最前，学生在它之后）
 *     - 表单顺序由**数组顺序**决定，并按 `section` 分成四块
 *     若混用一套顺序，就没法既满足「列表里主题第一」又满足「表单里主题排在类型/学生之后」。
 *
 *  ④ **数据库字段名一律保持「沟通X」不变**，只有**界面措辞**随类型走 ——
 *     不用迁移字段，也复用了既有的字典同步逻辑（dict.service 按字段名找字典）。
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

/**
 * 沟通类记录的词表（日常跟进 / IDP沟通 / 家校沟通 三者完全相同）。
 *
 * 抽成一个常量而不是抄三遍：IDP沟通 的要求就是「与日常跟进完全相同」，
 * 共享同一份对象才能保证「改了日常跟进的措辞，IDP沟通 跟着变」——
 * 抄三份的话，下次只改一处就会出现同义词不一致（不报错，但看起来像两个东西）。
 */
const COMM_WORDS: TypeWords = {
  person: '沟通人',
  theme: '沟通主题',
  time: '沟通时间',
  summary: '沟通总结（报告）',
  detail: '沟通明细（MD 对话记录）',
  note: '沟通人备注',
};

const WORDS: Record<string, TypeWords> = {
  日常跟进: COMM_WORDS,
  // IDP沟通 / 学生沟通（2026-09-21 新增）：与日常跟进完全相同，共用同一份词表
  IDP沟通: COMM_WORDS,
  学生沟通: COMM_WORDS,
  家校沟通: COMM_WORDS,
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

/** 表单分区标题（跨整行显示，让 20 个字段的长表单分块可读） */
const SECTION_BASE = '基本信息';
const SECTION_CONTENT = '沟通内容';
const SECTION_PARENT = '家长反馈';
const SECTION_CLOSE = '跟进闭环';

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
    // ── 基本信息 ────────────────────────────────────
    {
      // ⚠️ 只在「全部」Tab 下显示该列（切到某一类型后所有行都一样，列没有信息量）；
      //    `filter` 关掉 —— 类型由页面顶部 Tab 控制，两套筛选并存会互相矛盾
      //    （筛选器说「学生观察」而 Tab 传的是「日常跟进」）。
      key: STUDENT_RECORD_TYPE_FIELD,
      label: '记录类型',
      width: '100px',
      form: true,
      type: 'select',
      dictKey: STUDENT_RECORD_TYPE_FIELD,
      required: true,
      list: !activeType,
      listOrder: 3,
      filter: false,
      section: SECTION_BASE,
    },
    {
      // 学生列：点击进**学生档案**（不是本条记录 —— 那个入口在主题列上）。
      // 需要 `关联学生编号` 关联字段有值，后端会解析出 `__link`（学生档案 id 数组）。
      key: '关联学生',
      label: '学生',
      width: '170px',
      form: true,
      type: 'student',
      required: true,
      listOrder: 2,
      section: SECTION_BASE,
      render: (_v, row) => {
        const name = studentName(row);
        if (!name) return <span style={{ color: 'var(--fg-tertiary)' }}>—</span>;
        const label = studentLabel(name, row[STUDENT_ENGLISH_KEY]);
        const ids = row['关联学生编号__link'] as string[] | undefined;
        const sid = Array.isArray(ids) ? ids[0] : '';
        // 没关联到档案就不给链接 —— 点了跳到空列表比不给链接更让人困惑
        if (!sid) return <span style={{ fontWeight: 700 }}>{label}</span>;
        return (
          <Link href={`/students/${sid}`} style={{ color: 'var(--accent)', fontWeight: 700 }}>
            {label}
          </Link>
        );
      },
    },
    {
      // 观察类不用「沟通方式」，用「观察类型」这个分类维度（沿用学生观察模块的既有做法）
      key: '沟通方式',
      label: '沟通方式',
      width: '110px',
      filter: true,
      filterOp: 'contains',
      form: true,
      type: 'select',
      dictKey: '沟通方式',
      list: !onlyObservation,
      listOrder: 4,
      showIf: (f) => !isObservation(f),
      section: SECTION_BASE,
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
      listOrder: 4,
      showIf: isObservation,
      section: SECTION_BASE,
    },
    // ── 沟通内容（峰哥要求：这一组排在「家长反馈」之前）──
    {
      // 主题列：列表第一列，点击进**本条记录**详情（openRecord + 页面的 detailHref）。
      key: '沟通主题',
      label: w.theme,
      width: '200px',
      form: true,
      openRecord: true,
      listOrder: 1,
      section: SECTION_CONTENT,
      render: (v) => {
        const txt = String(v ?? '').trim();
        if (!txt) return <span style={{ color: 'var(--fg-tertiary)' }}>—</span>;
        return <span style={{ color: 'var(--accent)', fontWeight: 700 }}>{txt}</span>;
      },
    },
    { key: '沟通时间', label: w.time, width: '150px', form: true, type: 'datetime', listOrder: 5, section: SECTION_CONTENT },
    { key: '沟通人', label: w.person, width: '100px', form: true, type: 'person', listOrder: 6, section: SECTION_CONTENT },
    { key: '沟通附件清单', label: '附件', width: '180px', list: false, form: true, type: 'attachment', section: SECTION_CONTENT },
    { key: '沟通时长(分钟)', label: '时长(分钟)', width: '130px', list: false, form: true, type: 'number', section: SECTION_CONTENT },
    // ── 家长反馈（仅「家校沟通」类型出现）─────────────
    {
      key: '家长',
      label: '家长',
      width: '110px',
      list: false,
      form: true,
      type: 'parent',
      dependsOn: '关联学生',
      showIf: isHomeSchool,
      section: SECTION_PARENT,
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
      section: SECTION_PARENT,
    },
    { key: '家长反馈', label: '家长反馈', list: false, form: true, type: 'markdown', showIf: isHomeSchool, section: SECTION_PARENT },
    // ── 跟进闭环 ────────────────────────────────────
    { key: '沟通总结', label: w.summary, list: false, form: true, type: 'markdown', section: SECTION_CLOSE },
    {
      key: '沟通明细',
      label: w.detail,
      list: false,
      form: true,
      type: 'markdown',
      // 原始记录属正式留痕，用专项权限控制：无 md:edit 只能浏览，无 md:import 不显示导入按钮
      mdEditPerm: 'md:edit',
      mdImportPerm: 'md:import',
      section: SECTION_CLOSE,
    },
    { key: '沟通人备注', label: w.note, list: false, form: true, type: 'markdown', section: SECTION_CLOSE },
    { key: '待办事项', label: '待办事宜', list: false, form: true, type: 'textarea', section: SECTION_CLOSE },
    { key: '责任人', label: '责任人', width: '110px', list: false, form: true, type: 'person', section: SECTION_CLOSE },
    { key: '跟进截止日期', label: '截止时间', width: '130px', list: false, form: true, type: 'date', section: SECTION_CLOSE },
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
      section: SECTION_CLOSE,
    },
    { key: '闭环日期', label: '闭环日期', width: '130px', list: false, form: true, type: 'date', section: SECTION_CLOSE },
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
      section: SECTION_CLOSE,
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
 * 毫秒时间戳 → 本地时区的 `YYYY-MM-DDTHH:mm`。
 *
 * ⚠️ 必须用**本地时区**（`getFullYear/getHours` 系）而不是 `toISOString()` ——
 * 后者转出来是 UTC，东八区会差 8 小时，把「下午 3 点的会」写成早上 7 点。
 * 格式也要带 `T`：`<input type="datetime-local">` 只认 `YYYY-MM-DDTHH:mm`。
 */
export function msToLocalDateTime(ms?: number): string {
  const n = Number(ms ?? 0);
  if (!n || Number.isNaN(n)) return '';
  const d = new Date(n);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 笔记转换落地时补默认值：
 *   - **沟通主题 ← 笔记标题**、**沟通时间 ← 笔记创建时间**（2026-09-19 峰哥要求）
 *   - **沟通人 ← 笔记归属人**（笔记是谁的，沟通人就该是谁），拿不到才回退登录用户
 *   - **责任人 ← 笔记归属人**（2026-09-21 峰哥要求：责任人要带上「笔记的创建人」），
 *     判据与招生跟进 / 校友跟进 / 实践活动共用 `defaultFollowupOwner()`
 *
 * 主题 / 时间**先塞进去再走 `enrichFromNotes`**，而不是当 `defaults` 传：
 * `defaults` 是最低优先级（只在正文什么都没抽到时才填），而峰哥要的是「笔记标题就是主题」——
 * 笔记标题是用户精心写的，比从正文里正则抽的碎片可靠。
 * 已存在的值一律不覆盖。
 */
export function parseStudentRecordFromSummary(
  values: Record<string, unknown>,
  ctx?: { userName?: string; noteOwner?: string; noteTitle?: string; noteCreatedAt?: number },
): Record<string, unknown> {
  const seeded: Record<string, unknown> = { ...values };
  const has = (k: string) => String(seeded[k] ?? '').trim() !== '';
  if (!has('沟通主题') && ctx?.noteTitle) seeded['沟通主题'] = ctx.noteTitle;
  if (!has('沟通时间')) {
    const dt = msToLocalDateTime(ctx?.noteCreatedAt);
    if (dt) seeded['沟通时间'] = dt;
  }
  return enrichFromNotes(seeded, COMM_SPEC, {
    沟通人: ctx?.noteOwner || ctx?.userName || '',
    // 🔴 责任人要单独给（2026-09-21 峰哥报障：转过来的记录责任人是空的）——
    //    沟通人 ≠ 责任人，只填前者不会顺手把后者带上。
    责任人: defaultFollowupOwner(ctx ?? {}),
  });
}
