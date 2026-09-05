'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { api } from '../../../lib/api';
import { buildStageColumns } from '../columns';
import CrudView from '../../../components/CrudView';
import { NotePanel, linkText } from '../../../components/NotePanel';

export default function StageEvaluationDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = String(params.id);
  const t = useTranslations('academic');
  const tc = useTranslations('common');
  const COLUMNS = buildStageColumns(t);
  const [record, setRecord] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true); setError('');
    api
      .getStageEvaluation(id)
      .then((data) => setRecord(data))
      .catch(() => setError(tc('loadFailed')))
      .finally(() => setLoading(false));
  }, [id, tc]);

  if (loading) return <div className="empty-state" style={{ minHeight: '50vh' }}><div style={{ width: 28, height: 28, border: '3px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} /></div>;
  if (error) return <div className="page-header"><p className="msg-error">{error}</p></div>;
  if (!record) return <div className="page-header"><p style={{ color: 'var(--fg-tertiary)' }}>{t('notFound')}</p></div>;

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
            <Link href="/stage-evaluations" className="btn btn-icon" title={tc('back')} aria-label={tc('back')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18"><path d="m15 18-6-6 6-6" /></svg>
            </Link>
            <div>
              <div className="page-eyebrow">STAGE-EVALUATION / {String(record['评价日期'] ?? id.slice(0, 6))}</div>
              <h1 className="page-title">{t('titleStageDetail', { name: studentName })}</h1>
              <p className="page-subtitle">{t('subtitleViewOnly')}</p>
            </div>
          </div>
          <div className="page-actions">
            <button className="btn btn-outline btn-sm" onClick={() => router.push('/stage-evaluations')}>{tc('back')}</button>
          </div>
        </div>
      </div>

      {/* ── Read-only fields ──────── */}
      <CrudView columns={COLUMNS} record={record} />

      {/* ── 关联笔记（得到大脑） ─────────── */}
      <NotePanel entityType="阶段评价" entityId={id} entityName={linkText(record['关联学生编号'])} />
    </div>
  );
}
