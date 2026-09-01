'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { api } from '../../../lib/api';
import { ApiConfigForm, type ApiConfig } from './ApiConfigForm';

function FilterSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: string[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const t = useTranslations();
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
          <div className={`filter-select-opt${!value ? ' active' : ''}`} onClick={() => { onChange(''); setOpen(false); }}>{t('crud.all')}</div>
          {options.map((o) => (
            <div key={o} className={`filter-select-opt${o === value ? ' active' : ''}`} onClick={() => { onChange(o); setOpen(false); }}>{o}</div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function AiConfigPage() {
  const t = useTranslations('ai.config');
  const tc = useTranslations('common');
  const [config, setConfig] = useState<ApiConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [keyFilter, setKeyFilter] = useState('');

  // 新建/编辑改为页内独立表单（URL 保持不变），与全站统一的 standaloneForm 交互一致
  const [editing, setEditing] = useState<'create' | 'edit' | null>(null);

  const reload = useCallback(() => {
    setLoading(true);
    api.aiGetConfig()
      .then((data) => {
        setConfig(data as ApiConfig | null);
        setError('');
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { reload(); }, [reload]);

  async function remove() {
    if (!confirm(t('deleteConfirm'))) return;
    try {
      await api.aiDeleteConfig();
      setConfig(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  /** 关闭表单（返回箭头：未做改动，无需重新拉取） */
  function closeForm() {
    setEditing(null);
  }

  /** 表单保存/取消后回调：关闭并刷新 */
  function handleDone() {
    closeForm();
    reload();
  }

  const visible = !config ? null : (() => {
    if (q) {
      const hay = [config.provider || '', config.model || '', config.baseUrl || ''].join(' ').toLowerCase();
      if (!hay.includes(q.toLowerCase().trim())) return null;
    }
    if (keyFilter === t('statusConfigured') && !config.hasApiKey) return null;
    if (keyFilter === t('statusNotConfigured') && config.hasApiKey) return null;
    return config;
  })();

  if (editing) {
    const isEdit = editing === 'edit';
    return (
      <div className="page">
        <div className="crud-inline-form" style={{ maxWidth: 920, margin: '0 auto' }}>
          <div className="crud-inline-form-head">
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-md)' }}>
              <button className="btn btn-icon" title={t('backToList')} aria-label={t('backToList')} onClick={closeForm}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18"><path d="m15 18-6-6 6-6" /></svg>
              </button>
              <div>
                <div className="page-eyebrow">{isEdit ? t('eyebrowEdit') : t('eyebrowCreate')}</div>
                <h1 className="page-title">{isEdit ? t('edit') : t('create')}</h1>
              </div>
            </div>
          </div>
          <ApiConfigForm initial={isEdit ? config : null} onDone={handleDone} />
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header page-header-row">
          <div>
            <div className="page-eyebrow">AI / PERSONAL API</div>
            <h1 className="page-title">{t('pageTitle')}</h1>
            <p className="page-subtitle">{t('pageSubtitle')}</p>
          </div>
          <div className="page-actions">
            <button className="btn btn-primary" onClick={() => setEditing('create')}>
              {t('newBtn')}
            </button>
          </div>
        </div>

        <div className="filter-bar">
          <form className="search-bar" style={{ flex: 1, minWidth: 200, maxWidth: 360 }} onSubmit={(e) => e.preventDefault()}>
            <svg className="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" /></svg>
            <input placeholder={t('searchPlaceholder')} value={q} onChange={(e) => setQ(e.target.value)} />
            <button type="submit">{t('searchBtn')}</button>
          </form>
          <FilterSelect label={t('apiKeyStatus')} value={keyFilter} onChange={setKeyFilter} options={[t('statusConfigured'), t('statusNotConfigured')]} />
          {(q || keyFilter) && <button className="btn btn-ghost btn-sm" onClick={() => { setQ(''); setKeyFilter(''); }}>{t('reset')}</button>}
        </div>

        {error && <p className="msg-error" style={{ marginBottom: 16 }}>{error}</p>}

        {loading ? (
          <div className="empty-state">{tc('loading')}</div>
        ) : (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('colProvider')}</th>
                  <th>{t('colModel')}</th>
                  <th>{t('colBaseUrl')}</th>
                  <th>{t('colApiKey')}</th>
                  <th>{t('colUpdated')}</th>
                  <th>{tc('actions')}</th>
                </tr>
              </thead>
              <tbody>
                {!visible ? (
                  <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--fg-tertiary)' }}>
                    {!config ? t('noConfig') : t('noMatch')}
                  </td></tr>
                ) : (
                  <tr>
                    <td>{visible.provider || '—'}</td>
                    <td>{visible.model || '—'}</td>
                    <td style={{ maxWidth: 320, overflowWrap: 'anywhere' }}>{visible.baseUrl || '—'}</td>
                    <td><span className={`status-dot ${visible.hasApiKey ? 'status-on' : 'status-off'}`}>{visible.hasApiKey ? t('saved') : t('notConfigured')}</span></td>
                    <td>{visible.updatedAt ? new Date(visible.updatedAt).toLocaleString('zh-CN', { hour12: false }) : '—'}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button className="btn btn-outline btn-sm" onClick={() => setEditing('edit')}>{t('editBtn')}</button>
                        <button className="btn btn-danger btn-sm" onClick={remove}>{t('deleteBtn')}</button>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
    </div>
  );
}
