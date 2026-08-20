'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { api } from '../../../../../lib/api';
import { AgentForm, type Agent } from '../../AgentForm';

export default function EditAgentPage() {
  const id = String(useParams().id);
  const router = useRouter();
  const [agent, setAgent] = useState<Agent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api.aiGetAgent(id).then((data) => {
      if (!data) throw new Error('未找到智能体');
      setAgent(data as Agent);
    }).catch((e) => setError((e as Error).message)).finally(() => setLoading(false));
  }, [id]);

  if (loading) return <div className="empty-state" style={{ minHeight: '50vh' }}>加载中…</div>;
  if (error || !agent) return <div className="page-header"><p className="msg-error">加载失败：{error || '未找到'}</p><Link href="/ai/agents" className="btn btn-outline btn-sm" style={{ marginTop: 12 }}>返回列表</Link></div>;

  return (
    <div>
      <div className="page-header"><div className="page-header-row"><div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-md)' }}><Link href="/ai/agents" className="btn btn-icon" title="返回列表"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18"><path d="m15 18-6-6 6-6" /></svg></Link><div><div className="page-eyebrow">EDIT / 智能体配置</div><h1 className="page-title">编辑智能体</h1></div></div></div></div>
      <AgentForm initial={agent} onDone={() => router.push('/ai/agents')} />
    </div>
  );
}
