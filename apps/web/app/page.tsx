'use client';

import { useEffect, useState, FormEvent } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { api, type SessionUser } from '../lib/api';

interface Metrics {
  cards: { key: string; label: string; value: number }[];
  todos: { key: string; label: string; value: number }[];
  exceptions: { key: string; label: string; value: number }[];
}
interface SearchResult {
  students: { id: string; label: string }[];
  teachers: { id: string; label: string }[];
  courses: { id: string; label: string }[];
  classes: { id: string; label: string }[];
}

export default function Home() {
  const tc = useTranslations('common');
  const [me, setMe] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchResult | null>(null);

  useEffect(() => {
    Promise.all([
      fetch('/api/v1/auth/me', { credentials: 'include' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      api.dashboardMetrics().catch(() => null),
    ]).then(([user, m]) => {
      setMe(user);
      setMetrics(m);
      setLoading(false);
    });
  }, []);

  async function onSearch(e: FormEvent) {
    e.preventDefault();
    const term = q.trim();
    if (!term) { setResults(null); return; }
    const r = await api.globalSearch(term).catch(() => null);
    setResults(r);
  }

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
  const cardByKey = (k: string) => metrics?.cards.find((c) => c.key === k)?.value ?? '—';

  return (
    <div>
      <div className="page-header">
        <div className="page-eyebrow">OPERATIONS DESK</div>
        <div className="page-header-row">
          <div>
            <h1 className="page-title">{greeting}，{me.name}</h1>
            <p className="page-subtitle">{tc('dashboardSubtitle')}</p>
          </div>
          <div className="page-actions" style={{ minWidth: 280 }}>
            <form onSubmit={onSearch} style={{ display: 'flex', gap: 8 }}>
              <input className="form-input" placeholder="全局搜索：学生 / 教师 / 课程 / 教学班" value={q} onChange={(e) => setQ(e.target.value)} />
              <button className="btn btn-outline" type="submit">{tc('search')}</button>
            </form>
            {results && (
              <div className="form-fieldset" style={{ marginTop: 8, textAlign: 'left' }}>
                <SearchGroup title="学生" items={results.students} href={(id) => `/students/${id}`} />
                <SearchGroup title="教师" items={results.teachers} href={() => '/teachers'} />
                <SearchGroup title="课程方案" items={results.courses} href={() => '/courses'} />
                <SearchGroup title="教学班" items={results.classes} href={() => '/teaching-classes'} />
                {results.students.length + results.teachers.length + results.courses.length + results.classes.length === 0 && (
                  <p className="muted" style={{ fontSize: 'var(--font-sm)' }}>{tc('noMatchResult')}</p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Stat cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--space-lg)', marginBottom: 'var(--space-xl)' }} className="stat-grid">
        <StatCard index="01" label="在读学生" value={cardByKey('students')} desc="按授权范围实时统计" />
        <StatCard index="02" label="今日课次" value={cardByKey('todaySessions')} desc="今日已排课次" />
        <StatCard index="03" label="待履约" value={cardByKey('pendingFulfillment')} desc="未转可计费的履约" />
        <StatCard index="04" label="待确认课次" value={cardByKey('pendingSessions')} desc="待确认排课" />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', gap: 'var(--space-lg)', marginBottom: 'var(--space-xl)' }}>
        {/* Todos */}
        <div className="form-fieldset">
          <div className="page-eyebrow" style={{ marginBottom: 12 }}>01 · 我的待办</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {(metrics?.todos ?? []).map((t) => (
              <div key={t.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
                <span style={{ fontSize: 'var(--font-sm)', color: 'var(--fg)' }}>{t.label}</span>
                <span className="stat-number" style={{ fontSize: 'var(--font-md)' }}>{t.value}</span>
              </div>
            ))}
            {(metrics?.todos ?? []).length === 0 && <p className="muted" style={{ fontSize: 'var(--font-sm)' }}>{tc('noTodos')}</p>}
          </div>
        </div>

        {/* Quick actions */}
        <div className="form-fieldset">
          <div className="page-eyebrow" style={{ marginBottom: 12 }}>02 · 快捷入口</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <QuickAction icon={<StudentsIcon />} label="学生档案" sub="查看已授权档案" href="/students" />
            <QuickAction icon={<FileCheckIcon />} label="教师履约" sub="出勤提交与审核" href="/attendance" />
            <QuickAction icon={<ChartIcon />} label="计费结算" sub="计费明细 / 月结" href="/billing" />
            <QuickAction icon={<BellIcon />} label="通知任务" sub="模板与发送" href="/notifications" />
          </div>
        </div>
      </div>

      {/* Exceptions */}
      <div className="form-fieldset">
        <div className="page-eyebrow" style={{ marginBottom: 12 }}>03 · 异常轨</div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {(metrics?.exceptions ?? []).map((e) => (
            <div key={e.key} style={{ flex: '1 1 200px', padding: '12px 14px', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 'var(--font-sm)', color: 'var(--fg)' }}>{e.label}</span>
              <span className="stat-number" style={{ fontSize: 'var(--font-md)', color: e.value > 0 ? 'var(--danger)' : 'var(--fg)' }}>{e.value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function SearchGroup({ title, items, href }: { title: string; items: { id: string; label: string }[]; href: (id: string) => string }) {
  if (items.length === 0) return null;
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)', margin: '4px 0' }}>{title}</div>
      {items.map((it) => (
        <Link key={it.id} href={href(it.id)} className="btn btn-ghost btn-sm" style={{ marginRight: 6, marginBottom: 4 }}>{it.label}</Link>
      ))}
    </div>
  );
}

function StatCard({ index, label, value, desc }: { index: string; label: string; value: number | string; desc: string }) {
  return (
    <div className="stat-card">
      <div className="stat-index">{index}</div>
      <div className="stat-number">{typeof value === 'number' ? value.toLocaleString() : value}</div>
      <div className="stat-label">{label}</div>
      <div className="stat-desc">{desc}</div>
    </div>
  );
}

function QuickAction({ icon, label, sub, href }: { icon: React.ReactNode; label: string; sub: string; href: string }) {
  return (
    <Link href={href} style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: 14, borderRadius: 'var(--radius-md)', transition: 'background var(--dur-fast) var(--ease)', textDecoration: 'none', cursor: 'pointer' } as React.CSSProperties}>
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

function StudentsIcon() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>);
}
function FileCheckIcon() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>);
}
function ChartIcon() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>);
}
function BellIcon() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>);
}
