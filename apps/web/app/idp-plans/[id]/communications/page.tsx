'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';
import CommunicationManager from '../../../../components/idp/CommunicationManager';
import { useTl } from '../../../../lib/useTl';

export default function CommunicationsListPage() {
  const tl = useTl();
  const params = useParams<{ id: string }>();
  const planId = params.id;

  return (
    <div className="page">
      <div className="page-header page-header-row">
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-lg)' }}>
          <Link href={`/idp-plans/${planId}`} className="btn btn-icon" title="返回方案">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18"><path d="m15 18-6-6 6-6" /></svg>
          </Link>
          <div>
            <div className="page-eyebrow">IDP / COMMUNICATION</div>
            <h1 className="page-title">{tl('沟通记录')}</h1>
          </div>
        </div>
      </div>

      <section style={{ border: '1px solid var(--border)', background: 'var(--bg-elevated)', borderRadius: 12, padding: 18 }}>
        <CommunicationManager planId={planId} />
      </section>
    </div>
  );
}
