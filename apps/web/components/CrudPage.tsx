'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { api, type Page } from '../lib/api';

export type CrudFieldType = 'text' | 'textarea' | 'number' | 'date' | 'select' | 'multiselect';

export interface CrudColumn {
  key: string;
  label: string;
  width?: string;
  render?: (v: unknown, row: Record<string, unknown>) => React.ReactNode;
  filter?: boolean;
  filterOptions?: string[];
  form?: boolean;
  type?: CrudFieldType;
  options?: string[];
  required?: boolean;
}

export interface CrudApi {
  list: (params: Record<string, string | undefined>) => Promise<Page<Record<string, unknown>>>;
  create: (data: Record<string, unknown>) => Promise<unknown>;
  update: (id: string, data: Record<string, unknown>) => Promise<unknown>;
  archive: (id: string) => Promise<unknown>;
  transition?: (id: string, to: string) => Promise<unknown>;
}

export interface CrudPageProps {
  title: string;
  subtitle?: string;
  columns: CrudColumn[];
  api: CrudApi;
  statusField?: string;
  transitions?: Record<string, string[]>;
  statusClass?: (s: string) => string;
}

function str(v: unknown): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : String((x as { text?: string })?.text ?? ''))).join('、');
  if (typeof v === 'object') return String((v as { text?: string })?.text ?? '');
  return String(v);
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (val: string) => void;
  options: string[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  return (
    <div className="filter-select" ref={ref}>
      <button type="button" className="filter-select-trigger" onClick={() => setOpen(!open)}>
        <span>{label}{value ? `：${value}` : ''}</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><path d="m6 9 6 6 6-6" /></svg>
      </button>
      {open && (
        <div className="filter-select-dropdown">
          <div className={`filter-select-opt${!value ? ' active' : ''}`} onClick={() => { onChange(''); setOpen(false); }}>全部</div>
          {options.map((o) => (
            <div key={o} className={`filter-select-opt${o === value ? ' active' : ''}`} onClick={() => { onChange(o); setOpen(false); }}>{o}</div>
          ))}
        </div>
      )}
    </div>
  );
}

const overlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(8,12,20,0.62)', zIndex: 50,
  display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '6vh 16px', overflowY: 'auto',
};
const modalStyle: React.CSSProperties = {
  background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 14,
  width: 'min(880px, 100%)', boxShadow: '0 24px 60px rgba(0,0,0,0.4)',
};
const rowActions: React.CSSProperties = { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' };

export default function CrudPage({ title, subtitle, columns, api, statusField, transitions, statusClass }: CrudPageProps) {
  const [items, setItems] = useState<Record<string, unknown>[]>([]);
  const [total, setTotal] = useState(0);
  const [pageToken, setPageToken] = useState<string | undefined>();
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [modal, setModal] = useState<null | { mode: 'create' | 'edit'; row?: Record<string, unknown> }>(null);
  const [form, setForm] = useState<Record<string, unknown>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txMenu, setTxMenu] = useState<string | null>(null);

  const filterCols = columns.filter((c) => c.filter);
  const formCols = columns.filter((c) => c.form);

  const load = useCallback(async (token?: string, append = false) => {
    setLoading(true);
    setError(null);
    try {
      const params: Record<string, string | undefined> = {};
      for (const c of filterCols) {
        const v = filters[c.key];
        if (v) params[c.key] = v;
      }
      if (token) params.pageToken = token;
      const res = await api.list(params);
      setItems(append ? [...items, ...res.items] : res.items);
      setTotal(res.total);
      setHasMore(res.hasMore);
      setPageToken(res.pageToken);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [api, filters, filterCols, items]);

  useEffect(() => { load(); }, [load]);

  function openCreate() {
    const init: Record<string, unknown> = {};
    for (const c of formCols) init[c.key] = c.type === 'multiselect' ? [] : '';
    setForm(init);
    setModal({ mode: 'create' });
    setError(null);
  }

  function openEdit(row: Record<string, unknown>) {
    const init: Record<string, unknown> = {};
    for (const c of formCols) {
      init[c.key] = c.type === 'multiselect'
        ? (Array.isArray(row[c.key]) ? row[c.key] : str(row[c.key]).split('、').filter(Boolean))
        : (row[c.key] ?? '');
    }
    setForm(init);
    setModal({ mode: 'edit', row });
    setError(null);
  }

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {};
      for (const c of formCols) {
        const v = form[c.key];
        if (c.type === 'multiselect') payload[c.key] = Array.isArray(v) ? v : [];
        else if (c.type === 'number') payload[c.key] = v === '' || v == null ? undefined : Number(v);
        else payload[c.key] = v === '' ? undefined : v;
      }
      if (modal?.mode === 'create') await api.create(payload);
      else if (modal?.row) await api.update(String(modal.row.id), payload);
      setModal(null);
      await load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSubmitting(false);
    }
  }

  async function remove(row: Record<string, unknown>) {
    if (!confirm(`确认删除「${str(row[columns[0]?.key ?? 'id'])}」？此操作不可撤销。`)) return;
    try {
      await api.archive(String(row.id));
      await load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '删除失败');
    }
  }

  async function doTransition(row: Record<string, unknown>, to: string) {
    if (!api.transition) return;
    try {
      await api.transition(String(row.id), to);
      setTxMenu(null);
      await load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '状态变更失败');
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">{title}</h1>
          {subtitle && <p className="page-subtitle">{subtitle}</p>}
        </div>
        <button className="btn btn-primary" onClick={openCreate} disabled={loading}>+ 新建</button>
      </div>

      {filterCols.length > 0 && (
        <div className="filter-bar">
          {filterCols.map((c) => (
            <FilterSelect key={c.key} label={c.label} value={filters[c.key] ?? ''}
              onChange={(v) => setFilters((f) => ({ ...f, [c.key]: v }))} options={c.filterOptions ?? c.options ?? []} />
          ))}
          <button className="btn btn-ghost btn-sm" onClick={() => setFilters({})}>重置</button>
        </div>
      )}

      {error && <p className="msg-error">{error}</p>}

      <div className="data-table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              {columns.map((c) => <th key={c.key} style={c.width ? { width: c.width } : undefined}>{c.label}</th>)}
              <th style={{ width: '150px' }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {items.map((row) => {
              const st = statusField ? str(row[statusField]) : '';
              const allowed = transitions && st ? transitions[st] ?? [] : [];
              return (
                <tr key={String(row.id)}>
                  {columns.map((c) => (
                    <td key={c.key}>
                      {statusField === c.key && st
                        ? <span className={`status-dot ${statusClass ? statusClass(st) : ''}`}>{st}</span>
                        : (c.render ? c.render(row[c.key], row) : str(row[c.key]))}
                    </td>
                  ))}
                  <td>
                    <div style={rowActions}>
                      <button className="btn btn-ghost btn-sm" onClick={() => openEdit(row)}>编辑</button>
                      {api.transition && allowed.length > 0 && (
                        <div style={{ position: 'relative' }}>
                          <button className="btn btn-ghost btn-sm" onClick={() => setTxMenu(txMenu === String(row.id) ? null : String(row.id))}>状态▾</button>
                          {txMenu === String(row.id) && (
                            <div style={{ position: 'absolute', top: '110%', right: 0, zIndex: 20, background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 10, padding: 6, minWidth: 120, boxShadow: '0 10px 30px rgba(0,0,0,0.35)' }}>
                              {allowed.map((to) => (
                                <div key={to} onClick={() => doTransition(row, to)}
                                  style={{ padding: '7px 10px', borderRadius: 7, cursor: 'pointer', fontSize: 'var(--font-sm)' }}
                                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-hover)')}
                                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>{to}</div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                      <button className="btn btn-danger btn-sm" onClick={() => remove(row)}>删除</button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {items.length === 0 && !loading && (
              <tr><td colSpan={columns.length + 1}>
                <div className="empty-state"><div className="empty-state-text">暂无数据</div></div>
              </td></tr>
            )}
          </tbody>
        </table>
        {loading && <div className="empty-state"><div className="empty-state-text">加载中…</div></div>}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 'var(--space-md)' }}>
        <span style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-tertiary)' }}>共 {total} 条</span>
        {hasMore && <button className="btn btn-outline btn-sm" onClick={() => load(pageToken, true)} disabled={loading}>加载更多</button>}
      </div>

      {modal && (
        <div style={overlayStyle} onClick={() => setModal(null)}>
          <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 22px', borderBottom: '1px solid var(--border)' }}>
              <h3 style={{ margin: 0, fontSize: 'var(--font-lg)', fontWeight: 700 }}>{modal.mode === 'create' ? `新建${title}` : `编辑${title}`}</h3>
              <button className="btn btn-ghost btn-sm" onClick={() => setModal(null)}>×</button>
            </div>
            <div style={{ padding: '20px 22px', maxHeight: '64vh', overflowY: 'auto' }}>
              {error && <p className="msg-error">{error}</p>}
              <fieldset className="form-fieldset">
                <legend className="form-legend">{title}信息</legend>
                <div className="form-grid">
                  {formCols.map((c) => (
                    <div key={c.key} className="form-label" style={c.type === 'textarea' ? { gridColumn: '1 / -1' } : undefined}>
                      <span className="form-label-text">{c.label}{c.required && <span style={{ color: 'var(--danger)' }}> *</span>}</span>
                      {c.type === 'textarea' ? (
                        <textarea className="form-input" value={str(form[c.key])} onChange={(e) => setForm((f) => ({ ...f, [c.key]: e.target.value }))} rows={3} />
                      ) : c.type === 'select' ? (
                        <select className="form-input" value={str(form[c.key])} onChange={(e) => setForm((f) => ({ ...f, [c.key]: e.target.value }))}>
                          <option value="">（未填）</option>
                          {(c.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
                        </select>
                      ) : c.type === 'multiselect' ? (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                          {(c.options ?? []).map((o) => {
                            const arr = Array.isArray(form[c.key]) ? (form[c.key] as string[]) : [];
                            const on = arr.includes(o);
                            return (
                              <label key={o} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderRadius: 999, border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`, background: on ? 'var(--accent-soft)' : 'transparent', fontSize: 'var(--font-sm)', cursor: 'pointer' }}>
                                <input type="checkbox" checked={on} onChange={(e) => setForm((f) => ({ ...f, [c.key]: e.target.checked ? [...arr, o] : arr.filter((x) => x !== o) }))} />
                                {o}
                              </label>
                            );
                          })}
                        </div>
                      ) : c.type === 'number' ? (
                        <input className="form-input" type="number" value={str(form[c.key])} onChange={(e) => setForm((f) => ({ ...f, [c.key]: e.target.value }))} />
                      ) : c.type === 'date' ? (
                        <input className="form-input" type="date" value={str(form[c.key])} onChange={(e) => setForm((f) => ({ ...f, [c.key]: e.target.value }))} />
                      ) : (
                        <input className="form-input" type="text" value={str(form[c.key])} onChange={(e) => setForm((f) => ({ ...f, [c.key]: e.target.value }))} />
                      )}
                    </div>
                  ))}
                </div>
              </fieldset>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, padding: '16px 22px', borderTop: '1px solid var(--border)' }}>
              <button className="btn btn-ghost" onClick={() => setModal(null)}>取消</button>
              <button className="btn btn-primary" onClick={submit} disabled={submitting}>{submitting ? '保存中…' : '保存'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
