'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { SessionForm } from '../../../components/SessionForm';

export default function NewSessionPage() {
  const t = useTranslations('academic');
  const tc = useTranslations('common');
  const [msg, setMsg] = useState('');

  const handleSubmit = () => {
    setMsg(t('msgSessionCreated'));
  };

  return (
    <div>
      <div className="page-header">
        <div className="page-header-row">
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-md)' }}>
            <Link href="/schedule" className="btn btn-icon" title={tc('back')} aria-label={tc('back')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18"><path d="m15 18-6-6 6-6" /></svg>
            </Link>
            <div>
              <div className="page-eyebrow">CREATE / {t('lblSession')}</div>
              <h1 className="page-title">{t('titleNewSession')}</h1>
            </div>
          </div>
        </div>
      </div>

      {msg && <p className="msg-success">{msg}</p>}

      <SessionForm onSubmit={handleSubmit} />
    </div>
  );
}
