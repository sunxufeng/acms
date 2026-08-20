'use client';

import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';

export type Auto = {
  id?: string;
  title: string;
  description: string;
  cron: string;
  cronText?: string;
  enabled: boolean;
  idleOnly?: boolean;
  pushTo?: string[];
  maxSteps?: number;
  agentId?: string;
  actionType?: string;
};

const field: React.CSSProperties = { width: '100%', background: 'var(--bg-tertiary)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', fontSize: 13, marginBottom: 10 };
const label: React.CSSProperties = { fontSize: 12, color: 'var(--text-muted)', marginBottom: 4, display: 'block' };
const btn = (primary = false): React.CSSProperties => ({
  background: primary ? 'var(--accent)' : 'transparent',
  color: primary ? '#fff' : 'var(--text)',
  border: primary ? 'none' : '1px solid var(--border)',
  borderRadius: 8,
  padding: '7px 14px',
  cursor: 'pointer',
  fontSize: 13,
});

type AgentOption = { id: string; name: string; emoji?: string; provider?: string; model?: string };

export function AutomationForm({ initial, onDone }: { initial?: Partial<Auto>; onDone: () => void }) {
  const isEdit = !!initial?.id;
  const [title, setTitle] = useState(initial?.title || '');
  const [description, setDescription] = useState(initial?.description || '');
  const [freq, setFreq] = useState('daily');
  const [hour, setHour] = useState(9);
  const [minute, setMinute] = useState(35);
  const [cron, setCron] = useState(initial?.cron || '35 9 * * *');
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [idleOnly, setIdleOnly] = useState(!!initial?.idleOnly);
  const [pushTo, setPushTo] = useState((initial?.pushTo || []).join(', '));
  const [maxSteps, setMaxSteps] = useState(initial?.maxSteps || 10);
  const [agentId, setAgentId] = useState(initial?.agentId || '');

  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.aiListAgents().then((list) => setAgents(list as AgentOption[])).catch(() => null);
  }, []);

  const selAgent = agents.find((a) => a.id === agentId) || null;

  async function buildCron() {
    try {
      const r = await api.aiBuildCron({ freq, hour, minute });
      setCron(r.cron);
    } catch { /* ignore */ }
  }

  async function save() {
    setBusy(true);
    setError('');
    try {
      const payload: Record<string, unknown> = {
        title, description, cron, enabled, idleOnly,
        pushTo: pushTo.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
        maxSteps: Number(maxSteps) || 10,
        agentId: agentId || undefined,
      };
      if (isEdit) await api.aiUpdateAutomation(initial!.id!, payload);
      else await api.aiCreateAutomation(payload);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 640 }}>
      {error && <p className="msg-error" style={{ marginBottom: 12 }}>{error}</p>}

      <label style={label}>任务名</label>
      <input style={field} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：每日晨报" />

      <label style={label}>提示词（直接作为每轮执行的 userInput）</label>
      <textarea style={{ ...field, height: 90, resize: 'vertical' }} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="例如：总结我今天的待办与日程，给出优先级建议" />

      <label style={label}>关联智能体（选择后自动沿用其 Provider / Model，无需单独配置模型）</label>
      <select style={field} value={agentId} onChange={(e) => setAgentId(e.target.value)}>
        <option value="">（不使用智能体，使用收件人个人配置）</option>
        {agents.map((a) => (
          <option key={a.id} value={a.id}>{a.emoji || '🤖'} {a.name}</option>
        ))}
      </select>
      {selAgent && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
          Provider：{selAgent.provider || '（未设置）'} ／ Model：{selAgent.model || '（未设置）'}
        </div>
      )}

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
        <button style={btn()} type="button" onClick={buildCron}>生成 cron</button>
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
        <button style={btn(true)} disabled={busy} onClick={save}>{busy ? '保存中…' : '保存'}</button>
        <button style={btn()} type="button" onClick={onDone}>取消</button>
      </div>
    </div>
  );
}
