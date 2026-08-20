'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { api } from '../../../../../lib/api';
import { AutomationForm, type Auto } from '../../AutomationForm';

export default function EditAutomationPage() {
  const params = useParams();
  const id = String(params.id);
  const router = useRouter();

  const [initial, setInitial] = useState<Partial<Auto> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .aiGetAutomation(id)
      .then((data) => setInitial(data as Partial<Auto>))
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return (
      <div className="empty-state" style={{ minHeight: '50vh' }}>
        <div style={{ width: 28, height: 28, border: '3px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
      </div>
    );
  }
  if (error || !initial) {
    return (
      <div className="page-header">
        <p className="msg-error">加载失败：{error || '未找到'}</p>
        <Link href="/ai/automations" className="btn btn-outline btn-sm" style={{ marginTop: 12 }}>返回列表</Link>
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <div className="page-header-row">
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-md)' }}>
            <Link href="/ai/automations" className="btn btn-icon" title="返回列表">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18"><path d="m15 18-6-6 6-6"/></svg>
            </Link>
            <div>
              <div className="page-eyebrow">EDIT / 自动化任务</div>
              <h1 className="page-title">编辑自动化任务</h1>
            </div>
          </div>
        </div>
      </div>

      <AutomationForm initial={initial} onDone={() => router.push('/ai/automations')} />
    </div>
  );
}
