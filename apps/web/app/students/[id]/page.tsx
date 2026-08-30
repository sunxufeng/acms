'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, type StudentRecord } from '../../../lib/api';
import { StudentForm } from '../../../components/StudentForm';

export default function StudentDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = String(params.id);
  const [student, setStudent] = useState<StudentRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true); setError('');
    api
      .getStudent(id)
      .then((data) => setStudent(data))
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [id]);

  // 该生相关邮件（按归档表「关联学生」关联字段过滤）
  const [mails, setMails] = useState<Record<string, unknown>[]>([]);
  const [mailsLoading, setMailsLoading] = useState(true);
  useEffect(() => {
    setMailsLoading(true);
    api
      .listMailArchive({ '关联学生': id })
      .then((d) => setMails(d.items))
      .catch(() => setMails([]))
      .finally(() => setMailsLoading(false));
  }, [id]);

  if (loading) return <div className="empty-state" style={{ minHeight: '50vh' }}><div style={{ width: 28, height: 28, border: '3px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} /></div>;
  if (error) return <div className="page-header"><p className="msg-error">加载失败：{error}</p></div>;
  if (!student) return <div className="page-header"><p style={{ color: 'var(--fg-tertiary)' }}>未找到</p></div>;

  const name = String(student['学生姓名'] ?? '—');
  const code = String(student['学生编号'] ?? '');

  return (
    <div>
      {/* ── Header ───────────────── */}
      <div className="page-header">
        <div className="page-header-row">
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-lg)' }}>
            <Link href="/students" className="btn btn-icon" title="返回列表">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18"><path d="m15 18-6-6 6-6"/></svg>
            </Link>
            <div>
              <div className="page-eyebrow">STUDENT / {code || id.slice(0, 6)}</div>
              <h1 className="page-title">学生档案 · {name}</h1>
              <p className="page-subtitle">{code ? `编号：${code}` : ''}</p>
            </div>
          </div>
          <div className="page-actions">
            <button className="btn btn-primary btn-sm" onClick={() => router.push(`/students/${id}/edit`)}>编辑</button>
          </div>
        </div>
      </div>

      {/* ── Read-only form (same layout as 新建) ── */}
      <StudentForm initial={student} readOnly onSubmit={() => {}} />

      {/* ── 相关邮件 ── */}
      <section style={{ marginTop: 24 }}>
        <h2 style={{ fontSize: 16, margin: '0 0 12px' }}>相关邮件</h2>
        {mailsLoading ? (
          <p style={{ color: 'var(--fg-tertiary)' }}>加载中…</p>
        ) : mails.length === 0 ? (
          <p style={{ color: 'var(--fg-tertiary)' }}>暂无关联邮件</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {mails.map((m) => (
              <Link
                key={String(m.id)}
                href={`/mail-archive/${String(m.id)}`}
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--fg)', textDecoration: 'none' }}
              >
                <span className="badge" style={{ background: String(m['邮件方向']) === '发件' ? 'var(--success-muted)' : 'var(--accent-muted)', color: String(m['邮件方向']) === '发件' ? 'var(--success)' : 'var(--accent)' }}>
                  {String(m['邮件方向'] ?? '—')}
                </span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{String(m['主题'] ?? '(无主题)')}</span>
                <span style={{ color: 'var(--fg-tertiary)', fontSize: 12, flexShrink: 0 }}>{String(m['发送时间'] ?? '')}</span>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
