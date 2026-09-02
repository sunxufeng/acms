'use client';

import { useTranslations } from 'next-intl';

export interface WheelDim { dim: string; current: number; expected: number }

/**
 * 人生平衡轮雷达图。
 *  - 传入 onChange → 可编辑（数值输入）。
 *  - 不传 onChange → 只读展示。
 */
export default function BalanceWheel({ dims, onChange }: { dims: WheelDim[]; onChange?: (d: WheelDim[]) => void }) {
  const ti = useTranslations('idp');
  const N = dims.length || 1;
  const cx = 200, cy = 200, R = 150;
  const angle = (i: number) => (-90 + (360 / N) * i) * (Math.PI / 180);
  const point = (i: number, r: number) => [cx + r * Math.cos(angle(i)), cy + r * Math.sin(angle(i))];
  const poly = (key: 'current' | 'expected') =>
    dims.map((d, i) => point(i, (R * Math.max(0, Math.min(10, d[key]))) / 10).join(',')).join(' ');

  const editable = Boolean(onChange);

  return (
    <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start' }}>
      <svg viewBox="0 0 400 400" width={320} height={320} style={{ flexShrink: 0 }}>
        {[2, 4, 6, 8, 10].map((g) => (
          <polygon key={g} points={dims.map((_, i) => point(i, (R * g) / 10).join(',')).join(' ')}
            fill="none" stroke="var(--border)" strokeWidth={1} />
        ))}
        {dims.map((_, i) => {
          const [x, y] = point(i, R);
          return <line key={i} x1={cx} y1={cy} x2={x} y2={y} stroke="var(--border)" strokeWidth={1} />;
        })}
        {dims.some((d) => d.expected > 0) && (
          <polygon points={poly('expected')} fill="var(--accent-muted)" stroke="var(--accent)" strokeWidth={2} />
        )}
        <polygon points={poly('current')} fill="var(--chart-current-soft)" stroke="var(--chart-current)" strokeWidth={2} />
        {dims.map((d, i) => {
          const [x, y] = point(i, R + 22);
          return <text key={i} x={x} y={y} fontSize={12} fill="var(--fg)" textAnchor="middle" dominantBaseline="middle">{d.dim}</text>;
        })}
      </svg>
      <div style={{ flex: 1, minWidth: 240 }}>
        <div style={{ display: 'flex', gap: 16, fontSize: 'var(--font-sm)', marginBottom: 8 }}>
          <span style={{ color: 'var(--chart-current)' }}>● 当前值</span>
          <span style={{ color: 'var(--accent)' }}>● 期望値（IDP 后）</span>
        </div>
        {dims.map((d, i) => (
          <div key={d.dim} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <span style={{ width: 84, fontSize: 'var(--font-sm)' }}>{d.dim}</span>
            <label style={{ fontSize: 'var(--font-sm)', color: 'var(--chart-current)' }}>{ti('wheelCurrent')}</label>
            {editable ? (
              <input type="number" min={0} max={10} value={d.current} style={{ width: 64 }}
                onChange={(e) => { const v = Number(e.target.value); const n = [...dims]; n[i] = { ...n[i], current: v }; onChange!(n); }} />
            ) : (
              <span style={{ width: 64, fontSize: 'var(--font-sm)', fontWeight: 500 }}>{d.current || 0}</span>
            )}
            <label style={{ fontSize: 'var(--font-sm)', color: 'var(--accent)' }}>{ti('wheelExpected')}</label>
            {editable ? (
              <input type="number" min={0} max={10} value={d.expected} style={{ width: 64 }}
                onChange={(e) => { const v = Number(e.target.value); const n = [...dims]; n[i] = { ...n[i], expected: v }; onChange!(n); }} />
            ) : (
              <span style={{ width: 64, fontSize: 'var(--font-sm)', fontWeight: 500 }}>{d.expected || 0}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
