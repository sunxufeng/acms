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
      <div className="page">
        <p className="msg-error">加载失败：{error || '未找到'}</p>
        <Link href="/ai/automations" className="btn btn-outline btn-sm" style={{ marginTop: 12 }}>返回列表</Link>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header page-header-row">
        <div>
          <div className="page-eyebrow">EDIT / 自动化任务</div>
          <h1 className="page-title">编辑自动化任务</h1>
        </div>
        <div className="page-actions">
          <Link href="/ai/automations" className="btn btn-ghost">取消</Link>
          <button type="submit" form="automation-form" className="btn btn-primary">保存</button>
        </div>
      </div>

      <AutomationForm initial={initial} onDone={() => router.push('/ai/automations')} />
    </div>
  );
}
