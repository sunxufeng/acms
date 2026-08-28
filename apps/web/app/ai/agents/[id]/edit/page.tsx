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

  if (loading) return <div className="page"><div className="empty-state" style={{ minHeight: '50vh' }}>加载中…</div></div>;
  if (error || !agent) return (
    <div className="page">
      <p className="msg-error">加载失败：{error || '未找到'}</p>
      <Link href="/ai/agents" className="btn btn-outline btn-sm" style={{ marginTop: 12 }}>返回列表</Link>
    </div>
  );

  return (
    <AgentForm initial={agent} onDone={() => router.push('/ai/agents')} />
  );
}
