'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api } from '../../../lib/api';
import { type ApiConfig } from './ApiConfigForm';

function FilterSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: string[] }) {
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

export default function AiConfigPage() {
  const [config, setConfig] = useState<ApiConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [keyFilter, setKeyFilter] = useState('');

  useEffect(() => {
    api.aiGetConfig()
      .then((data) => setConfig(data as ApiConfig | null))
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, []);

  async function remove() {
    if (!confirm('确认删除你的个人 API 配置和已保存密钥？')) return;
    try {
      await api.aiDeleteConfig();
      setConfig(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const visible = !config ? null : (() => {
    if (q) {
      const hay = [config.provider || '', config.model || '', config.baseUrl || ''].join(' ').toLowerCase();
      if (!hay.includes(q.toLowerCase().trim())) return null;
    }
    if (keyFilter === '已配置' && !config.hasApiKey) return null;
    if (keyFilter === '未配置' && config.hasApiKey) return null;
    return config;
  })();

  return (
    <div className="page">
      <div className="page-header page-header-row">
        <div>
          <div className="page-eyebrow">AI / PERSONAL API</div>
          <h1 className="page-title">Provider 设置</h1>
          <p className="page-subtitle">每个人独立维护自己的 Provider、API Key 和模型，不共享密钥。</p>
        </div>
        <div className="page-actions">
          <Link href="/ai/config/new" className="btn btn-primary">
            新建
          </Link>
        </div>
      </div>

      <div className="filter-bar">
        <form className="search-bar" style={{ flex: 1, minWidth: 200, maxWidth: 360 }} onSubmit={(e) => e.preventDefault()}>
          <svg className="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" /></svg>
          <input placeholder="搜索 Provider 名称 / 模型 / Base URL" value={q} onChange={(e) => setQ(e.target.value)} />
          <button type="submit">查询</button>
        </form>
        <FilterSelect label="API Key 状态" value={keyFilter} onChange={setKeyFilter} options={['已配置', '未配置']} />
        {(q || keyFilter) && <button className="btn btn-ghost btn-sm" onClick={() => { setQ(''); setKeyFilter(''); }}>重置</button>}
      </div>

      {error && <p className="msg-error" style={{ marginBottom: 16 }}>{error}</p>}

      {loading ? (
        <div className="empty-state">加载中…</div>
      ) : (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Provider 描述</th>
                <th>模型</th>
                <th>Base URL</th>
                <th>API Key</th>
                <th>更新时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {!visible ? (
                <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--fg-tertiary)' }}>
                  {!config ? '暂无个人 API 配置' : '没有匹配的配置'}
                </td></tr>
              ) : (
                <tr>
                  <td>{visible.provider || '—'}</td>
                  <td>{visible.model || '—'}</td>
                  <td style={{ maxWidth: 320, overflowWrap: 'anywhere' }}>{visible.baseUrl || '—'}</td>
                  <td><span className={`status-dot ${visible.hasApiKey ? 'status-on' : 'status-off'}`}>{visible.hasApiKey ? '已保存' : '未配置'}</span></td>
                  <td>{visible.updatedAt ? new Date(visible.updatedAt).toLocaleString('zh-CN', { hour12: false }) : '—'}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <Link href="/ai/config/edit" className="btn btn-outline btn-sm">编辑</Link>
                      <button className="btn btn-danger btn-sm" onClick={remove}>删除</button>
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
