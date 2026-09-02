'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { api } from '../../../lib/api';
import { COLUMNS } from '../columns';
import CrudView from '../../../components/CrudView';
import { useTranslations } from 'next-intl';

export default function AlumniFollowupDetailPage() {
  const t = useTranslations('common');
  const ta = useTranslations('alumni');
  const params = useParams();
  const router = useRouter();
  const id = String(params.id);
  const [record, setRecord] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true); setError('');
    api
      .getAlumniFollowup(id)
      .then((data) => setRecord(data))
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) return <div className="empty-state" style={{ minHeight: '50vh' }}><div style={{ width: 28, height: 28, border: '3px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} /></div>;
  if (error) return <div className="page-header"><p className="msg-error">加载失败：{error}</p></div>;
  if (!record) return <div className="page-header"><p style={{ color: 'var(--fg-tertiary)' }}>{ta('notFound')}</p></div>;

  const studentName = (() => {
    const v = record['关联学生编号'];
    if (Array.isArray(v) && v.length) return String((v[0] as { text?: string })?.text ?? '');
    if (v && typeof v === 'object') return String((v as { text?: string })?.text ?? '');
    return String(v ?? '—');
  })();

  return (
    <div>
      {/* ── Header ───────────────── */}
      <div className="page-header">
        <div className="page-header-row">
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-lg)' }}>
            <Link href="/alumni-followups" className="btn btn-icon" title="返回列表">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18"><path d="m15 18-6-6 6-6" /></svg>
            </Link>
            <div>
              <div className="page-eyebrow">ALUMNI-FOLLOWUP / {String(record['跟进时间'] ?? id.slice(0, 6))}</div>
              <h1 className="page-title">校友跟进详情 · {studentName}</h1>
              <p className="page-subtitle">{ta('subtitleViewOnly')}</p>
            </div>
          </div>
          <div className="page-actions">
            <button className="btn btn-outline btn-sm" onClick={() => router.push('/alumni-followups')}>{t('backToList')}</button>
          </div>
        </div>
      </div>

      {/* ── Read-only fields ──────── */}
      <CrudView columns={COLUMNS} record={record} />
    </div>
  );
}
