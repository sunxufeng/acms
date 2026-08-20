'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '../../../lib/api';

type Auto = {
  id: string;
  title: string;
  description: string;
  cron: string;
  cronText?: string;
  enabled: boolean;
  idleOnly?: boolean;
  pushTo?: string[];
  maxSteps?: number;
  runs?: { ts: number; status: string; durationMs?: number; preview?: string }[];
  updatedAt?: number;
};

const btn = (primary = false): React.CSSProperties => ({
  background: primary ? 'var(--accent)' : 'transparent',
  color: primary ? '#fff' : 'var(--text)',
  border: primary ? 'none' : '1px solid var(--border)',
  borderRadius: 8,
  padding: '6px 12px',
  cursor: 'pointer',
  fontSize: 13,
});

export default function AiAutomationsPage() {
  const [list, setList] = useState<Auto[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try { setList((await api.aiListAutomations()) as Auto[]); } catch (e) { alert(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  async function remove(id: string) {
    if (!confirm('确认删除该自动化任务？')) return;
    try { await api.aiDeleteAutomation(id); await load(); } catch (e) { alert(e instanceof Error ? e.message : String(e)); }
  }
  async function run(id: string) {
    try { await api.aiRunAutomation(id); alert('已触发（后台异步执行，可在运行记录查看）'); } catch (e) { alert(e instanceof Error ? e.message : String(e)); }
  }

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div>
          <h2 style={{ margin: 0 }}>自动化任务</h2>
          <small style={{ color: 'var(--text-muted)' }}>按 cron 定时调用模型并将结果推送至飞书。可关联智能体（自动沿用其 Provider / Model），否则使用收件人个人配置。</small>
        </div>
        <Link href="/ai/automations/new" style={btn(true) as React.CSSProperties}>＋ 新建</Link>
      </div>

      {loading ? (
        <div style={{ color: 'var(--text-muted)' }}>加载中…</div>
      ) : (
        <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: 'var(--bg-tertiary)', textAlign: 'left' }}>
                <th style={{ padding: 10 }}>任务名</th>
                <th style={{ padding: 10 }}>调度</th>
                <th style={{ padding: 10 }}>收件人</th>
                <th style={{ padding: 10 }}>状态</th>
                <th style={{ padding: 10 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {list.length === 0 && (
                <tr><td colSpan={5} style={{ padding: 16, color: 'var(--text-muted)', textAlign: 'center' }}>暂无自动化任务</td></tr>
              )}
              {list.map((a) => (
                <tr key={a.id} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ padding: 10 }}>{a.title}</td>
                  <td style={{ padding: 10 }}>{a.cronText || a.cron}{a.idleOnly ? '（闲时）' : ''}</td>
                  <td style={{ padding: 10 }}>{(a.pushTo || []).length} 人</td>
                  <td style={{ padding: 10 }}>{a.enabled ? '✅ 启用' : '⏸ 停用'}</td>
                  <td style={{ padding: 10, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <Link href={`/ai/automations/${a.id}/edit`} style={btn() as React.CSSProperties}>编辑</Link>
                    <button style={btn()} onClick={() => run(a.id)}>运行</button>
                    <button style={btn()} onClick={() => remove(a.id)}>删除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
