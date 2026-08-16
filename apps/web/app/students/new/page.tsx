'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '../../../lib/api';
import { StudentForm } from '../../../components/StudentForm';

export default function NewStudentPage() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState('');

  const handleSubmit = async (data: Record<string, unknown>) => {
    setSubmitting(true); setMsg('');
    try {
      const created = await api.createStudent(data);
      router.push('/students');
    } catch (e) {
      setMsg('创建失败：' + (e as Error).message);
      setSubmitting(false);
    }
  };

  return (
    <div>
      <div className="page-header">
        <div className="page-header-row">
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-md)' }}>
            <Link href="/students" className="btn btn-icon" title="返回列表">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18"><path d="m15 18-6-6 6-6"/></svg>
            </Link>
            <div>
              <div className="page-eyebrow">STUDENT / NEW</div>
              <h1 className="page-title">新建学生档案</h1>
            </div>
          </div>
        </div>
      </div>

      {msg && <p className="msg-error">{msg}</p>}

      <StudentForm onSubmit={handleSubmit} submitting={submitting} />
    </div>
  );
}
