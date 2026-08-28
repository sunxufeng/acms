'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { api } from '../../../../../lib/api';
import { SkillForm, type Skill } from '../../SkillForm';

export default function EditSkillPage() {
  const name = decodeURIComponent(String(useParams().name));
  const router = useRouter();
  const t = useTranslations('ai.skills');
  const [skill, setSkill] = useState<Skill | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([api.aiGetSkill(name), api.aiTools()]).then(([data, tools]) => {
      const tool = (tools as { name: string; description: string }[]).find((item) => item.name === name);
      setSkill(data ? data as Skill : { name, description: tool?.description || '' });
    }).catch((e) => setError((e as Error).message)).finally(() => setLoading(false));
  }, [name]);

  if (loading) return <div className="empty-state" style={{ minHeight: '50vh' }}>{t('errLoad')}</div>;
  if (error || !skill) return <div className="page-header"><p className="msg-error">{t('errLoad')}：{error || t('errNotFound')}</p><Link href="/ai/skills" className="btn btn-outline btn-sm" style={{ marginTop: 12 }}>{t('backToList')}</Link></div>;

  return <div><div className="page-header"><div className="page-header-row"><div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-md)' }}><Link href="/ai/skills" className="btn btn-icon" title={t('backToList')}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18"><path d="m15 18-6-6 6-6" /></svg></Link><div><div className="page-eyebrow">{t('eyebrowEdit')}</div><h1 className="page-title">{t('editTitle', { name })}</h1></div></div></div></div><SkillForm initial={skill} onDone={() => router.push('/ai/skills')} /></div>;
}
