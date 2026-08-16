'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import Link from 'next/link';
import { api, type Page, type StudentRecord } from '../../lib/api';

const COLS = [
  { key: '学籍号', label: '学籍号', width: '130px' },
  { key: '学生姓名', label: '学生 / 编号', width: '' },
  { key: '当前状态', label: '状态', width: '100px' },
  { key: '当前年级', label: '年级 / 班级', width: '' },
  { key: '校区', label: '校区', width: '' },
  { key: '来源渠道', label: '来源', width: '80px' },
  { key: '生源跟进状态', label: '跟进', width: '80px' },
  { key: '更新时间', label: '更新', width: '80px' },
];

function str(v: unknown): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : String((x as { text?: string })?.text ?? ''))).join('、');
  if (typeof v === 'object') return String((v as { text?: string })?.text ?? '');
  return String(v);
}

/** 格式化时间戳（秒或毫秒）为 YYYY-MM-DD HH:mm */
function fmtDate(v: unknown): string {
  if (!v) return '';
  const n = Number(v);
  if (!n || isNaN(n)) return String(v);
  // 判断是秒还是毫秒（毫秒 > 1e12）
  const ms = n > 1e12 ? n : n * 1000;
  const d = new Date(ms);
  if (isNaN(d.getTime())) return String(v);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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

/** Small dropdown filter component */
function FilterSelect({
  label,
  value,
  onChange,
  options,
  multi = false,
}: {
  label: string;
  value: string | string[];
  onChange: (val: string | string[]) => void;
  options: string[];
  multi?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const sel = Array.isArray(value) ? value : value ? [value] : [];

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [ref]);

  const toggle = (opt: string) => {
    if (multi) {
      const next = sel.includes(opt) ? sel.filter((x) => x !== opt) : [...sel, opt];
      onChange(next);
    } else {
      onChange(opt === value ? '' : opt);
      setOpen(false);
    }
  };

  const clear = () => {
    onChange(multi ? [] : '');
    setOpen(false);
  };

  return (
    <div className="filter-select" ref={ref}>
      <button type="button" className="filter-select-trigger" onClick={() => setOpen(!open)}>
        <span>{label}</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><path d="m6 9 6 6 6-6"/></svg>
      </button>
      {open && (
        <div className="filter-select-dropdown">
          {!multi && (
            <div
              className={`filter-select-opt${!value ? ' active' : ''}`}
              onClick={() => onChange('')}
            >
              全部
            </div>
          )}
          {options.map((o) => (
            <div
              key={o}
              className={`filter-select-opt${(multi ? sel.includes(o) : o === value) ? ' active' : ''}`}
              onClick={() => toggle(o)}
            >
              {multi && <span className="filter-check">{sel.includes(o) ? '✓' : ''}</span>}
              {o}
            </div>
          ))}
          {sel.length > 0 && (
            <div className="filter-select-clear" onClick={clear}>清除筛选</div>
          )}
        </div>
      )}
    </div>
  );
}

export default function StudentsPage() {
  const [items, setItems] = useState<StudentRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [pageToken, setPageToken] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [q, setQ] = useState('');
  const [filters, setFilters] = useState<Record<string, string | string[]>>({
    当前状态: '',
    当前年级: '',
    班主任: [],
    招生负责老师: [],
    来源渠道: '',
    生源跟进状态: '',
    入学级: '',
    毕业届: '',
  });

  const [dicts, setDicts] = useState<Record<string, string[]>>({});

  useEffect(() => {
    api.dictionaries().then((d) => {
      if (d) setDicts(d);
    }).catch(() => {});
  }, []);

  const load = useCallback(
    async (token?: string, append = false) => {
      setLoading(true);
      setError('');
      try {
        const params: Record<string, string | undefined> = {};
        if (q) params.q = q;
        for (const [k, v] of Object.entries(filters)) {
          if (Array.isArray(v) && v.length) params[k] = v.join(',');
          else if (typeof v === 'string' && v) params[k] = v;
        }
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
    [q, filters],
  );

  useEffect(() => {
    setItems([]);
    load(undefined, false);
  }, [q, filters, load]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setItems([]);
    load(undefined, false);
  };

  const setFilter = (key: string, val: string | string[]) => {
    setFilters((prev) => ({ ...prev, [key]: val }));
  };

  const handleDelete = async (id: string) => {
    if (!confirm('确认删除该学生档案？此操作不可恢复。')) return;
    try {
      await api.archiveStudent(id);
      load(undefined, false);
    } catch (e) {
      alert('删除失败：' + (e as Error).message);
    }
  };

  return (
    <div>
      {/* ── Page header ──────────────────────── */}
      <div className="page-header">
        <div className="page-header-row">
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-md)' }}>
            <h1 className="page-title">学生综合档案</h1>
            <span className="stat-inline">{total} 条结果</span>
          </div>
          <p className="page-subtitle">基础档案、学籍状态与数据密级在同一授权视图中呈现。</p>
          <div className="page-actions">
            <button
              className="btn btn-outline btn-sm"
              onClick={() => {
                const params: Record<string, string | undefined> = {};
                if (q) params.q = q;
                for (const [k, v] of Object.entries(filters)) {
                  if (Array.isArray(v) && v.length) params[k] = v.join(',');
                  else if (typeof v === 'string' && v) params[k] = v;
                }
                api.exportStudents(params).then((csv) => {
                  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url; a.download = 'students.csv'; a.click();
                });
              }}
            >
              ↓ 导出授权范围
            </button>
            <Link href="/students/new" className="btn btn-primary">
              + 新建学生
            </Link>
          </div>
        </div>
      </div>

      {/* ── Search + filters ─────────────────── */}
      <form onSubmit={handleSearch} className="filter-bar">
        <div className="search-bar" style={{ flex: 1, minWidth: 200 }}>
          <svg className="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <input
            placeholder="学生编号、姓名、英文名或班级"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <button type="submit">查询</button>
        </div>

        <FilterSelect
          label="当前状态"
          value={filters['当前状态'] as string}
          onChange={(v) => setFilter('当前状态', v)}
          options={dicts['当前状态'] ?? ['已录未报到', '在校在读', '离校未毕(休学）', '离校未毕(保留学籍）', '毕业', '退学', '放弃入学', '潜在学生']}
        />
        <FilterSelect
          label="年级"
          value={filters['当前年级'] as string}
          onChange={(v) => setFilter('当前年级', v)}
          options={dicts['当前年级'] ?? ['一年级', '二年级', '三年级', '四年级', '五年级', '六年级', '初一', '初二', '初三', '高一', '高二', '高三']}
        />
        <FilterSelect
          label="班主任"
          value={filters['班主任'] as string[]}
          onChange={(v) => setFilter('班主任', v)}
          options={dicts['班主任'] ?? []}
          multi
        />
        <FilterSelect
          label="招生老师"
          value={filters['招生负责老师'] as string[]}
          onChange={(v) => setFilter('招生负责老师', v)}
          options={dicts['招生负责老师'] ?? []}
          multi
        />
        <FilterSelect
          label="来源渠道"
          value={filters['来源渠道'] as string}
          onChange={(v) => setFilter('来源渠道', v)}
          options={dicts['来源渠道'] ?? ['官网', '转介绍', '展会', '社交媒体', '代理', '其他']}
        />
        <FilterSelect
          label="跟进状态"
          value={filters['生源跟进状态'] as string}
          onChange={(v) => setFilter('生源跟进状态', v)}
          options={dicts['生源跟进状态'] ?? ['新线索', '跟进中', '已报名', '已入学', '已流失']}
        />
        <FilterSelect
          label="入学级"
          value={filters['入学级'] as string}
          onChange={(v) => setFilter('入学级', v)}
          options={dicts['入学级'] ?? ['2021', '2022', '2023', '2024', '2025', '2026', '2027']}
        />
        <FilterSelect
          label="毕业届"
          value={filters['毕业届'] as string}
          onChange={(v) => setFilter('毕业届', v)}
          options={dicts['毕业届'] ?? ['2021', '2022', '2023', '2024', '2025', '2026', '2027']}
        />
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
                  <th style={{ width: 120 }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {items.map((s) => {
                  const name = str(s['学生姓名']) || '—';
                  const status = str(s['当前状态']);
                  return (
                    <tr key={s.id}>
                      {/* 学籍号 - clickable link */}
                      <td>
                        <Link href={`/students/${s.id}`} className="link-cell">
                          {str(s['学籍号（脱敏）']) || str(s['学生编号']) || '—'}
                        </Link>
                      </td>
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
                      {/* Grade/Class */}
                      <td>
                        <div style={{ fontWeight: 500 }}>{str(s['当前年级']) || '—'}</div>
                        <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>{str(s['班级']) || '未分班'}</div>
                      </td>
                      {/* Campus */}
                      <td>{str(s['校区']) || '—'}</td>
                      {/* 来源渠道 */}
                      <td style={{ fontSize: 'var(--font-sm)' }}>{str(s['来源渠道']) || '—'}</td>
                      {/* 跟进状态 */}
                      <td style={{ fontSize: 'var(--font-sm)' }}>{str(s['生源跟进状态']) || '—'}</td>
                      {/* Updated */}
                      <td style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-secondary)' }}>
                        {fmtDate(s['更新时间']) || '—'}
                      </td>
                      {/* Actions: 编辑 + 删除 */}
                      <td>
                        <div style={{ display: 'flex', gap: 4 }}>
                          <Link href={`/students/${s.id}/edit`} className="btn btn-ghost btn-sm" style={{ padding: '4px 10px', fontSize: 'var(--font-xs)' }}>
                            编辑
                          </Link>
                          <button
                            className="btn btn-danger btn-sm"
                            style={{ padding: '4px 10px', fontSize: 'var(--font-xs)' }}
                            onClick={() => handleDelete(s.id)}
                          >
                            删除
                          </button>
                        </div>
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
