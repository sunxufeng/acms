'use client';

import { useEffect, useState } from 'react';
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
const field: React.CSSProperties = { width: '100%', background: 'var(--bg-tertiary)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', fontSize: 13, marginBottom: 10 };
const label: React.CSSProperties = { fontSize: 12, color: 'var(--text-muted)', marginBottom: 4, display: 'block' };

export default function AiAutomationsPage() {
  const [list, setList] = useState<Auto[]>([]);
  const [editing, setEditing] = useState<Auto | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try { setList((await api.aiListAutomations()) as Auto[]); } catch (e) { alert(e instanceof Error ? e.message : String(e)); }
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
          <small style={{ color: 'var(--text-muted)' }}>按 cron 定时调用模型并将结果推送至飞书（需收件人已配置个人模型）。</small>
        </div>
        <button style={btn(true)} onClick={() => setEditing({ id: '', title: '', description: '', cron: '35 9 * * *', enabled: true, pushTo: [], maxSteps: 10 } as Auto)}>＋ 新建</button>
      </div>

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
                  <button style={btn()} onClick={() => setEditing(a)}>编辑</button>
                  <button style={btn()} onClick={() => run(a.id)}>运行</button>
                  <button style={btn()} onClick={() => remove(a.id)}>删除</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <Editor auto={editing} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await load(); }} busy={busy} setBusy={setBusy} />
      )}
    </div>
  );
}

function Editor({ auto, onClose, onSaved, busy, setBusy }: { auto: Auto; onClose: () => void; onSaved: () => void; busy: boolean; setBusy: (b: boolean) => void }) {
  const [title, setTitle] = useState(auto.title);
  const [description, setDescription] = useState(auto.description);
  const [freq, setFreq] = useState('daily');
  const [hour, setHour] = useState(9);
  const [minute, setMinute] = useState(35);
  const [cron, setCron] = useState(auto.cron);
  const [enabled, setEnabled] = useState(auto.enabled);
  const [idleOnly, setIdleOnly] = useState(!!auto.idleOnly);
  const [pushTo, setPushTo] = useState((auto.pushTo || []).join(', '));
  const [maxSteps, setMaxSteps] = useState(auto.maxSteps || 10);

  async function buildCron() {
    try {
      const r = await api.aiBuildCron({ freq, hour, minute });
      setCron(r.cron);
    } catch { /* ignore */ }
  }

  async function save() {
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        title, description, cron, enabled, idleOnly,
        pushTo: pushTo.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
        maxSteps: Number(maxSteps) || 10,
      };
      if (auto.id) await api.aiUpdateAutomation(auto.id, payload);
      else await api.aiCreateAutomation(payload);
      onSaved();
    } catch (e) { alert(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 50 }} onClick={onClose}>
      <div style={{ width: 560, maxHeight: '90vh', overflowY: 'auto', background: 'var(--bg-secondary)', padding: 20, borderRadius: 10 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h3 style={{ margin: 0 }}>{auto.id ? '编辑自动化' : '新建自动化'}</h3>
          <button style={btn()} onClick={onClose}>关闭</button>
        </div>

        <label style={label}>任务名</label>
        <input style={field} value={title} onChange={(e) => setTitle(e.target.value)} />

        <label style={label}>提示词（直接作为每轮执行的 userInput）</label>
        <textarea style={{ ...field, height: 90, resize: 'vertical' }} value={description} onChange={(e) => setDescription(e.target.value)} />

        <label style={label}>调度（频率 / 时间）</label>
        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          <select style={{ ...field, marginBottom: 0 }} value={freq} onChange={(e) => setFreq(e.target.value)}>
            <option value="daily">每天</option>
            <option value="weekly">每周</option>
            <option value="monthly">每月</option>
            <option value="hourly">每小时</option>
          </select>
          <input style={{ ...field, marginBottom: 0, width: 80 }} type="number" min={0} max={23} value={hour} onChange={(e) => setHour(Number(e.target.value))} />
          <input style={{ ...field, marginBottom: 0, width: 80 }} type="number" min={0} max={59} value={minute} onChange={(e) => setMinute(Number(e.target.value))} />
          <button style={btn()} onClick={buildCron}>生成 cron</button>
        </div>

        <label style={label}>Cron 表达式（5 字段，可手动改）</label>
        <input style={field} value={cron} onChange={(e) => setCron(e.target.value)} />

        <label style={label}>收件人 open_id（逗号或空格分隔，至少 1 个）</label>
        <input style={field} value={pushTo} onChange={(e) => setPushTo(e.target.value)} placeholder="ou_xxx, ou_yyy" />

        <div style={{ display: 'flex', gap: 16, marginBottom: 10 }}>
          <label style={{ fontSize: 13 }}><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> 启用</label>
          <label style={{ fontSize: 13 }}><input type="checkbox" checked={idleOnly} onChange={(e) => setIdleOnly(e.target.checked)} /> 闲时执行（00:00–06:00）</label>
        </div>

        <label style={label}>最大工具步数（默认 10）</label>
        <input style={field} type="number" min={1} max={50} value={maxSteps} onChange={(e) => setMaxSteps(Number(e.target.value))} />

        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button style={btn(true)} disabled={busy} onClick={save}>保存</button>
          <button style={btn()} onClick={onClose}>取消</button>
        </div>
      </div>
    </div>
  );
}
