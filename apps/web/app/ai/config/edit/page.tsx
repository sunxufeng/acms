'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '../../../../lib/api';
import { ApiConfigForm, type ApiConfig } from '../ApiConfigForm';

export default function EditApiConfigPage() {
  const router = useRouter();
  const [config, setConfig] = useState<ApiConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api.aiGetConfig()
      .then((data) => {
        if (!data) throw new Error('未找到个人 API 配置');
        setConfig(data as ApiConfig);
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="empty-state" style={{ minHeight: '50vh' }}>加载中…</div>;
  if (error || !config) {
    return <div className="page-header"><p className="msg-error">加载失败：{error || '未找到'}</p><Link href="/ai/config" className="btn btn-outline btn-sm" style={{ marginTop: 12 }}>返回列表</Link></div>;
  }

  return (
    <div className="page">
      <div className="page-header page-header-row">
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-md)' }}>
          <Link href="/ai/config" className="btn btn-icon" title="返回列表">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18"><path d="m15 18-6-6 6-6" /></svg>
          </Link>
          <div>
            <div className="page-eyebrow">EDIT / API 设置</div>
            <h1 className="page-title">编辑 API 配置</h1>
          </div>
        </div>
      </div>
      <ApiConfigForm initial={config} onDone={() => router.push('/ai/config')} />
    </div>
  );
}
