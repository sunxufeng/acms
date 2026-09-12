'use client';

import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';

/**
 * AI 路由 · 分组管理。
 *
 * 分组是「一组上游账号 + 一套策略」的集合：密钥绑分组，分组决定能用哪些模型、
 * 什么价格倍率、每分钟/并发上限、每月花多少钱。
 */
const COLUMNS: CrudColumn[] = [
  { key: '名称', label: '分组名称', width: '160px', form: true, required: true, filter: true, filterType: 'text', listOrder: 1 },
  {
    key: '状态',
    label: '状态',
    width: '80px',
    form: true,
    type: 'select',
    dictKey: 'AI路由状态',
    filter: true,
    filterOptions: ['启用', '停用'],
    listOrder: 2,
    render: (v) => {
      const s = String(v ?? '');
      return (
        <span
          style={{
            fontSize: 'var(--font-xs)',
            padding: '1px 6px',
            borderRadius: 8,
            background: s === '启用' ? '#eaf5ee' : 'var(--bg-hover)',
            color: s === '启用' ? '#2c6b45' : 'var(--fg-tertiary)',
          }}
        >
          {s || '—'}
        </span>
      );
    },
  },
  { key: '价格倍率', label: '价格倍率', width: '90px', form: true, type: 'number', listOrder: 3 },
  {
    key: '可用模型',
    label: '可用模型',
    width: '200px',
    form: true,
    type: 'tags',
    listOrder: 4,
    render: (v) => {
      const list = Array.isArray(v) ? (v as unknown[]).map(String) : String(v ?? '').split(/[,，、\s]+/).filter(Boolean);
      if (!list.length)
        return (
          <span style={{ color: 'var(--fg-tertiary)', fontSize: 'var(--font-xs)' }}>不限（跟随模型路由）</span>
        );
      return (
        <span style={{ fontSize: 'var(--font-xs)' }}>
          {list.slice(0, 3).join('、')}
          {list.length > 3 ? ` +${list.length - 3}` : ''}
        </span>
      );
    },
  },
  { key: 'RPM上限', label: 'RPM 上限', width: '90px', form: true, type: 'number' },
  { key: '并发上限', label: '并发上限', width: '90px', form: true, type: 'number' },
  { key: '月配额USD', label: '月配额 USD', width: '110px', form: true, type: 'number' },
  {
    key: '日限额USD',
    label: '日限额 USD',
    width: '100px',
    form: true,
    type: 'number',
    hint: '0 或留空 = 不限；按自然日自动归零',
  },
  {
    key: '周限额USD',
    label: '周限额 USD',
    width: '100px',
    form: true,
    type: 'number',
    hint: '0 或留空 = 不限；按 ISO 周自动归零',
  },
  {
    key: '今日已用USD',
    label: '今日 / 本周',
    width: '150px',
    render: (v, row) => (
      <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>
        ${Number(v ?? 0).toFixed(4)} / ${Number(row['本周已用USD'] ?? 0).toFixed(4)}
      </span>
    ),
  },
  {
    key: '本月已用USD',
    label: '本月已用',
    width: '110px',
    render: (v, row) => {
      const used = Number(v ?? 0);
      const quota = Number(row['月配额USD'] ?? 0);
      const text = `$${used.toFixed(4)}`;
      if (!(quota > 0)) return <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>{text}</span>;
      const pct = Math.min(100, (used / quota) * 100);
      return (
        <span
          style={{ fontSize: 'var(--font-xs)', color: pct >= 90 ? '#b3261e' : pct >= 70 ? '#7a5c10' : 'var(--fg-secondary)' }}
          title={`本月 ${text} / 配额 $${quota}`}
        >
          {text}（{pct.toFixed(0)}%）
        </span>
      );
    },
  },
  { key: '描述', label: '描述', list: false, form: true, type: 'textarea' },

  // ── 计费策略 ──
  { key: '启用高峰倍率', label: '启用高峰倍率', list: false, form: true, type: 'select', dictKey: '是否', hint: '开启后，在下面的时段内再乘一次高峰倍率' },
  { key: '高峰开始', label: '高峰开始', list: false, form: true, type: 'text', hint: 'HH:MM，如 14:00（含）；不支持跨天' },
  { key: '高峰结束', label: '高峰结束', list: false, form: true, type: 'text', hint: 'HH:MM，如 22:00（不含）；必须大于开始时间' },
  { key: '高峰倍率', label: '高峰倍率', list: false, form: true, type: 'number', hint: '高峰时段叠加倍率，如 1.5' },

  // ── 利润控制（对齐 sub2api）：只让成本倍率达标的账号进候选池 ──
  { key: '启用利润控制', label: '启用利润控制', list: false, form: true, type: 'select', dictKey: '是否', hint: '按毛利率筛掉不赚钱的上游账号' },
  { key: '最低毛利率', label: '最低毛利率', list: false, form: true, type: 'number', hint: '小数，0.3 = 30%。准入条件：账号成本倍率 ≤ 分组倍率 ×(1 − 毛利率 − 缓冲)' },
  { key: '安全缓冲', label: '安全缓冲', list: false, form: true, type: 'number', hint: '与毛利率相加后一起扣除，默认 0' },

  // ── 账号过滤与其它 ──
  { key: '仅允许订阅账号', label: '仅允许订阅账号', list: false, form: true, type: 'select', dictKey: '是否', hint: '开启后 API Key 类型的上游账号不会被本分组选中' },
  { key: '专属分组', label: '专属分组', list: false, form: true, type: 'select', dictKey: '是否', hint: '标记为专属（内部用途区分）' },
  { key: '订阅类型', label: '订阅类型', list: false, form: true, type: 'select', dictKey: '订阅类型' },
  { key: '默认有效期天数', label: '默认有效期天数', list: false, form: true, type: 'number', hint: '发密钥时默认给多少天有效期' },
  { key: '显示排序', label: '显示排序', width: '90px', form: true, type: 'number', hint: '数值越小越靠前' },
];

export default function AiRouteGroupsPage() {
  return (
    <CrudPage
      title="AI 路由 · 分组管理"
      subtitle="一组上游账号 + 一套策略（模型白名单 / 价格倍率 / 限流 / 月配额），密钥绑定分组生效"
      search={{ placeholder: '搜索分组名称…' }}
      columns={COLUMNS}
      moduleKey="aiRouteGroups"
      statusField="状态"
      inlineEdit
      standaloneForm
      api={{
        list: (p) => api.listAiRouteGroups(p),
        create: (d) => api.createAiRouteGroup(d),
        update: (id, d) => api.updateAiRouteGroup(id, d),
        archive: (id) => api.deleteAiRouteGroup(id),
      }}
    />
  );
}
