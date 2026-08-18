'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import Link from 'next/link';
import { api, type Page, type StudentRecord } from '../../lib/api';

const COLS = [
  { key: '学生姓名', label: '学生 / 编号', width: '' },
  { key: '英文名', label: '英文名', width: '120px' },
  { key: 'Arete毕业届', label: 'Arete毕业届', width: '110px' },
  { key: '入学年级', label: 'Arete班', width: '' },
  { key: '来源渠道', label: '来源', width: '80px' },
  { key: '生源跟进状态', label: '跟进', width: '80px' },
  { key: '更新时间', label: '更新', width: '140px' },
  { key: '当前状态', label: '状态', width: '100px' },
];

function str(v: unknown): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : String((x as { text?: string })?.text ?? ''))).join('、');
  if (typeof v === 'object') return String((v as { text?: string })?.text ?? '');
  return String(v);
}

/** 提取照片 token */
function getPhotoToken(rec: Record<string, unknown>): string | null {
  const v = rec['学生照片'];
  if (!v) return null;
  if (Array.isArray(v) && v.length) {
    const item = v[0] as any;
    return item.file_token ?? (typeof item === 'string' ? item : null);
  }
  if (typeof v === 'object' && (v as any).file_token) return (v as any).file_token;
  return null;
}

/** 浏览器可直接访问的照片 URL：优先后端换发的免 token 临时链接，其次走代理 */
function getPhotoUrl(rec: Record<string, unknown>): string | null {
  const v = rec['学生照片'];
  if (Array.isArray(v) && v.length) {
    const item = v[0] as any;
    if (item?.viewUrl) return item.viewUrl;
    if (item?.file_token) return `/api/v1/files/${encodeURIComponent(item.file_token)}`;
  }
  return null;
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
  const [page, setPage] = useState(1);
  const tokenStack = useRef<(string | undefined)[]>([]); // tokenStack[i] = 拉取第 i+1 页所需的 pageToken
  const PAGE_SIZE = 5;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [q, setQ] = useState('');
  const [filters, setFilters] = useState<Record<string, string | string[]>>({
    当前状态: '',
    入学年级: '',
    班主任: [],
    招生负责老师: [],
    来源渠道: '',
    生源跟进状态: '',
    入学年份: '',
    Arete毕业届: '',
  });

  const [dicts, setDicts] = useState<Record<string, string[]>>({});

  useEffect(() => {
    api.dictionaries().then((d) => {
      if (d) setDicts(d);
    }).catch(() => {});
  }, []);

  /** 教师用户（班主任 / 招生负责老师 下拉框数据源） */
  const [headTeacherOptions, setHeadTeacherOptions] = useState<string[]>([]);
  const [recruitOptions, setRecruitOptions] = useState<string[]>([]);
  /** 姓名 → 飞书 Open ID 映射（学生字段存的是 Open ID，筛选时需还原） */
  const nameToOpenId = useRef<Record<string, string>>({});
  useEffect(() => {
    let alive = true;
    const collected: { name: string; openId: string; teacherType: string }[] = [];
    const fetchPage = async (token?: string): Promise<void> => {
      const params: Record<string, string | undefined> = { pageSize: '100' };
      if (token) params.pageToken = token;
      const p = await api.listUsers(params);
      for (const u of p.items) {
        collected.push({
          name: String(u['姓名'] ?? ''),
          openId: String(u['飞书 Open ID'] ?? ''),
          teacherType: String(u['教师类型'] ?? ''),
        });
      }
      if (p.hasMore && p.pageToken) await fetchPage(p.pageToken);
    };
    fetchPage()
      .then(() => {
        if (!alive) return;
        const map: Record<string, string> = {};
        for (const u of collected) if (u.name && u.openId) map[u.name] = u.openId;
        nameToOpenId.current = map;
        const named = collected.filter((u) => u.name);
        setHeadTeacherOptions(named.filter((u) => u.teacherType === '班主任').map((u) => u.name));
        setRecruitOptions(named.filter((u) => u.teacherType === '招生老师').map((u) => u.name));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const buildParams = useCallback(
    (token?: string): Record<string, string | undefined> => {
      const params: Record<string, string | undefined> = {
        pageSize: String(PAGE_SIZE),
        sortBy: '学籍号（脱敏）',
        sortOrder: 'asc',
      };
      if (q) params.q = q;
      for (const [k, v] of Object.entries(filters)) {
        if (Array.isArray(v) && v.length) {
          // 班主任 / 招生负责老师 存的是 Open ID，下拉选的是姓名，需还原
          const ids = ['班主任', '招生负责老师'].includes(k)
            ? v.map((name) => nameToOpenId.current[name] ?? name).filter(Boolean)
            : v;
          if (ids.length) params[k] = ids.join(',');
        } else if (typeof v === 'string' && v) params[k] = v;
      }
      if (token) params.pageToken = token;
      return params;
    },
    [q, filters, PAGE_SIZE],
  );

  /** 拉取指定页（token 已知时直接拉；拉取后用返回 token 续填下一页游标） */
  const fetchPage = useCallback(
    async (target: number, token?: string) => {
      setLoading(true);
      setError('');
      try {
        const data: Page<StudentRecord> = await api.listStudents(buildParams(token));
        setItems(data.items);
        setTotal(data.total);
        setPage(target);
        tokenStack.current[target] = data.pageToken; // 第 target 页之后的游标
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [buildParams],
  );

  /** 跳转到目标页：若游标未知则向前逐页补全（不渲染中间页），再拉取目标页 */
  const goToPage = useCallback(
    async (target: number) => {
      const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      target = Math.min(Math.max(target, 1), totalPages);
      if (target - 1 < tokenStack.current.length) {
        await fetchPage(target, tokenStack.current[target - 1]);
        return;
      }
      for (let p = tokenStack.current.length; p < target; p++) {
        const data = await api.listStudents(buildParams(tokenStack.current[p - 1]));
        tokenStack.current[p] = data.pageToken;
      }
      await fetchPage(target, tokenStack.current[target - 1]);
    },
    [total, PAGE_SIZE, fetchPage, buildParams],
  );

  // 筛选 / 搜索变化 → 重置分页并从第 1 页重新加载
  useEffect(() => {
    tokenStack.current = [];
    setPage(1);
    fetchPage(1, undefined);
  }, [q, filters, fetchPage]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    tokenStack.current = [];
    setPage(1);
    fetchPage(1, undefined);
  };

  const setFilter = (key: string, val: string | string[]) => {
    setFilters((prev) => ({ ...prev, [key]: val }));
  };

  const handleDelete = async (id: string) => {
    if (!confirm('确认删除该学生档案？此操作不可恢复。')) return;
    try {
      await api.archiveStudent(id);
      tokenStack.current = [];
      setPage(1);
      fetchPage(1, undefined);
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
                  if (Array.isArray(v) && v.length) {
                    const ids = ['班主任', '招生负责老师'].includes(k)
                      ? v.map((name) => nameToOpenId.current[name] ?? name).filter(Boolean)
                      : v;
                    if (ids.length) params[k] = ids.join(',');
                  } else if (typeof v === 'string' && v) params[k] = v;
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
            placeholder="姓名、英文名"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <button type="submit">查询</button>
        </div>

        <FilterSelect
          label="状态"
          value={filters['当前状态'] as string}
          onChange={(v) => setFilter('当前状态', v)}
          options={dicts['当前状态'] ?? ['已录未报到', '在校在读', '离校未毕(休学）', '离校未毕(保留学籍）', '毕业', '退学', '放弃入学', '潜在学生']}
        />
        <FilterSelect
          label="年级"
          value={filters['入学年级'] as string}
          onChange={(v) => setFilter('入学年级', v)}
          options={dicts['入学年级'] ?? ['一年级', '二年级', '三年级', '四年级', '五年级', '六年级', '初一', '初二', '初三', '高一', '高二', '高三']}
        />
        <FilterSelect
          label="班主任"
          value={filters['班主任'] as string[]}
          onChange={(v) => setFilter('班主任', v)}
          options={headTeacherOptions}
          multi
        />
        <FilterSelect
          label="招生"
          value={filters['招生负责老师'] as string[]}
          onChange={(v) => setFilter('招生负责老师', v)}
          options={recruitOptions}
          multi
        />
        <FilterSelect
          label="来源"
          value={filters['来源渠道'] as string}
          onChange={(v) => setFilter('来源渠道', v)}
          options={dicts['来源渠道'] ?? ['官网', '转介绍', '展会', '社交媒体', '代理', '其他']}
        />
        <FilterSelect
          label="跟进"
          value={filters['生源跟进状态'] as string}
          onChange={(v) => setFilter('生源跟进状态', v)}
          options={dicts['生源跟进状态'] ?? ['新线索', '跟进中', '已报名', '已入学', '已流失']}
        />
        <FilterSelect
          label="入学"
          value={filters['入学年份'] as string}
          onChange={(v) => setFilter('入学年份', v)}
          options={dicts['入学年份'] ?? ['2021春', '2021秋', '2022春', '2022秋', '2023春', '2023秋', '2024春', '2024秋', '2025春', '2025秋', '2026春', '2026秋', '2027春', '2027秋']}
        />
        <FilterSelect
          label="Arete届"
          value={filters['Arete毕业届'] as string}
          onChange={(v) => setFilter('Arete毕业届', v)}
          options={dicts['Arete毕业届'] ?? ['第1届', '第2届', '第3届', '第4届', '第5届', '第6届']}
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
                      {/* 学生 / 编号（超链接 + 缩略图） */}
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          {getPhotoUrl(s) ? (
                            <div className="photo-thumb">
                              <img
                                src={getPhotoUrl(s)!}
                                alt={name}
                                className="avatar-dot"
                                style={{ width: 34, height: 34, objectFit: 'cover' }}
                                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                              />
                              <div className="photo-tip" role="tooltip">
                                <img src={getPhotoUrl(s)!} alt={name} />
                              </div>
                            </div>
                          ) : (
                            <span className={`avatar-dot ${avatarColor(name)}`}>{name.charAt(0)}</span>
                          )}
                          <Link href={`/students/${s.id}`} className="name-link">
                            <div style={{ fontWeight: 600, fontSize: 'var(--font-sm)' }}>{name}</div>
                            <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>{str(s['学生编号']) || '—'}</div>
                          </Link>
                        </div>
                      </td>
                      {/* 英文名 */}
                      <td style={{ fontSize: 'var(--font-sm)' }}>{str(s['英文名']) || '—'}</td>
                      {/* Arete毕业届 */}
                      <td style={{ fontSize: 'var(--font-sm)' }}>{str(s['Arete毕业届']) || '—'}</td>
                      {/* Arete班（年级/班级） */}
                      <td>
                        <div style={{ fontWeight: 500 }}>{str(s['入学年级']) || '—'}</div>
                        <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>{str(s['班级']) || '未分班'}</div>
                      </td>
                      {/* 来源渠道 */}
                      <td style={{ fontSize: 'var(--font-sm)' }}>{str(s['来源渠道']) || '—'}</td>
                      {/* 跟进状态 */}
                      <td style={{ fontSize: 'var(--font-sm)' }}>{str(s['生源跟进状态']) || '—'}</td>
                      {/* Updated */}
                      <td style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-secondary)' }}>
                        {fmtDate(s['更新时间']) || '—'}
                      </td>
                      {/* Status（移到更新列后） */}
                      <td>
                        <div className={`status-dot ${statusClass(status)}`}>{status || '—'}</div>
                        <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)', marginTop: 2 }}>{str(s['性别'] || '')}</div>
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

          {/* Footer：分页（每页 5 条，按学籍号升序） */}
          {(() => {
            const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
            const startP = Math.max(1, page - 2);
            const endP = Math.min(totalPages, page + 2);
            const pageNumbers: number[] = [];
            for (let i = startP; i <= endP; i++) pageNumbers.push(i);
            return (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 'var(--space-md)', paddingTop: 'var(--space-md)', borderTop: '1px solid var(--border)', flexWrap: 'wrap', gap: 8 }}>
                <span style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-tertiary)' }}>共 {total} 条</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <button className="btn btn-outline btn-sm" disabled={page <= 1 || loading} onClick={() => goToPage(page - 1)}>上一页</button>
                  {pageNumbers.map((p) => (
                    <button
                      key={p}
                      className={`btn btn-sm ${p === page ? 'btn-primary' : 'btn-outline'}`}
                      disabled={loading}
                      onClick={() => goToPage(p)}
                    >
                      {p}
                    </button>
                  ))}
                  <button className="btn btn-outline btn-sm" disabled={page >= totalPages || loading} onClick={() => goToPage(page + 1)}>下一页</button>
                  <span style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-tertiary)', marginLeft: 8 }}>第 {page} / {totalPages} 页</span>
                </div>
              </div>
            );
          })()}
        </>
      ) : null}
    </div>
  );
}
