'use client';

import { useState } from 'react';
import Link from 'next/link';
import { api } from '../../../lib/api';

interface PrecheckState {
  课次日期: string;
  开始时间: string;
  结束时间: string;
  教学班文本: string;
  授课教师文本: string;
  场地文本: string;
}

export default function SchedulePrecheckPage() {
  const [form, setForm] = useState<PrecheckState>({ 课次日期: '', 开始时间: '', 结束时间: '', 教学班文本: '', 授课教师文本: '', 场地文本: '' });
  const [result, setResult] = useState<{ hard: { type: string; sessionId?: string; field?: string }[]; soft: unknown[] } | null>(null);
  const [checking, setChecking] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function runCheck() {
    setChecking(true);
    setErr(null);
    try {
      const r = await api.precheckConflicts({ ...form });
      setResult(r);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : '预检失败');
    } finally {
      setChecking(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <div className="page-header-row">
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-md)' }}>
            <Link href="/schedule" className="btn btn-icon" title="返回课次列表">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18"><path d="m15 18-6-6 6-6" /></svg>
            </Link>
            <div>
              <div className="page-eyebrow">排课与课次 / 冲突预检</div>
              <h1 className="page-title">排课冲突预检</h1>
            </div>
          </div>
        </div>
        <p className="page-subtitle">输入拟排课次的时间与资源，预检教师 / 场地 / 教学班是否冲突。</p>
      </div>

      <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 14, padding: '18px 20px', marginBottom: 'var(--space-lg)' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 'var(--font-sm)' }}>课次日期<input className="form-input" type="date" value={form.课次日期} onChange={(e) => setForm((f) => ({ ...f, 课次日期: e.target.value }))} /></label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 'var(--font-sm)' }}>开始时间<input className="form-input" type="text" placeholder="HH:mm" value={form.开始时间} onChange={(e) => setForm((f) => ({ ...f, 开始时间: e.target.value }))} /></label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 'var(--font-sm)' }}>结束时间<input className="form-input" type="text" placeholder="HH:mm" value={form.结束时间} onChange={(e) => setForm((f) => ({ ...f, 结束时间: e.target.value }))} /></label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 'var(--font-sm)' }}>教学班<input className="form-input" type="text" value={form.教学班文本} onChange={(e) => setForm((f) => ({ ...f, 教学班文本: e.target.value }))} /></label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 'var(--font-sm)' }}>授课教师<input className="form-input" type="text" value={form.授课教师文本} onChange={(e) => setForm((f) => ({ ...f, 授课教师文本: e.target.value }))} /></label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 'var(--font-sm)' }}>场地<input className="form-input" type="text" value={form.场地文本} onChange={(e) => setForm((f) => ({ ...f, 场地文本: e.target.value }))} /></label>
        </div>
        <div style={{ marginTop: 14 }}>
          <button className="btn btn-primary" onClick={runCheck} disabled={checking || !form.课次日期}>{checking ? '预检中…' : '执行预检'}</button>
        </div>
        {err && <p className="msg-error" style={{ marginTop: 12 }}>{err}</p>}
        {result && (
          <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {result.hard.length === 0
              ? <div style={{ padding: '10px 14px', borderRadius: 10, background: 'rgba(78,205,196,0.12)', border: '1px solid rgba(78,205,196,0.4)', color: 'var(--success)', fontSize: 'var(--font-sm)' }}>未检出硬冲突，可安全排课。</div>
              : <div style={{ padding: '10px 14px', borderRadius: 10, background: 'rgba(255,107,107,0.12)', border: '1px solid rgba(255,107,107,0.4)', color: 'var(--danger)', fontSize: 'var(--font-sm)' }}>检出 {result.hard.length} 处硬冲突：{result.hard.map((h) => h.type).join('、')}（需调整后确认课次）</div>}
            {result.soft.length > 0 && <div style={{ padding: '10px 14px', borderRadius: 10, background: 'rgba(245,166,35,0.12)', border: '1px solid rgba(245,166,35,0.4)', color: 'var(--warning)', fontSize: 'var(--font-sm)' }}>软冲突 {result.soft.length} 处，请关注。</div>}
          </div>
        )}
      </div>
    </div>
  );
}
