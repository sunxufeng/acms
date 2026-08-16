'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { api, type StudentRecord } from '../../../lib/api';
import { StudentForm } from '../../../components/StudentForm';

function str(v: unknown): string {
  if (v == null) return '—';
  if (Array.isArray(v)) return v.length ? v.map((x) => (typeof x === 'string' ? x : String((x as { text?: string })?.text ?? ''))).join('、') : '—';
  if (typeof v === 'object') return String((v as { text?: string })?.text ?? '—');
  return String(v);
}

export default function StudentDetailPage() {
  const params = useParams();
  const id = String(params.id);
  const [student, setStudent] = useState<StudentRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api.getStudent(id);
      setStudent(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const handleSave = async (data: Record<string, unknown>) => {
    setSubmitting(true);
    setMsg('');
    try {
      await api.updateStudent(id, data);
      setMsg('已保存');
      setEditing(false);
      load();
    } catch (e) {
      setMsg('保存失败：' + (e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleArchive = async () => {
    if (!confirm('确认归档该学生？')) return;
    await api.archiveStudent(id);
    load();
  };

  const handleRestore = async () => {
    await api.restoreStudent(id);
    load();
  };

  if (loading) return <main style={wrap}><p style={muted}>加载中…</p></main>;
  if (error) return <main style={wrap}><p style={err}>加载失败：{error}</p></main>;
  if (!student) return <main style={wrap}><p style={muted}>未找到</p></main>;

  return (
    <main style={wrap}>
      <header style={header}>
        <div>
          <a href="/students" style={link}>← 返回列表</a>
          <h1 style={h1}>{str(student.学生姓名)} <span style={sub}>#{str(student.学生编号)}</span></h1>
        </div>
        <div style={actions}>
          {!editing && (
            <>
              <button style={btnPrimary} onClick={() => setEditing(true)}>编辑</button>
              {str(student.当前状态) === '离校' ? (
                <button style={btnGhost} onClick={handleRestore}>恢复</button>
              ) : (
                <button style={btnDanger} onClick={handleArchive}>归档</button>
              )}
            </>
          )}
        </div>
      </header>

      {msg && <p style={msgStyle}>{msg}</p>}

      {editing ? (
        <StudentForm initial={student} onSubmit={handleSave} submitting={submitting} />
      ) : (
        <div style={detailGrid}>
          {Object.entries(student).map(([k, v]) =>
            k === 'id' ? null : (
              <div key={k} style={detailItem}>
                <span style={detailKey}>{k}</span>
                <span style={detailVal}>{str(v)}</span>
              </div>
            ),
          )}
        </div>
      )}
    </main>
  );
}

const wrap: React.CSSProperties = { maxWidth: 1000, margin: '0 auto', padding: '32px 24px' };
const header: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24, gap: 16, flexWrap: 'wrap' };
const h1: React.CSSProperties = { fontSize: 22, fontWeight: 700, marginTop: 8 };
const sub: React.CSSProperties = { fontSize: 14, color: 'var(--muted)', fontWeight: 400 };
const actions: React.CSSProperties = { display: 'flex', gap: 12 };
const link: React.CSSProperties = { color: 'var(--brand)', textDecoration: 'none', fontSize: 14 };
const btnPrimary: React.CSSProperties = { padding: '8px 18px', border: 'none', borderRadius: 8, background: 'var(--brand)', color: '#fff', fontWeight: 600, cursor: 'pointer' };
const btnGhost: React.CSSProperties = { padding: '8px 18px', border: '1px solid var(--border)', borderRadius: 8, background: '#fff', color: 'var(--muted)', cursor: 'pointer' };
const btnDanger: React.CSSProperties = { padding: '8px 18px', border: '1px solid #fca5a5', borderRadius: 8, background: '#fff', color: '#dc2626', cursor: 'pointer' };
const muted: React.CSSProperties = { color: 'var(--muted)' };
const err: React.CSSProperties = { color: '#dc2626' };
const msgStyle: React.CSSProperties = { color: '#16a34a', marginBottom: 12 };
const detailGrid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14 };
const detailItem: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, padding: 14, border: '1px solid var(--border)', borderRadius: 10, background: '#fff' };
const detailKey: React.CSSProperties = { fontSize: 12, color: 'var(--muted)' };
const detailVal: React.CSSProperties = { fontSize: 15, fontWeight: 500, wordBreak: 'break-all' };
