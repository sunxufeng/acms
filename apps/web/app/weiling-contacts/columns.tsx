import Link from 'next/link';
import type { CrudColumn } from '../../components/CrudPage';
import { STUDENT_ENGLISH_KEY, STUDENT_REF_KEY, studentHref, studentLabel } from '../../components/CrudPage';

/**
 * 时间字段 → 毫秒。
 * ⚠️ 同一个字段读出来形态不一致：有的给毫秒数字，有的给 ISO 字符串
 * （实测「创建时间」返回 2026-09-11T23:49:06.809Z，「最近跟进时间」返回 1787547970000），
 * 只按数字解析的话前者会显示成「—」。
 */
function toMs(v: unknown): number {
  if (typeof v === 'number') return v;
  const s = String(v ?? '').trim();
  if (!s) return 0;
  if (/^\d+$/.test(s)) return Number(s);
  const t = new Date(s).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/** → 本地日期时间文本 */
export function fmtTs(v: unknown): string {
  const n = toMs(v);
  if (!n) return '—';
  const d = new Date(n);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** → 日期（YYYY-MM-DD） */
export function fmtDate(v: unknown): string {
  const n = toMs(v);
  if (!n) return '—';
  const d = new Date(n);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 卫瓴联系人 status（联系人状态）的官方枚举。
 *
 * 口径来源：**卫瓴开放平台接口文档** https://openapi.weling.cn/openapi/contact/create
 * （`status  enum<integer>  联系人状态`），2026-09-14 峰哥提供的截图确认：
 *
 *   | 值 | 含义 |
 *   |---|---|
 *   | 0 | 待认领（公海） —— 文档原文写的是「0-待认领（公海）」，前缀那个 0 是文档笔误 |
 *   | 1 | 已认领 |
 *   | 4 | 待分配 |
 *
 * 生产实测分布（3664 条）：1 = 3601、4 = 63，**没有 0**（公海线索不会同步进来）。
 *
 * 历史：这个字段之前查不到枚举（卫瓴「字段描述接口」的 95 个字段里没有 status），
 * 只好按分布猜成「正常/其它」并把列藏起来。现在有官方口径 ⇒ **列恢复显示 + 可筛选**，
 * 展示层一律出中文，原始码值留在数据里（导出仍能对账，鼠标悬停能看到原值）。
 * 另：「流失状态」是独立字段 `lost_state`（官方枚举 0=未流失 / 1,2,3=已流失），与 status 无关。
 */
export const STATUS_TEXT: Record<string, string> = {
  '0': '待认领（公海）',
  '1': '已认领',
  '4': '待分配',
};

/** 状态码 → 中文（认不出的码**原样回显**，不要瞎猜，也不要显示成空白） */
export function statusLabel(v: unknown): string {
  const s = String(v ?? '').trim();
  if (!s) return '';
  return STATUS_TEXT[s] ?? s;
}

/**
 * 卫瓴联系人列定义。
 *
 * ⚠️ 全部只读：不设 form，页面也不传 create/update/archive，
 * 后端模块资源只登记了 READ —— 数据与接口层都没有写入入口。
 */
export const COLUMNS: CrudColumn[] = [
  // openRecord + 页面 detailHref ⇒ 点击姓名进入只读详情页
  // 筛选区不再放「联系人」（自由文本逐字筛命中率低、把筛选区撑长）；
  // 列本身保留，点姓名进详情页；要按姓名搜用顶部搜索框（q → 后端 searchFields）。
  { key: '联系人姓名', label: '联系人', width: '180px', openRecord: true },
  { key: '手机号', label: '手机号', width: '140px' },
  { key: '归属人', label: '归属人', width: '160px', filter: true },
  // label 用简称「阶段」而 key 仍是数据字段名「客户阶段」——
  // 键值双标识：key 是取值下标，永远不动；label 只影响界面文案。
  { key: '客户阶段', label: '阶段', width: '110px', filter: true },
  { key: '来源渠道', label: '来源', width: '150px', filter: true },
  { key: '互动分', label: '互动分', width: '80px' },
  {
    key: '流失状态',
    label: '流失状态',
    width: '90px',
    filter: true,
    filterOptions: ['已流失', '未流失'],
    render: (v) => {
      const s = String(v ?? '');
      if (!s) return <span style={{ color: 'var(--fg-tertiary)' }}>—</span>;
      const lost = s === '已流失';
      return (
        <span
          title="来自卫瓴客户接口（客户维度的流失标记）；关联不到企业微信客户的联系人查不到，显示 —"
          style={{
            fontSize: 'var(--font-xs)',
            padding: '1px 6px',
            borderRadius: 8,
            background: lost ? '#fdecea' : '#eaf5ee',
            color: lost ? '#b3261e' : '#2c6b45',
          }}
        >
          {s}
        </span>
      );
    },
  },
  {
    key: '跟进次数',
    label: '跟进次数',
    width: '90px',
    render: (v) => {
      const n = Number(v ?? 0);
      return (
        <span
          style={{
            fontSize: 'var(--font-xs)',
            color: n > 0 ? 'var(--fg-secondary)' : 'var(--fg-tertiary)',
          }}
        >
          {n > 0 ? `${n} 次` : '—'}
        </span>
      );
    },
  },
  {
    key: '创建时间',
    label: '创建时间',
    width: '140px',
    render: (v) => <span style={{ fontSize: 'var(--font-xs)' }}>{fmtDate(v)}</span>,
  },
  {
    key: '最近跟进时间',
    label: '最近跟进',
    width: '140px',
    render: (v) => <span style={{ fontSize: 'var(--font-xs)' }}>{fmtDate(v)}</span>,
  },
  {
    key: '状态',
    label: '状态',
    width: '110px',
    // 枚举已确认（见上方 STATUS_TEXT）⇒ 恢复列表显示 + 可筛选。
    // ⚠️ filterOptions 是**发给后端的原始码值**（库里存的就是 0/1/4），
    //    filterOptionLabels 只负责把下拉里的显示换成中文 —— 反过来做（选项写中文）
    //    会一条都筛不出来（等值匹配 vs 数据里是数字）。同款坑见 2026-09-14 的「来源渠道」。
    filter: true,
    filterOptions: ['0', '1', '4'],
    filterOptionLabels: { '0': '待认领（公海）', '1': '已认领', '4': '待分配' },
    render: (v) => {
      const s = String(v ?? '');
      if (!s) return <span style={{ color: 'var(--fg-tertiary)' }}>—</span>;
      const text = statusLabel(s);
      // 认不出的码只回显原值，避免用猜测口径覆盖真实数据
      const known = Boolean(STATUS_TEXT[s]);
      return (
        <span
          title={`卫瓴 status = ${s}`}
          style={{ fontSize: 'var(--font-xs)', color: known ? 'var(--fg-secondary)' : 'var(--fg-tertiary)' }}
        >
          {text}
        </span>
      );
    },
  },
  {
    key: '关联学生',
    label: '关联学生',
    width: '170px',
    filter: true,
    filterType: 'text',
    filterOp: 'contains',
    // 占位文案直接用字段名（默认会拼成「筛选关联学生」）——
    // 筛选区已有放大镜图标、左右也都是筛选控件，「筛选」二字属冗余。
    filterPlaceholder: '关联学生',
    // 占位文案只有 4 个字，用默认 160 会把整行筛选撑散；收到刚好撑满文案的宽度。
    filterWidth: 100,
    render: (v, row) => {
      const name = String(v ?? '');
      if (!name) return <span style={{ color: 'var(--fg-tertiary)' }}>—</span>;
      const score = Number(row['匹配置信度'] ?? 0);
      const color = score >= 90 ? '#2c6b45' : score >= 70 ? '#7a5c10' : '#6b6b66';
      const bg = score >= 90 ? '#eaf5ee' : score >= 70 ? '#fdf6e8' : '#f0efeb';
      // 学生记录 id 两个来源，优先用后端匹配时写入的「关联学生ID」（精确）：
      //  1. 关联学生ID —— matchStudents 按姓名/手机号匹配后写入的 student record id
      //  2. STUDENT_REF_KEY —— CrudPage 按姓名反查注入（页面传 studentNameKeys 才会有），
      //     兜底给「匹配 ID 还为空」的老数据/特殊行
      // 两个都没有（学生已删除 / 档案里没有）就退化成纯文本，不做成死链。
      const refId = String(row['关联学生ID'] ?? '') || String(row[STUDENT_REF_KEY] ?? '');
      const label = studentLabel(name, row[STUDENT_ENGLISH_KEY]);
      return (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {refId ? (
            <Link href={studentHref(refId)} className="name-link" title="查看学生基本信息">
              {label}
            </Link>
          ) : (
            <span>{label}</span>
          )}
          <span
            title={String(row['匹配依据'] ?? '')}
            style={{ fontSize: 10, padding: '1px 5px', borderRadius: 8, background: bg, color, whiteSpace: 'nowrap' }}
          >
            {score}
          </span>
        </span>
      );
    },
  },
  { key: '企业名', label: '企业', width: '180px', list: false },
  { key: '备注', label: '备注', width: '240px', list: false },
  { key: '标签', label: '标签', width: '240px', list: false },
  { key: '来源组件', label: '来源组件', width: '200px', list: false },
  { key: '邮箱', label: '邮箱', width: '180px', list: false },
  { key: '领取时间', label: '领取时间', width: '140px', list: false },
  { key: '首次跟进时间', label: '首次跟进', width: '140px', list: false },
  { key: '落地页', label: '落地页', width: '260px', list: false },
  { key: '其他信息', label: '表单填写', width: '300px', list: false },
];

/** 详情页展示顺序（分组标题 → 字段） */
export const DETAIL_GROUPS: { title: string; keys: string[] }[] = [
  { title: '基本信息', keys: ['联系人姓名', '手机号', '邮箱', '状态', '客户阶段', '归属人', '流失状态'] },
  { title: '关联匹配', keys: ['关联学生', '匹配置信度', '匹配依据'] },
  { title: '来源', keys: ['来源渠道', '来源组件', '落地页', '创建时间', '领取时间'] },
  { title: '跟进', keys: ['首次跟进时间', '最近跟进时间', '互动分', '跟进次数', '标签'] },
  { title: '企业与其它', keys: ['企业名', '备注', '其他信息'] },
  { title: '系统信息', keys: ['同步时间', '匹配时间'] },
];
