'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { api, type StudentRecord } from '../../../../lib/api';
import { StudentForm } from '../../../../components/StudentForm';

export default function EditStudentPage() {
  const params = useParams();
  const id = String(params.id);
  const router = useRouter();

  const [student, setStudent] = useState<StudentRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  useEffect(() => {
    api
      .getStudent(id)
      .then((data) => setStudent(data))
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [id]);

  // 表单内部已负责保存；保存成功后跳回列表
  const handleSubmit = () => {
    router.push('/students');
  };

  if (loading) {
    return (
      <div className="empty-state" style={{ minHeight: '50vh' }}>
        <div style={{ width: 28, height: 28, border: '3px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
      </div>
    );
  }
  if (error || !student) {
    return (
      <div className="page-header">
        <p className="msg-error">加载失败：{error || '未找到'}</p>
        <Link href="/students" className="btn btn-outline btn-sm" style={{ marginTop: 12 }}>返回列表</Link>
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <div className="page-header-row">
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-md)' }}>
            <Link href="/students" className="btn btn-icon" title="返回列表">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18"><path d="m15 18-6-6 6-6"/></svg>
            </Link>
            <div>
              <div className="page-eyebrow">EDIT / 学生档案</div>
              <h1 className="page-title">编辑学生档案</h1>
            </div>
          </div>
        </div>
      </div>

      {msg && <p className="msg-error">{msg}</p>}

      <StudentForm initial={student} onSubmit={handleSubmit} />
    </div>
  );
}
