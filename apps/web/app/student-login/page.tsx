'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { api } from '../../lib/api';
import MobileBindCard from '../../components/MobileBindCard';

export default function StudentLoginPage() {
  const router = useRouter();
  const t = useTranslations('bind');
  const [stage, setStage] = useState<'checking' | 'bind'>('checking');
  const [bindErr, setBindErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // 已是学生会话则直接进门户
    api
      .me()
      .then((me) => {
        if ((me?.roles ?? []).includes('student')) router.replace('/portal');
        else setStage('bind');
      })
      .catch(() => setStage('bind'));
  }, [router]);

  async function doBind(studentNo: string, name: string) {
    setBusy(true);
    setBindErr('');
    try {
      await api.studentLogin(studentNo, name);
      router.replace('/portal');
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      setBindErr(msg.includes('STUDENT_NOT_FOUND') ? t('notMatch') : msg || t('bindFailed'));
    } finally {
      setBusy(false);
    }
  }

  if (stage === 'checking') {
    return (
      <div className="mobile-page">
        <div className="card mobile-card mobile-card-offset">
          <p className="muted">{t('loading')}</p>
        </div>
      </div>
    );
  }

  return (
    <MobileBindCard
      title={t('studentLoginTitle')}
      description={t('studentLoginDesc')}
      submitLabel={t('login')}
      busyLabel={t('loggingIn')}
      busy={busy}
      error={bindErr}
      onSubmit={doBind}
    >
      <a href="/login" className="mobile-link">
        {t('staffLoginLink')}
      </a>
    </MobileBindCard>
  );
}
