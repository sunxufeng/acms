'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { api } from '../../../lib/api';
import { COLUMNS } from '../columns';
import CrudView from '../../../components/CrudView';
import { useTranslations } from 'next-intl';
import { NotePanel, linkText } from '../../../components/NotePanel';
import AiSummarizeModal from '../../home-school-comms/AiSummarizeModal';

export default function StudentObservationDetailPage() {
  const t = useTranslations('common');
  const ts = useTranslations('students');
  const params = useParams();
  const router = useRouter();
  const id = String(params.id);
  const [record, setRecord] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // AI 总结合并附件后会改写 观察明细/观察总结，reloadKey 自增即重新拉取
  const [reloadKey, setReloadKey] = useState(0);
  const [aiOpen, setAiOpen] = useState(false);

  useEffect(() => {
    setLoading(true); setError('');
    api
      .getStudentObservation(id)
      .then((data) => setRecord(data))
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [id, reloadKey]);

  if (loading) return <div className="empty-state" style={{ minHeight: '50vh' }}><div style={{ width: 28, height: 28, border: '3px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} /></div>;
  if (error) return <div className="page-header"><p className="msg-error">加载失败：{error}</p></div>;
  if (!record) return <div className="page-header"><p style={{ color: 'var(--fg-tertiary)' }}>{ts('notFound')}</p></div>;

  const studentName = (() => {
    const v = record['关联学生'];
    if (Array.isArray(v) && v.length) return String((v[0] as { text?: string })?.text ?? '');
    if (v && typeof v === 'object') return String((v as { text?: string }).text ?? '');
    return String(v ?? '—');
  })();

  return (
    <div>
      {/* ── Header ─────────── */}
      <div className="page-header">
        <div className="page-header-row">
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-lg)' }}>
            <Link href="/student-observations" className="btn btn-icon" title="返回列表">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18"><path d="m15 18-6-6 6-6" /></svg>
            </Link>
            <div>
              <div className="page-eyebrow">STUDENT-OBSERVATION / {String(record['沟通主题'] ?? id.slice(0, 6))}</div>
              <h1 className="page-title">学生观察详情 · {studentName}</h1>
              <p className="page-subtitle">{ts('subtitleViewOnly')}</p>
            </div>
          </div>
          <div className="page-actions">
            <button className="btn btn-outline btn-sm" onClick={() => setAiOpen(true)}>AI 总结</button>
            <button className="btn btn-outline btn-sm" onClick={() => router.push('/student-observations')}>{t('backToList')}</button>
          </div>
        </div>
      </div>

      {/* ── Read-only fields ──────── */}
      <CrudView columns={COLUMNS} record={record} />

      {/* ── 关联笔记（得到大脑） ─────────── */}
      <NotePanel entityType="学生观察" entityId={id} entityName={linkText(record['关联学生'])} />

      {/* ── AI 总结：把附件转成 Markdown 写入观察明细/观察总结 ─────────── */}
      {aiOpen && (
        <AiSummarizeModal
          recordId={id}
          recordName={`学生观察 · ${studentName}`}
          kind="student-observations"
          onClose={() => setAiOpen(false)}
          onSuccess={() => {
            setAiOpen(false);
            setReloadKey((k) => k + 1);
          }}
        />
      )}
    </div>
  );
}
