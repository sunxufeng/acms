'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '../../../lib/api';
import { type ApiConfig } from './ApiConfigForm';

export default function AiConfigPage() {
  const [config, setConfig] = useState<ApiConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

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

  return (
    <div>
      <div className="page-header">
        <div className="page-header-row">
          <div>
            <div className="page-eyebrow">AI / PERSONAL API</div>
            <h1 className="page-title">Provider 设置</h1>
            <p className="page-subtitle">每个人独立维护自己的 Provider、API Key 和模型，不共享密钥。</p>
          </div>
          <div className="page-actions">
            <Link href={config ? '/ai/config/edit' : '/ai/config/new'} className="btn btn-primary">
              新建
            </Link>
          </div>
        </div>
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
              {!config ? (
                <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--fg-tertiary)' }}>暂无个人 API 配置</td></tr>
              ) : (
                <tr>
                  <td>{config.provider || '—'}</td>
                  <td>{config.model || '—'}</td>
                  <td style={{ maxWidth: 320, overflowWrap: 'anywhere' }}>{config.baseUrl || '—'}</td>
                  <td><span className={`status-dot ${config.hasApiKey ? 'status-on' : 'status-off'}`}>{config.hasApiKey ? '已保存' : '未配置'}</span></td>
                  <td>{config.updatedAt ? new Date(config.updatedAt).toLocaleString('zh-CN', { hour12: false }) : '—'}</td>
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
