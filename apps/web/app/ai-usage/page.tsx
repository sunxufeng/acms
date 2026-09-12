'use client';

import { useCallback, useEffect, useState } from 'react';
import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';

/**
 * AI 路由 · 用量统计。
 *
 * 上半部分是聚合（总览 + 按模型 + 按人 + 按天趋势），下半部分是逐条明细。
 * 明细走通用 CRUD（只读 + 时间区间筛选），聚合走 /ai-usage/stats。
 * ⚠️ 计费口径：单价按**上游真实模型**查表，再乘分组的「价格倍率」。
 */

type Stats = {
  totals: { calls: number; promptTokens: number; completionTokens: number; totalTokens: number; costUsd: number };
  byModel: { name: string; calls: number; tokens: number; costUsd: number }[];
  byUser: { name: string; calls: number; tokens: number; costUsd: number }[];
  byDay: { day: string; calls: number; tokens: number; costUsd: number }[];
  truncated: boolean;
};

function daysAgo(n: number): string {
  const d = new Date(Date.now() - n * 86_400_000);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function today(): string {
  return daysAgo(0);
}
function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

const DETAIL_COLUMNS: CrudColumn[] = [
  { key: '调用时间', label: '时间', width: '150px', listOrder: 1 },
  { key: '密钥名称', label: '密钥', width: '130px', listOrder: 2 },
  { key: '所属用户', label: '使用者', width: '110px', render: (v) => <span style={{ fontSize: 'var(--font-xs)' }}>{String(v ?? '—').slice(0, 10) || '—'}</span> },
  { key: '逻辑模型', label: '逻辑模型', width: '150px', listOrder: 3 },
  { key: '上游模型', label: '上游模型', width: '170px' },
  { key: '上游账号', label: '上游', width: '130px' },
  { key: '总Token', label: 'Tokens', width: '90px', render: (v, row) => <span style={{ fontSize: 'var(--font-xs)' }}>{Number(v ?? 0)}<span style={{ color: 'var(--fg-tertiary)' }}>（{Number(row['输入Token'] ?? 0)}+{Number(row['输出Token'] ?? 0)}）</span></span> },
  {
    key: '成本USD',
    label: '成本',
    width: '90px',
    render: (v) => <span style={{ fontSize: 'var(--font-xs)' }}>${Number(v ?? 0).toFixed(6)}</span>,
  },
  {
    key: '状态',
    label: '状态',
    width: '80px',
    filter: true,
    filterOptions: ['成功', '失败'],
    render: (v) => {
      const s = String(v ?? '');
      return <span style={{ fontSize: 'var(--font-xs)', color: s === '成功' ? '#2c6b45' : '#b3261e' }}>{s || '—'}</span>;
    },
  },
  { key: '耗时ms', label: '耗时', width: '80px', render: (v) => <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>{Number(v ?? 0)} ms</span> },
  { key: '客户端IP', label: '客户端 IP', width: '120px', render: (v) => <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>{String(v ?? '—')}</span> },
  { key: '错误信息', label: '错误', width: '220px', render: (v) => <span style={{ fontSize: 'var(--font-xs)', color: '#b3261e' }}>{String(v ?? '') || '—'}</span> },
];

export default function AiUsagePage() {
  const [from, setFrom] = useState(daysAgo(29));
  const [to, setTo] = useState(today());
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const r = await api.aiUsageStats({ from, to });
      setStats(r);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => {
    void load();
  }, [load]);

  const card = (label: string, value: string) => (
    <div
      key={label}
      style={{ padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 10, background: 'var(--bg-elevated,#fff)' }}
    >
      <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 600 }}>{value}</div>
    </div>
  );

  const maxDayCost = Math.max(0.000001, ...(stats?.byDay ?? []).map((d) => d.costUsd));

  return (
    <div>
      <div className="page-header">
        <div className="page-header-row">
          <div>
            <div className="page-eyebrow">AI ROUTE / USAGE</div>
            <h1 className="page-title">AI 路由 · 用量统计</h1>
            <p className="page-subtitle">按天/模型/使用者的调用与成本；单价按上游真实模型计算，再乘分组倍率</p>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: '1rem' }}>
        <input className="form-input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 150 }} />
        <span style={{ color: 'var(--fg-tertiary)' }}>至</span>
        <input className="form-input" type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 150 }} />
        <button className="btn btn-ghost btn-sm" onClick={() => { setFrom(daysAgo(6)); setTo(today()); }}>近 7 天</button>
        <button className="btn btn-ghost btn-sm" onClick={() => { setFrom(daysAgo(29)); setTo(today()); }}>近 30 天</button>
        <button className="btn btn-ghost btn-sm" onClick={() => { setFrom(daysAgo(89)); setTo(today()); }}>近 90 天</button>
        <button className="btn btn-outline btn-sm" disabled={loading} onClick={() => void load()}>
          {loading ? '刷新中…' : '刷新'}
        </button>
        {err ? <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-error)' }}>{err}</span> : null}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(130px,1fr))', gap: 10, marginBottom: '1.25rem' }}>
        {card('总调用', String(stats?.totals.calls ?? 0))}
        {card('总 Tokens', fmt(stats?.totals.totalTokens ?? 0))}
        {card('输入 Tokens', fmt(stats?.totals.promptTokens ?? 0))}
        {card('输出 Tokens', fmt(stats?.totals.completionTokens ?? 0))}
        {card('总成本 USD', `$${(stats?.totals.costUsd ?? 0).toFixed(4)}`)}
      </div>

      {stats?.truncated ? (
        <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)', marginBottom: 10 }}>
          明细量很大，统计只覆盖最近 2 万条 —— 需要精确总量请缩短时间区间。
        </div>
      ) : null}

      {/* 按天趋势 */}
      {stats && stats.byDay.length > 0 ? (
        <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '14px 16px', background: 'var(--bg-elevated,#fff)', marginBottom: '1.25rem' }}>
          <div style={{ fontSize: 'var(--font-sm)', fontWeight: 600, marginBottom: 10 }}>按天成本（USD）</div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 120 }}>
            {stats.byDay.map((d) => (
              <div key={d.day} style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', alignItems: 'center', gap: 3 }} title={`${d.day}｜${d.calls} 次｜$ ${d.costUsd.toFixed(4)}`}>
                <div style={{ width: '100%', height: `${Math.max(2, (d.costUsd / maxDayCost) * 96)}px`, background: 'var(--accent)', borderRadius: '3px 3px 0 0' }} />
                <div style={{ fontSize: 9, color: 'var(--fg-tertiary)' }}>{d.day.slice(5)}</div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 12, marginBottom: '1.5rem' }}>
        <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '14px 16px', background: 'var(--bg-elevated,#fff)' }}>
          <div style={{ fontSize: 'var(--font-sm)', fontWeight: 600, marginBottom: 8 }}>按模型</div>
          {(stats?.byModel ?? []).length === 0 ? (
            <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>暂无数据</div>
          ) : (
            <table style={{ width: '100%', fontSize: 'var(--font-sm)', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ color: 'var(--fg-tertiary)', textAlign: 'left' }}>
                  <th style={{ padding: '4px 0', fontWeight: 400, fontSize: 'var(--font-xs)' }}>模型</th>
                  <th style={{ padding: '4px 0', fontWeight: 400, fontSize: 'var(--font-xs)', textAlign: 'right' }}>调用</th>
                  <th style={{ padding: '4px 0', fontWeight: 400, fontSize: 'var(--font-xs)', textAlign: 'right' }}>Tokens</th>
                  <th style={{ padding: '4px 0', fontWeight: 400, fontSize: 'var(--font-xs)', textAlign: 'right' }}>成本</th>
                </tr>
              </thead>
              <tbody>
                {stats!.byModel.map((r) => (
                  <tr key={r.name} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '5px 0', fontSize: 'var(--font-xs)' }}>{r.name}</td>
                    <td style={{ padding: '5px 0', fontSize: 'var(--font-xs)', textAlign: 'right' }}>{r.calls}</td>
                    <td style={{ padding: '5px 0', fontSize: 'var(--font-xs)', textAlign: 'right' }}>{fmt(r.tokens)}</td>
                    <td style={{ padding: '5px 0', fontSize: 'var(--font-xs)', textAlign: 'right' }}>${r.costUsd.toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '14px 16px', background: 'var(--bg-elevated,#fff)' }}>
          <div style={{ fontSize: 'var(--font-sm)', fontWeight: 600, marginBottom: 8 }}>按使用者</div>
          {(stats?.byUser ?? []).length === 0 ? (
            <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>暂无数据</div>
          ) : (
            <table style={{ width: '100%', fontSize: 'var(--font-sm)', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ color: 'var(--fg-tertiary)', textAlign: 'left' }}>
                  <th style={{ padding: '4px 0', fontWeight: 400, fontSize: 'var(--font-xs)' }}>使用者</th>
                  <th style={{ padding: '4px 0', fontWeight: 400, fontSize: 'var(--font-xs)', textAlign: 'right' }}>调用</th>
                  <th style={{ padding: '4px 0', fontWeight: 400, fontSize: 'var(--font-xs)', textAlign: 'right' }}>Tokens</th>
                  <th style={{ padding: '4px 0', fontWeight: 400, fontSize: 'var(--font-xs)', textAlign: 'right' }}>成本</th>
                </tr>
              </thead>
              <tbody>
                {stats!.byUser.map((r) => (
                  <tr key={r.name} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '5px 0', fontSize: 'var(--font-xs)' }}>{r.name}</td>
                    <td style={{ padding: '5px 0', fontSize: 'var(--font-xs)', textAlign: 'right' }}>{r.calls}</td>
                    <td style={{ padding: '5px 0', fontSize: 'var(--font-xs)', textAlign: 'right' }}>{fmt(r.tokens)}</td>
                    <td style={{ padding: '5px 0', fontSize: 'var(--font-xs)', textAlign: 'right' }}>${r.costUsd.toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* 明细（只读 + 时间区间筛选） */}
      <CrudPage
        title="调用明细"
        subtitle="每次调用一条；失败也会记录（便于排查某个密钥为什么一直失败）"
        columns={DETAIL_COLUMNS}
        moduleKey="aiUsage"
        readonly
        hideCreate
        search={{ placeholder: '搜索模型 / 密钥名称…' }}
        rangeFilters={[
          { key: '调用时间', label: '调用时间', fromParam: '调用时间_from', toParam: '调用时间_to' },
        ]}
        api={{ list: (p) => api.listAiUsage(p) }}
      />
    </div>
  );
}
