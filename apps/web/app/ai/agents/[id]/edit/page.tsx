'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { api } from '../../../../../lib/api';
import { AgentForm, type Agent } from '../../AgentForm';

export default function EditAgentPage() {
  const id = String(useParams().id);
  const router = useRouter();
  const t = useTranslations('ai.agents');
  const [agent, setAgent] = useState<Agent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api.aiGetAgent(id).then((data) => {
      if (!data) throw new Error(t('errNotFound'));
      setAgent(data as Agent);
    }).catch((e) => setError((e as Error).message)).finally(() => setLoading(false));
  }, [id]);

  if (loading) return <div className="page"><div className="empty-state" style={{ minHeight: '50vh' }}>{t('errLoad')}</div></div>;
  if (error || !agent) return (
    <div className="page">
      <p className="msg-error">{t('errLoad')}：{error || t('errNotFound')}</p>
      <Link href="/ai/agents" className="btn btn-outline btn-sm" style={{ marginTop: 12 }}>{t('backToList')}</Link>
    </div>
  );

  return (
    <AgentForm initial={agent} onDone={() => router.push('/ai/agents')} />
  );
}
