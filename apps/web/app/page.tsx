'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '../../lib/api';

interface Me {
  name: string;
  openId: string;
  roles: string[];
}

export default function Home() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [studentTotal, setStudentTotal] = useState<number | null>(null);

  useEffect(() => {
    Promise.all([
      fetch('/api/v1/auth/me', { credentials: 'include' })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
      api.listStudents({}).then((d) => d.total).catch(() => null),
    ]).then(([user, total]) => {
      setMe(user);
      setStudentTotal(total);
      setLoading(false);
    });
  }, []);

  if (loading) {
    return (
      <div className="empty-state" style={{ minHeight: '60vh' }}>
        <div style={{ width: 32, height: 32, border: '3px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
      </div>
    );
  }

  if (!me) {
    if (typeof window !== 'undefined') window.location.href = '/login';
    return null;
  }

  const greeting = getGreeting();

  return (
    <div>
      {/* ── Page header ──────────────────────── */}
      <div className="page-header">
        <div className="page-eyebrow">OPERATIONS DESK</div>
        <div className="page-header-row">
          <div>
            <h1 className="page-title">{greeting}，{me.name}</h1>
            <p className="page-subtitle">当前仅展示你接入且在授权范围内的实时数据。</p>
          </div>
          <div className="page-actions">
            <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>待办尚未接入</span>
            <Link href="/students/new" className="btn btn-primary">
              打开排课工作台 →
            </Link>
          </div>
        </div>
      </div>

      {/* ── Stat cards row ───────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--space-lg)', marginBottom: 'var(--space-xl)' }} className="stat-grid">
        <StatCard index="01" label="在校学生" value={studentTotal ?? '—'} desc="按当前授权范围实时统计" />
        <StatCard index="02" label="今日课次" value="0" desc="今日暂无排课" />
        <StatCard index="03" label="履约待审" value="0" desc="无待审核出勤" />
        <StatCard index="04" label="排课冲突" value="0" desc="无排课冲突" />
      </div>

      {/* ── Two-column panels ───────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', gap: 'var(--space-lg)', marginBottom: 'var(--space-xl)' }}>
        {/* My todos panel */}
        <div className="form-fieldset" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: 220 }}>
          <div style={{ textAlign: 'center' }}>
            <div className="page-eyebrow" style={{ marginBottom: 12 }}>01</div>
            <h3 style={{ fontSize: 'var(--font-lg)', fontWeight: 700, color: 'var(--fg)', marginBottom: 8 }}>我的待办</h3>
            <p style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-tertiary)' }}>待办数据尚未接入</p>
          </div>
          <Link href="/students" style={{ marginTop: 16, fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>
            前去接入 ↑
          </Link>
        </div>

        {/* Quick actions */}
        <div className="form-fieldset">
          <div className="page-eyebrow" style={{ marginBottom: 12 }}>02</div>
          <h3 style={{ fontSize: 'var(--font-md)', fontWeight: 700, color: 'var(--fg)', marginBottom: 16 }}>快捷操作</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <QuickAction icon={<StudentsIcon />} label="学生档案" sub="查看已授权档案" href="/students" />
            <QuickAction icon={<CalendarIcon />} label="排课日历" sub="查看课表与冲突预检" href="/" disabled />
            <QuickAction icon={<FileCheckIcon />} label="履约审核" sub="尚未接入" href="/" disabled />
            <QuickAction icon={<ChartIcon />} label="月度结算" sub="尚未接入" href="/" disabled />
          </div>
        </div>
      </div>

      {/* ── Today's classes placeholder ──────── */}
      <div className="form-fieldset">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div>
            <div className="page-eyebrow" style={{ marginBottom: 4 }}>03</div>
            <h3 style={{ fontSize: 'var(--font-md)', fontWeight: 700, color: 'var(--fg)' }}>今日课次</h3>
          </div>
          <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>尚未接入</span>
        </div>
        <div className="empty-state" style={{ padding: '32px 16px' }}>
          <p className="empty-state-text">暂无课次数据</p>
        </div>
        <div style={{ textAlign: 'right', marginTop: 8 }}>
          <a href="#" style={{ fontSize: 'var(--font-sm)', color: 'var(--accent)' }}>打开排课日历 →</a>
        </div>
      </div>
    </div>
  );
}

/* ── Sub components ─────────────────────────── */

function StatCard({ index, value, desc }: { index: string; value: number | string; desc: string }) {
  return (
    <div className="stat-card">
      <div className="stat-index">{index}</div>
      <div className="stat-number">{typeof value === 'number' ? value.toLocaleString() : value}</div>
      <div className="stat-label">{index === '01' ? '当前结果' : ''}</div>
      <div className="stat-desc">{desc}</div>
    </div>
  );
}

function QuickAction({ icon, label, sub, href, disabled = false }: { icon: React.ReactNode; label: string; sub: string; href: string; disabled?: boolean }) {
  const base = { display: 'flex', flexDirection: 'column', gap: 4, padding: 14, borderRadius: 'var(--radius-md)', transition: 'background var(--dur-fast) var(--ease)', textDecoration: 'none', opacity: disabled ? 0.35 : 1 };
  if (!disabled) Object.assign(base, { cursor: 'pointer' });
  return (
    <Link
      href={href}
      style={base as React.CSSProperties}
      onClick={(e) => { if (disabled) e.preventDefault(); }}
    >
      <span style={{ color: 'var(--accent)', width: 20, height: 20 }}>{icon}</span>
      <span style={{ fontSize: 'var(--font-sm)', fontWeight: 600, color: 'var(--fg)' }}>{label}</span>
      <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>{sub}</span>
    </Link>
  );
}

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 6) return '夜深了';
  if (h < 9) return '早上好';
  if (h < 12) return '上午好';
  if (h < 14) return '中午好';
  if (h < 18) return '下午好';
  if (h < 22) return '晚上好';
  return '夜深了';
}

/* ── Mini icons for dashboard ────────────────── */
function StudentsIcon() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>);
}
function CalendarIcon() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>);
}
function FileCheckIcon() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>);
}
function ChartIcon() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>);
}
