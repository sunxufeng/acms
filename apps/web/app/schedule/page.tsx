'use client';

import { useState } from 'react';
import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';

const METHOD_OPTS = ['线下', '线上', '混合'];
const STATUS_OPTS = ['待确认', '已确认', '已完成', '已取消', '已调课'];
const SOURCE_OPTS = ['公共课批量生成', '定制课生成', '人工加课', '调课'];

const TRANSITIONS: Record<string, string[]> = {
  待确认: ['已确认', '已取消', '已调课'],
  已确认: ['已完成', '已取消', '已调课'],
  已完成: [],
  已取消: [],
  已调课: ['待确认'],
};

const COLUMNS: CrudColumn[] = [
  { key: '课次名称', label: '课次', width: '160px', form: true, required: true, type: 'text' },
  { key: '教学班文本', label: '教学班', width: '140px', filter: true, form: true, type: 'text' },
  { key: '授课教师文本', label: '授课教师', width: '120px', filter: true, form: true, type: 'text' },
  { key: '场地文本', label: '场地', width: '120px', filter: true, form: true, type: 'text' },
  { key: '课次日期', label: '日期', width: '120px', form: true, type: 'date' },
  { key: '开始时间', label: '开始', width: '80px', form: true, type: 'text' },
  { key: '结束时间', label: '结束', width: '80px', form: true, type: 'text' },
  { key: '授课方式', label: '方式', width: '90px', filter: true, filterOptions: METHOD_OPTS, form: true, type: 'select', options: METHOD_OPTS },
  { key: '课次状态', label: '状态', width: '100px', filter: true, filterOptions: STATUS_OPTS },
  { key: '更新时间', label: '更新', width: '90px', render: (v) => <span style={{ color: 'var(--fg-tertiary)', fontSize: 'var(--font-xs)' }}>{String(v ?? '').slice(0, 10)}</span> },
];

function statusClass(s: string): string {
  if (s === '已确认' || s === '已完成') return 'status-active';
  if (s === '已取消') return 'status-left';
  if (s === '待确认') return 'status-draft';
  if (s === '已调课') return 'status-warn';
  return '';
}

interface PrecheckState {
  课次日期: string;
  开始时间: string;
  结束时间: string;
  教学班文本: string;
  授课教师文本: string;
  场地文本: string;
}

export default function SchedulePage() {
  const [form, setForm] = useState<PrecheckState>({ 课次日期: '', 开始时间: '', 结束时间: '', 教学班文本: '', 授课教师文本: '', 场地文本: '' });
  const [result, setResult] = useState<{ hard: { type: string }[]; soft: unknown[] } | null>(null);
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
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">排课与课次</h1>
          <p className="page-subtitle">课次排课与冲突预检（M2 排课域）</p>
        </div>
      </div>

      <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 14, padding: '18px 20px', marginBottom: 'var(--space-lg)' }}>
        <div style={{ fontWeight: 700, fontSize: 'var(--font-lg)', marginBottom: 4 }}>排课冲突预检</div>
        <p style={{ color: 'var(--fg-tertiary)', fontSize: 'var(--font-sm)', margin: '0 0 14px' }}>输入拟排课次的时间与资源，预检教师 / 场地 / 教学班是否冲突。</p>
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

      <CrudPage
        title="课次列表"
        columns={COLUMNS}
        statusField="课次状态"
        transitions={TRANSITIONS}
        statusClass={statusClass}
        inlineEdit
        api={{
          list: (p) => api.listSessions(p),
          create: (d) => api.createSession(d),
          update: (id, d) => api.updateSession(id, d),
          archive: (id) => api.archiveSession(id),
          transition: (id, to) => api.transitionSession(id, to),
        }}
      />
    </div>
  );
}
