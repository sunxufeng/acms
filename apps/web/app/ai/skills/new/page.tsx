'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { SkillForm } from '../SkillForm';

export default function NewSkillPage() {
  const router = useRouter();
  const t = useTranslations('ai.skills');
  return <div><div className="page-header"><div className="page-header-row"><div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-md)' }}><Link href="/ai/skills" className="btn btn-icon" title={t('backToList')}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18"><path d="m15 18-6-6 6-6" /></svg></Link><div><div className="page-eyebrow">{t('eyebrowCreate')}</div><h1 className="page-title">{t('create')}</h1></div></div></div></div><SkillForm onDone={() => router.push('/ai/skills')} /></div>;
}
