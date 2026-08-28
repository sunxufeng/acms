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
        <div>
          <div className="page-eyebrow">EDIT / API 设置</div>
          <h1 className="page-title">编辑 API 配置</h1>
        </div>
        <div className="page-actions">
          <Link href="/ai/config" className="btn btn-ghost">取消</Link>
          <button type="submit" form="api-config-form" className="btn btn-primary">保存</button>
        </div>
      </div>
      <ApiConfigForm initial={config} onDone={() => router.push('/ai/config')} />
    </div>
  );
}
