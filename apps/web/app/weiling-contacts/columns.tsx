import type { CrudColumn } from '../../components/CrudPage';

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
 * 卫瓴联系人 status 的显示文案。
 *
 * ⚠️ 卫瓴字段描述接口（95 个字段）里**没有 status**，拿不到官方枚举。
 * 这里按数据分布推测：1 = 正常（3600 条，98%）、4 = 其它（63 条，都是 6–8 月创建、
 * 多半从未跟进的老线索）。因此显示时**保留原始数字**，便于日后与卫瓴官方口径对账。
 * 另：「流失状态」是独立字段 `lost_state`（官方枚举 0=未流失 / 1,2,3=已流失），
 * 与 status 无关，且目前全库为空。
 */
export const STATUS_TEXT: Record<string, string> = { '1': '正常', '4': '其它' };

/**
 * 卫瓴联系人列定义。
 *
 * ⚠️ 全部只读：不设 form，页面也不传 create/update/archive，
 * 后端模块资源只登记了 READ —— 数据与接口层都没有写入入口。
 */
export const COLUMNS: CrudColumn[] = [
  // openRecord + 页面 detailHref ⇒ 点击姓名进入只读详情页
  { key: '联系人姓名', label: '联系人', width: '180px', filter: true, filterType: 'text', openRecord: true },
  { key: '手机号', label: '手机号', width: '140px' },
  { key: '归属人', label: '归属人', width: '160px', filter: true },
  { key: '客户阶段', label: '客户阶段', width: '110px', filter: true },
  { key: '来源渠道', label: '来源渠道', width: '150px', filter: true },
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
    width: '100px',
    filter: true,
    // 下拉用原始值（1/4）提交，显示成中文 —— 反过来的话筛选会把「正常」当值传，匹配不上
    filterOptions: ['1', '4'],
    render: (v) => {
      const s = String(v ?? '');
      if (!s) return <span style={{ color: 'var(--fg-tertiary)' }}>—</span>;
      const text = STATUS_TEXT[s];
      return (
        <span style={{ fontSize: 'var(--font-xs)', color: text === '其它' ? 'var(--fg-tertiary)' : 'var(--fg-secondary)' }}>
          {text ? `${text}（${s}）` : s}
        </span>
      );
    },
  },
  {
    key: '关联学生',
    label: '疑似关联学生',
    width: '170px',
    filter: true,
    filterType: 'text',
    render: (v, row) => {
      const name = String(v ?? '');
      if (!name) return <span style={{ color: 'var(--fg-tertiary)' }}>—</span>;
      const score = Number(row['匹配置信度'] ?? 0);
      const color = score >= 90 ? '#2c6b45' : score >= 70 ? '#7a5c10' : '#6b6b66';
      const bg = score >= 90 ? '#eaf5ee' : score >= 70 ? '#fdf6e8' : '#f0efeb';
      return (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span>{name}</span>
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
