'use client';

import { useEffect, useState } from 'react';

const API = '/api/v1';

/** 家长 H5 专用请求：带 cookie、不触发 api.ts 的 401→/login 跳转 */
async function preq(path: string, opts: RequestInit = {}) {
  const res = await fetch(`${API}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  if (res.status === 401) {
    const e = new Error('UNAUTHENTICATED') as Error & { code?: string };
    e.code = 'UNAUTHENTICATED';
    throw e;
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const t = await res.text();
      const b = JSON.parse(t);
      msg = b?.error?.message || b?.message || msg;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}

function fmt(v: unknown): string {
  if (v == null || v === '') return '—';
  if (Array.isArray(v)) return v.join('、');
  return String(v);
}

export default function ParentPage() {
  const [stage, setStage] = useState<'checking' | 'bind' | 'dashboard'>('checking');
  const [studentNo, setStudentNo] = useState('');
  const [name, setStrName] = useState('');
  const [bindErr, setBindErr] = useState('');
  const [busy, setBusy] = useState(false);

  const [attendances, setAttendances] = useState<Record<string, unknown>[]>([]);
  const [attLoading, setAttLoading] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [contact, setContact] = useState('');
  const [fbMsg, setFbMsg] = useState('');
  const [fbBusy, setFbBusy] = useState(false);

  useEffect(() => {
    preq('/auth/me')
      .then((me) => {
        if (me?.roles?.includes('parent')) setStage('dashboard');
        else setStage('bind');
      })
      .catch(() => setStage('bind'));
  }, []);

  useEffect(() => {
    if (stage === 'dashboard') loadAttendances();
  }, [stage]);

  async function loadAttendances() {
    setAttLoading(true);
    try {
      const r = await preq('/parent/attendances');
      setAttendances(r.items || []);
    } catch {
      setAttendances([]);
    } finally {
      setAttLoading(false);
    }
  }

  async function doBind() {
    if (!studentNo || !name) {
      setBindErr('请填写学号和姓名');
      return;
    }
    setBusy(true);
    setBindErr('');
    try {
      await preq('/parent/auth/bind', {
        method: 'POST',
        body: JSON.stringify({ studentNo, name }),
      });
      setStage('dashboard');
    } catch (e) {
      setBindErr((e as Error).message || '绑定失败，请核对学号和姓名');
    } finally {
      setBusy(false);
    }
  }

  async function doFeedback() {
    if (!feedback.trim()) {
      setFbMsg('请输入反馈内容');
      return;
    }
    setFbBusy(true);
    setFbMsg('');
    try {
      await preq('/parent/feedback', {
        method: 'POST',
        body: JSON.stringify({ content: feedback, contact: contact || undefined }),
      });
      setFbMsg('已提交，老师会尽快跟进');
      setFeedback('');
      setContact('');
    } catch (e) {
      setFbMsg((e as Error).message || '提交失败');
    } finally {
      setFbBusy(false);
    }
  }

  if (stage === 'checking') {
    return <div style={wrap}><div style={card}><p style={muted}>加载中…</p></div></div>;
  }

  if (stage === 'bind') {
    return (
      <div style={wrap}>
        <div style={card}>
          <h1 style={title}>家长绑定</h1>
          <p style={muted}>用学生的学号 + 姓名绑定，查看考勤与提交反馈</p>
          <input style={input} placeholder="学号" value={studentNo} onChange={(e) => setStudentNo(e.target.value)} />
          <input style={input} placeholder="学生姓名" value={name} onChange={(e) => setStrName(e.target.value)} />
          {bindErr && <p style={{ color: '#e54848', fontSize: 13 }}>{bindErr}</p>}
          <button style={btn} onClick={doBind} disabled={busy}>{busy ? '绑定中…' : '绑定'}</button>
        </div>
      </div>
    );
  }

  return (
    <div style={wrap}>
      <div style={card}>
        <h1 style={title}>学生考勤</h1>
        {attLoading && <p style={muted}>加载中…</p>}
        {!attLoading && attendances.length === 0 && <p style={muted}>暂无考勤记录</p>}
        {attendances.map((a, i) => (
          <div key={i} style={{ borderBottom: '1px solid #eee', padding: '10px 0' }}>
            <div style={{ fontWeight: 600 }}>{fmt(a['考勤日期'])} · {fmt(a['方向'])}</div>
            <div style={muted}>
              状态 {fmt(a['考勤状态'])} · 方式 {fmt(a['签到方式'])} · 校区 {fmt(a['校区'])}
              {a['签到距离(米)'] != null ? ` · ${fmt(a['签到距离(米)'])} 米` : ''}
            </div>
          </div>
        ))}
        <button style={{ ...btn, background: '#eef0fb', color: '#4f46e5' }} onClick={loadAttendances}>刷新</button>
      </div>

      <div style={card}>
        <h1 style={title}>提交反馈</h1>
        <input style={input} placeholder="家长联系方式（选填）" value={contact} onChange={(e) => setContact(e.target.value)} />
        <textarea style={{ ...input, minHeight: 90, padding: 12 }} placeholder="向老师反馈请假 / 异常等情况" value={feedback} onChange={(e) => setFeedback(e.target.value)} />
        {fbMsg && <p style={{ fontSize: 13, color: fbMsg.includes('已提交') ? '#18a058' : '#e54848' }}>{fbMsg}</p>}
        <button style={btn} onClick={doFeedback} disabled={fbBusy}>{fbBusy ? '提交中…' : '提交'}</button>
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
  marginBottom: 16,
  boxShadow: '0 4px 16px rgba(0,0,0,0.05)',
};
const title: React.CSSProperties = { fontSize: 20, fontWeight: 700, margin: '0 0 6px' };
const muted: React.CSSProperties = { color: '#8a90a2', fontSize: 13, margin: '4px 0' };
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
