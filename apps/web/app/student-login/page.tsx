'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '../../lib/api';

export default function StudentLoginPage() {
  const router = useRouter();
  const [stage, setStage] = useState<'checking' | 'bind'>('checking');
  const [studentNo, setStudentNo] = useState('');
  const [name, setName] = useState('');
  const [bindErr, setBindErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // 已是学生会话则直接进门户
    api
      .me()
      .then((me) => {
        if ((me?.roles ?? []).includes('student')) router.replace('/portal');
        else setStage('bind');
      })
      .catch(() => setStage('bind'));
  }, [router]);

  async function doBind() {
    if (!studentNo || !name) {
      setBindErr('请填写学号和姓名');
      return;
    }
    setBusy(true);
    setBindErr('');
    try {
      await api.studentLogin(studentNo, name);
      router.replace('/portal');
    } catch (e) {
      const msg = e instanceof Error ? e.message : '绑定失败';
      setBindErr(msg.includes('STUDENT_NOT_FOUND') ? '学号或姓名不匹配，请核对后重试' : msg || '绑定失败，请核对学号和姓名');
    } finally {
      setBusy(false);
    }
  }

  if (stage === 'checking') {
    return (
      <div style={wrap}>
        <div style={card}>
          <p style={muted}>加载中…</p>
        </div>
      </div>
    );
  }

  return (
    <div style={wrap}>
      <div style={card}>
        <h1 style={title}>学生登录</h1>
        <p style={muted}>用本人的学号 + 姓名登录，进入学生自助门户（仅可查看本人数据）</p>
        <input style={input} placeholder="学号" value={studentNo} onChange={(e) => setStudentNo(e.target.value)} />
        <input style={input} placeholder="学生姓名" value={name} onChange={(e) => setName(e.target.value)} />
        {bindErr && <p style={{ color: '#e54848', fontSize: 13 }}>{bindErr}</p>}
        <button style={btn} onClick={doBind} disabled={busy}>
          {busy ? '登录中…' : '登录'}
        </button>
        <a href="/login" style={{ display: 'block', textAlign: 'center', marginTop: 14, color: '#8a90a2', fontSize: 13 }}>
          我是教职工？前往飞书登录
        </a>
      </div>
    </div>
  );
}

const wrap: React.CSSProperties = {
  maxWidth: 480,
  margin: '0 auto',
  padding: '24px 16px',
  fontFamily: 'system-ui, sans-serif',
  background: '#f5f6fa',
  minHeight: '100vh',
};
const card: React.CSSProperties = {
  background: '#fff',
  borderRadius: 16,
  padding: 20,
  marginTop: 48,
  boxShadow: '0 4px 16px rgba(0,0,0,0.05)',
};
const title: React.CSSProperties = { fontSize: 20, fontWeight: 700, margin: '0 0 6px' };
const muted: React.CSSProperties = { color: '#8a90a2', fontSize: 13, margin: '4px 0 14px' };
const input: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  border: '1px solid #e3e5ec',
  borderRadius: 10,
  padding: '12px 14px',
  fontSize: 15,
  marginBottom: 12,
  fontFamily: 'inherit',
};
const btn: React.CSSProperties = {
  width: '100%',
  background: '#4f46e5',
  color: '#fff',
  border: 'none',
  borderRadius: 999,
  padding: '13px 0',
  fontSize: 15,
  fontWeight: 600,
  cursor: 'pointer',
};
