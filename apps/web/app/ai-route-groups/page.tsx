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
