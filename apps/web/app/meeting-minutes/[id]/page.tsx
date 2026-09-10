'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { api } from '../../../lib/api';
import { COLUMNS, deptName } from '../columns';
import CrudView from '../../../components/CrudView';
import { useTranslations } from 'next-intl';
import { NotePanel, linkText } from '../../../components/NotePanel';

export default function MeetingMinuteDetailPage() {
  const t = useTranslations('common');
  const ts = useTranslations('students');
  const params = useParams();
  const router = useRouter();
  const id = String(params.id);
  const [record, setRecord] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true); setError('');
    api
      .getMeetingMinute(id)
      .then((data) => setRecord(data))
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) return <div className="empty-state" style={{ minHeight: '50vh' }}><div style={{ width: 28, height: 28, border: '3px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} /></div>;
  if (error) return <div className="page-header"><p className="msg-error">加载失败：{error}</p></div>;
  if (!record) return <div className="page-header"><p style={{ color: 'var(--fg-tertiary)' }}>{ts('notFound')}</p></div>;

  return (
    <div>
      {/* ── Header ───────────────── */}
      <div className="page-header">
        <div className="page-header-row">
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-lg)' }}>
            <Link href="/meeting-minutes" className="btn btn-icon" title="返回列表">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18"><path d="m15 18-6-6 6-6" /></svg>
            </Link>
            <div>
              <div className="page-eyebrow">MEETING-MINUTES / {String(record['会议议题'] ?? id.slice(0, 6))}</div>
              <h1 className="page-title">会议纪要详情 · {deptName(record) || '—'}</h1>
              <p className="page-subtitle">{ts('subtitleViewOnly')}</p>
            </div>
          </div>
          <div className="page-actions">
            <button className="btn btn-outline btn-sm" onClick={() => router.push('/meeting-minutes')}>{t('backToList')}</button>
          </div>
        </div>
      </div>

      {/* ── Read-only fields ──────── */}
      <CrudView columns={COLUMNS} record={record} />

      {/* ── 关联笔记（得到大脑） ─────────── */}
      <NotePanel entityType="会议纪要" entityId={id} entityName={linkText(record['会议议题'])} />
    </div>
  );
}
