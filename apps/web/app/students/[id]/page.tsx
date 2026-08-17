'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, type StudentRecord } from '../../../lib/api';
import { StudentForm } from '../../../components/StudentForm';

/** 从学生记录中提取照片 file_token 列表 */
function extractPhotos(rec: Record<string, unknown>): string[] {
  const v = rec['学生照片'];
  if (!v) return [];
  if (Array.isArray(v)) return v.map((item: any) => item.file_token ?? item).filter(Boolean);
  if (typeof v === 'object' && (v as any).file_token) return [(v as any).file_token];
  return [];
}

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

  if (loading) return <div className="empty-state" style={{ minHeight: '50vh' }}><div style={{ width: 28, height: 28, border: '3px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} /></div>;
  if (error) return <div className="page-header"><p className="msg-error">加载失败：{error}</p></div>;
  if (!student) return <div className="page-header"><p style={{ color: 'var(--fg-tertiary)' }}>未找到</p></div>;

  const name = String(student['学生姓名'] ?? '—');
  const code = String(student['学生编号'] ?? '');
  const photos = extractPhotos(student);

  return (
    <div>
      {/* ── Header with Photo ───────────────── */}
      <div className="page-header">
        <div className="page-header-row">
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-lg)' }}>
            <Link href="/students" className="btn btn-icon" title="返回列表">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18"><path d="m15 18-6-6 6-6"/></svg>
            </Link>
            {/* 照片（详情页大图） */}
            {photos.length > 0 ? (
              <img
                src={`https://open.feishu.cn/open-apis/drive/v1/medias/${photos[0]}/download`}
                alt={name}
                className="detail-photo"
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
              />
            ) : null}
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
    </div>
  );
}
