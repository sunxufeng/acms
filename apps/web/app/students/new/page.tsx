'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '../../../lib/api';
import { StudentForm } from '../../../components/StudentForm';

export default function NewStudentPage() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState('');

  const handleSubmit = async (data: Record<string, unknown>) => {
    setSubmitting(true);
    setMsg('');
    try {
      const created = await api.createStudent(data);
      router.push(`/students/${created.id}`);
    } catch (e) {
      setMsg('创建失败：' + (e as Error).message);
      setSubmitting(false);
    }
  };

  return (
    <main style={wrap}>
      <header style={header}>
        <a href="/students" style={link}>← 返回列表</a>
        <h1 style={h1}>新增学生</h1>
      </header>
      {msg && <p style={msgStyle}>{msg}</p>}
      <StudentForm onSubmit={handleSubmit} submitting={submitting} />
    </main>
  );
}

const wrap: React.CSSProperties = { maxWidth: 1000, margin: '0 auto', padding: '32px 24px' };
const header: React.CSSProperties = { marginBottom: 24 };
const link: React.CSSProperties = { color: 'var(--brand)', textDecoration: 'none', fontSize: 14 };
const h1: React.CSSProperties = { fontSize: 22, fontWeight: 700, marginTop: 8 };
const msgStyle: React.CSSProperties = { color: '#dc2626', marginBottom: 12 };
