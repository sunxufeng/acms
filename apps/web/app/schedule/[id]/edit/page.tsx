'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { api } from '../../../../lib/api';
import { SessionForm } from '../../../../components/SessionForm';

export default function EditSessionPage() {
  const params = useParams();
  const id = String(params.id);
  const router = useRouter();
  const t = useTranslations('academic');
  const tc = useTranslations('common');

  const [session, setSession] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  useEffect(() => {
    api
      .getSession(id)
      .then((data) => setSession(data))
      .catch(() => setError(tc('loadFailed')))
      .finally(() => setLoading(false));
  }, [id, tc]);

  const handleSubmit = () => {
    router.push('/schedule');
  };

  if (loading) {
    return (
      <div className="empty-state" style={{ minHeight: '50vh' }}>
        <div style={{ width: 28, height: 28, border: '3px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
      </div>
    );
  }
  if (error || !session) {
    return (
      <div className="page-header">
        <p className="msg-error">{error || t('notFound')}</p>
        <Link href="/schedule" className="btn btn-outline btn-sm" style={{ marginTop: 12 }}>{tc('back')}</Link>
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <div className="page-header-row">
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-md)' }}>
            <Link href="/schedule" className="btn btn-icon" title={tc('back')} aria-label={tc('back')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18"><path d="m15 18-6-6 6-6" /></svg>
            </Link>
            <div>
              <div className="page-eyebrow">EDIT / {t('lblSession')}</div>
              <h1 className="page-title">{t('titleEditSession')}</h1>
            </div>
          </div>
        </div>
      </div>

      {msg && <p className="msg-error">{msg}</p>}

      <SessionForm initial={session} onSubmit={handleSubmit} />
    </div>
  );
}
