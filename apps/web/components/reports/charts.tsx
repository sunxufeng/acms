'use client';

import React from 'react';

/**
 * 报表图表基元（零依赖自绘）。
 *
 * 背景：仓库无任何图表库（recharts/echarts/chart.js 全无），引入第三方库需要
 * 在服务器上单独装依赖、且部署脚本只传 dist 不装包，风险高。当前报表数据量
 * 极小（学生 82 条），纯 div/SVG 足够，且样式与全站 CSS 变量天然一致。
 */

/** 指标卡 */
export function MetricCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div style={{ background: 'var(--bg-subtle)', borderRadius: 8, padding: '14px 16px' }}>
      <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 500, lineHeight: 1.25 }}>
        {value}
        {sub ? <span style={{ fontSize: 14, color: 'var(--fg-tertiary)', marginLeft: 4 }}>{sub}</span> : null}
      </div>
    </div>
  );
}

/** 指标卡网格 */
export function MetricRow({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(130px,1fr))', gap: 12, marginBottom: '1.5rem' }}>
      {children}
    </div>
  );
}

/**
 * 横向条形行。
 * @param compare 传入时显示双条：浅色为 compare（对比值），深色为 value（当前值）
 */
export function BarRow({
  label,
  value,
  max,
  compare,
  suffix,
}: {
  label: string;
  value: number;
  max: number;
  compare?: number;
  suffix?: string;
}) {
  const pct = (n: number) => (max > 0 ? Math.max(1.5, Math.round((n / max) * 100)) : 0);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '110px minmax(0,1fr) 96px', gap: 10, alignItems: 'center', marginBottom: 10 }}>
      <div style={{ fontSize: 'var(--font-sm)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={label}>
        {label}
      </div>
      <div>
        {compare !== undefined ? (
          <div style={{ height: 9, background: 'var(--accent-soft)', borderRadius: 3, width: `${pct(compare)}%`, marginBottom: 3 }} />
        ) : null}
        <div style={{ height: 9, background: 'var(--accent)', borderRadius: 3, width: `${pct(value)}%` }} />
      </div>
      <div style={{ textAlign: 'right', fontSize: 'var(--font-sm)', color: 'var(--fg-tertiary)' }}>
        {compare !== undefined ? `${compare} → ${value}` : value}
        {suffix ? ` ${suffix}` : ''}
      </div>
    </div>
  );
}

/** 纵向柱状图 */
export function ColumnChart({ data, height = 140 }: { data: { label: string; value: number }[]; height?: number }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, height, borderBottom: '1px solid var(--border)' }}>
        {data.map((d) => (
          <div key={d.label} style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', alignItems: 'center', gap: 4 }}>
            <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>{d.value}</div>
            <div
              style={{
                width: '100%',
                height: `${Math.max(2, Math.round((d.value / max) * 100))}%`,
                background: 'var(--accent)',
                borderRadius: '3px 3px 0 0',
              }}
              title={`${d.label} ${d.value}`}
            />
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 12, marginTop: 5 }}>
        {data.map((d) => (
          <div key={d.label} style={{ flex: 1, textAlign: 'center', fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={d.label}>
            {d.label}
          </div>
        ))}
      </div>
    </div>
  );
}

/** 分组标题卡片 */
export function Panel({ title, extra, children }: { title: string; extra?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '16px 18px', background: 'var(--bg-elevated)', marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
        <div style={{ fontSize: 'var(--font-sm)', fontWeight: 500 }}>{title}</div>
        {extra}
      </div>
      {children}
    </div>
  );
}

/** 空态：表结构存在但无业务数据 */
export function EmptyData({ title, hint, href }: { title: string; hint: string; href?: string }) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '32px 18px', background: 'var(--bg-elevated)', textAlign: 'center' }}>
      <div style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-tertiary)', marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>{hint}</div>
      {href ? (
        <a href={href} style={{ display: 'inline-block', marginTop: 12, fontSize: 'var(--font-sm)', color: 'var(--accent)' }}>
          {href}
        </a>
      ) : null}
    </div>
  );
}

/** 简单表格 */
export function SimpleTable({
  head,
  rows,
}: {
  head: string[];
  rows: (string | number)[][];
}) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--font-sm)' }}>
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} style={{ textAlign: 'left', padding: '6px 10px', borderBottom: '1px solid var(--border)', color: 'var(--fg-tertiary)', fontWeight: 400, fontSize: 'var(--font-xs)', whiteSpace: 'nowrap' }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j} style={{ padding: '6px 10px', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
