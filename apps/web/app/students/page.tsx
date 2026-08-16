'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { api, type Page, type StudentRecord } from '../../lib/api';

const STATUS_TABS_DEFAULT = [{ key: '', label: '全部' }];

const COLS = [
  { key: '学生编号', label: '学生 / 编号', width: '' },
  { key: '学生姓名', label: '学籍', width: '' },
  { key: '当前状态', label: '', width: '80px' },
  { key: '班级', label: '年级 / 班级', width: '' },
  { key: '校区', label: '校区', width: '' },
  { key: '数据密级', label: '档案', width: '80px' },
  { key: '更新时间', label: '更新', width: '80px' },
];

function str(v: unknown): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : String((x as { text?: string })?.text ?? ''))).join('、');
  if (typeof v === 'object') return String((v as { text?: string })?.text ?? '');
  return String(v);
}

function avatarColor(name: string): string {
  const colors = ['avatar-teal', 'avatar-emerald', 'avatar-amber', 'avatar-rose'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

function statusClass(status: string): string {
  if (status === '在校在读' || status === '已录未报到' || status === '潜在学生') return 'status-active';
  if (status === '毕业') return 'status-graduated';
  return 'status-left';
}

function badgeClass(level: string): string {
  if (level === 'L1') return 'badge-l1';
  if (level === 'L2') return 'badge-l2';
  if (level === 'L3') return 'badge-l3';
  return 'badge-l4';
}

export default function StudentsPage() {
  const [items, setItems] = useState<StudentRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [pageToken, setPageToken] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [q, setQ] = useState('');
  const [activeTab, setActiveTab] = useState('');
  const [statusTabs, setStatusTabs] = useState(STATUS_TABS_DEFAULT);

  useEffect(() => {
    api
      .dictionaries()
      .then((d) => {
        const opts = d?.['当前状态'] ?? [];
        if (opts.length) setStatusTabs([{ key: '', label: '全部' }, ...opts.map((o) => ({ key: o, label: o }))]);
      })
      .catch(() => {
        /* 兜底保留默认「全部」 */
      });
  }, []);

  const load = useCallback(
    async (token?: string, append = false) => {
      setLoading(true);
      setError('');
      try {
        const params: Record<string, string> = {};
        if (q) params.q = q;
        if (activeTab) params.当前状态 = activeTab;
        if (token) params.pageToken = token;
        const data: Page<StudentRecord> = await api.listStudents(params);
        setItems((prev) => (append ? [...prev, ...data.items] : data.items));
        setTotal(data.total);
        setHasMore(data.hasMore);
        setPageToken(data.pageToken);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [q, activeTab],
  );

  useEffect(() => {
    setItems([]);
    load(undefined, false);
  }, [q, activeTab, load]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setItems([]);
    load(undefined, false);
  };

  const handleArchive = async (id: string) => {
    if (!confirm('确认将该学生状态改为「离校」？')) return;
    await api.archiveStudent(id);
    load(undefined, false);
  };

  return (
    <div>
      {/* ── Page header ──────────────────────── */}
      <div className="page-header">
        <div className="page-eyebrow">STUDENT REGISTRY / P-{String(total).padStart(3, '0')}</div>
        <div className="page-header-row">
          <div>
            <h1 className="page-title">学生综合档案</h1>
            <p className="page-subtitle">基础档案、学籍状态与数据密级在同一授权视图中呈现。</p>
          </div>
          <div className="page-actions">
            <button
              className="btn btn-outline btn-sm"
              onClick={() => api.exportStudents({ q, 当前状态: activeTab }).then((csv) => {
                const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url; a.download = 'students.csv'; a.click();
              })}
            >
              ↓ 导出授权范围
            </button>
            <Link href="/students/new" className="btn btn-primary">
              + 新建学生
            </Link>
          </div>
        </div>
      </div>

      {/* ── Stats overview ───────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 'var(--space-lg)', marginBottom: 'var(--space-lg)' }} className="stat-grid">
        <StatMini label="当前结果" value={total} sub={activeTab || '按当前授权范围过滤'} />
        <StatMini label="数据范围" value={1} sub="全部" accent />
        <StatMini label="密级上限" value="L4" sub="超出范围的条数默认隐藏" gold />
      </div>

      {/* ── Search + filters ─────────────────── */}
      <form onSubmit={handleSearch} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-md)', marginBottom: 'var(--space-lg)', flexWrap: 'wrap' }}>
        <div className="search-bar" style={{ flex: 1, minWidth: 240 }}>
          <svg className="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <input
            placeholder="学生编号、姓名、英文名或班级"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <button type="submit">查询</button>
        </div>

        <div className="filter-tabs">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" width="16" height="16" style={{ color: 'var(--fg-tertiary)', flexShrink: 0, alignSelf: 'center', marginRight: 4 }}>
            <line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/>
          </svg>
          {statusTabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              className={`filter-tab${activeTab === tab.key ? ' active' : ''}`}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </form>

      {/* ── Error / Loading ──────────────────── */}
      {error && <p className="msg-error">加载失败：{error}</p>}
      {loading && items.length === 0 && (
        <div className="empty-state" style={{ minHeight: 200 }}>
          <div style={{ width: 28, height: 28, border: '3px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
        </div>
      )}

      {/* ── Data table ───────────────────────── */}
      {!loading || items.length > 0 ? (
        <>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  {COLS.map((c) => (
                    <th key={c.key} style={c.width ? { width: c.width } : undefined}>{c.label}</th>
                  ))}
                  <th style={{ width: 80 }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {items.map((s) => {
                  const name = str(s['学生姓名']) || '—';
                  const status = str(s['当前状态']);
                  const level = str(s['数据密级']);
                  return (
                    <tr key={s.id}>
                      {/* Avatar + Name */}
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <span className={`avatar-dot ${avatarColor(name)}`}>{name.charAt(0)}</span>
                          <div>
                            <div style={{ fontWeight: 600, fontSize: 'var(--font-sm)' }}>{name}</div>
                            <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>{str(s['学生编号']) || '—'}</div>
                          </div>
                        </div>
                      </td>
                      {/* Status */}
                      <td>
                        <div className={`status-dot ${statusClass(status)}`}>{status || '—'}</div>
                        <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)', marginTop: 2 }}>{str(s['性别'] || '')}</div>
                      </td>
                      {/* Status column (spacer for alignment with reference) */}
                      <td></td>
                      {/* Grade/Class */}
                      <td>
                        <div style={{ fontWeight: 500 }}>{str(s['当前年级']) || '—'}</div>
                        <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>{str(s['班级']) || '未分班'}</div>
                      </td>
                      {/* Campus */}
                      <td>{str(s['校区']) || '—'}</td>
                      {/* Level badge */}
                      <td><span className={`badge ${badgeClass(level)}`}>{level || '—'}</span></td>
                      {/* Level desc */}
                      <td style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>{s['特殊支持摘要'] ? '特需充' : '待补充'}</td>
                      {/* Updated */}
                      <td style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-secondary)' }}>
                        {str(s['更新时间']).slice(5, 10) || '—'}
                      </td>
                      {/* Actions */}
                      <td>
                        <Link href={`/students/${s.id}`} className="btn btn-ghost btn-sm" style={{ padding: '4px 10px' }}>
                          编辑
                        </Link>
                      </td>
                    </tr>
                  );
                })}
                {!loading && items.length === 0 && (
                  <tr>
                    <td colSpan={COLS.length + 1}>
                      <div className="empty-state">
                        <div className="empty-state-text">暂无学生数据</div>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Footer */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 'var(--space-md)', paddingTop: 'var(--space-md)', borderTop: '1px solid var(--border)' }}>
            <span style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-tertiary)' }}>共 {total} 条</span>
            {hasMore && (
              <button className="btn btn-outline btn-sm" onClick={() => pageToken && load(pageToken, true)}>
                加载更多
              </button>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}

/* ── Mini stat card for overview row ───────────── */

function StatMini({ label, value, sub, accent, gold }: { label: string; value: number | string; sub: string; accent?: boolean; gold?: boolean }) {
  const color = gold ? 'var(--gold)' : accent ? 'var(--accent)' : 'var(--gold)';
  return (
    <div className="stat-card" style={{ padding: 'var(--space-md) var(--space-lg)' }}>
      <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)', fontWeight: 600, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 'var(--font-3xl)', fontWeight: 800, color, lineHeight: 1.1, letterSpacing: '-0.02em' }}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
      <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)', marginTop: 2 }}>{sub}</div>
    </div>
  );
}
