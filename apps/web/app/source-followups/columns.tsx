import Link from 'next/link';
import type { CrudColumn } from '../../components/CrudPage';
import { enrichFromNotes, type NoteAutoFillSpec } from '../../lib/noteAutoFill';
import { defaultFollowupOwner } from '@acms/contracts';
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
    /**
     * 选了联系人 → 自动带出该联系人报名表里的「学生姓名」（卫瓴自定义字段 `xsxm`）。
     *
     * ⚠️ 联动 patch 必须挂在**触发变化的这一列**上：`applyFieldChange` 取的永远是
     * *当前这一列* 自己的 `onChangePatch`。上一版（a75fb9a）把它写在了「学生姓名」列上，
     * 于是「选完联系人自动带出」**一次都没生效过** —— 只有用户手改「学生姓名」时才跑，
     * 还拿输入框里的姓名当联系人 id 去查，永远查不到。
     * 函数本身没写错、只是挂错了列 ⇒ 类型检查、接口、构建全都不会报错（典型静默失效）。
     */
    onChangePatch: (v, _form, ctx) => {
      const name = ctx.contactStudentName(String(v ?? ''));
      return name ? { 学生姓名: name } : {};
    },
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
    // 「学生姓名」不是一个本表的业务字段，而是**联系人报名表里填的子女姓名**
    // （卫瓴自定义字段 `xsxm`，整包存在联系人的「自定义字段」列里）。
    //
    // 三条设计决定：
    //  ① 选了联系人**自动带出**：联动 patch 挂在上面「联系人」列上（那里有说明，
    //     为什么不能挂在本列 —— 挂错列会静默失效）。
    //  ② 带出后**存进本表**（key = `学生姓名`）：列表、导出、筛选都能直接用，
    //     不必每次回查联系人；也避免「联系人后来改了报名表，历史跟进记录跟着变」。
    //  ③ 联系人**没填** xsxm 时**不覆盖**已有值（返回空 patch）——
    //     否则会把已有内容清掉；代价是换联系人后旧值会留着，需人工确认。
    //
    // ⚠️ 本列**只读**（2026-09-22 峰哥要求）：它只是「联系人报名表的投影」，
    //    手改会跟来源脱节（改完看着对、下次换联系人又被覆盖，用户以为数据丢了）。
    //    只读只影响渲染 —— 提交时照常带上带出的值（payload 取自表单状态），值仍会落库。
    //    ⚠️ 别顺手把「学生姓名」加进服务端 meta 的 `readonly`：那是**写入侧硬过滤**
    //    （`buildWriteFields` 直接丢字段），加进去反而一个字都存不下。
    key: '学生姓名',
    label: '学生姓名',
    width: '110px',
    form: true,
    readonly: true,
    listOrder: 2,
    hint: '自动取自联系人报名表里填的学生姓名，不可编辑',
  },
  {
    key: '关联学生',
    // 2026-09-21 峰哥要求：label 由「学生」改为「关联学生」——
    // 它存的是**学生档案里的正式姓名**（`studentMatch.by: 'name'` 的判据），
    // 与上面那个「从报名表带出来的学生姓名」是两件事，措辞必须区分开。
    label: '关联学生',
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
  { key: '跟进时间', label: '跟进时间', width: '150px', form: true, type: 'datetime', listOrder: 4 },
  { key: '跟进状态', label: '跟进状态', width: '110px', filter: true, form: true, type: 'select', dictKey: '跟进状态', listOrder: 5 },
  { key: '活动类型', label: '活动类型', width: '110px', filter: true, form: true, type: 'select', dictKey: '活动类型', listOrder: 6 },
  // ⚠️ 2026-09-19 峰哥要求：负责人要能在**新建/修改表单里看到并修改** ——
  //    原先只配了 listOrder（列表可见）而没开 form，表单里根本找不到这个字段。
  // ⚠️ 2026-09-21：改成 **person 下拉**（候选 = 系统用户姓名）。
  //    为什么不让手填：这个字段是「学生全景」等处的归属判据（`owner: '跟进负责人'`），
  //    手填错一个字就会**静默**归错人。下拉同时保证「新建默认登录用户」这个默认值
  //    一定是个合法姓名。
  { key: '跟进负责人', label: '负责人', width: '110px', form: true, type: 'person', listOrder: 7 },
  { key: '付款状态', label: '付款状态', width: '110px', filter: true, form: true, type: 'select', dictKey: '付款状态', list: false },
  // ── 参考家校沟通编辑页面新增的字段 ──
  // ⚠️ 非必填（2026-09-14 用户反馈）：招生阶段常常还没确认学生，「家长」跟着「关联学生」
  //    一起留空是常态；标成必填既误导（表单会显示红色 *），在笔记转换的新建流程里
  //    还会真的拦提交（那条流程走 strictRequired 校验）。可选字段一律不标 required。
  { key: '家长', label: '家长', width: '110px', list: false, form: true, type: 'parent', dependsOn: '关联学生', required: false },
  { key: '家长反馈态度', label: '家长反馈态度', width: '130px', list: false, filter: true, form: true, type: 'select', dictKey: '家长反馈态度' },
  // openRecord：首列已让给联系人（跳联系人详情），这里点击主题进入本条跟进的只读详情页
  { key: '沟通主题', label: '沟通主题', width: '120px', form: true, listOrder: 3, openRecord: true },
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
 *
 * 「负责人」口径（2026-09-21 峰哥确认）：**代转别人的笔记时记笔记归属人，其余记当前登录用户**
 * —— 判据收敛在 `@acms/contracts` 的 `defaultFollowupOwner()`，与校友跟进/实践活动共用一份，
 * 各写一份必然漂移（同一动作在两个模块归到不同人）。
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

/**
 * 笔记转换预填：主题 / 时间 / 负责人 的默认值。
 *
 *  - **沟通主题 ← 笔记标题**、**跟进时间 ← 笔记创建时间**（2026-09-19 峰哥要求）
 *  - **负责人 ← 代转记笔记归属人 / 否则当前登录用户**（`defaultFollowupOwner`）
 *
 * 主题 / 时间**先塞进 values 再走 `enrichFromNotes`**，而不是当 `defaults` 传 ——
 * `defaults` 是最低优先级（只在正文什么都没抽到时才填），而峰哥要的是「笔记标题就是主题」。
 * 已存在的值一律不覆盖。
 */
export function parseSourceFollowupFromSummary(
  values: Record<string, unknown>,
  ctx?: { userName?: string; noteOwner?: string; noteTitle?: string; noteCreatedAt?: number },
): Record<string, unknown> {
  const seeded: Record<string, unknown> = { ...values };
  const has = (k: string) => String(seeded[k] ?? '').trim() !== '';
  if (!has('沟通主题') && ctx?.noteTitle) seeded['沟通主题'] = ctx.noteTitle;
  if (!has('跟进时间')) {
    const dt = msToLocalDateTime(ctx?.noteCreatedAt);
    if (dt) seeded['跟进时间'] = dt;
  }
  return enrichFromNotes(seeded, SPEC, { 跟进负责人: defaultFollowupOwner(ctx ?? {}) });
}

/**
 * 毫秒时间戳 → 本地时区的 `YYYY-MM-DDTHH:mm`。
 * ⚠️ 不能用 `toISOString()`（那是 UTC，东八区差 8 小时）；`<input type="datetime-local">` 只认带 T 的格式。
 */
export function msToLocalDateTime(ms?: number): string {
  const n = Number(ms ?? 0);
  if (!n || Number.isNaN(n)) return '';
  const d = new Date(n);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
