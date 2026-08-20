'use client';

import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';

export type Agent = {
  id?: string;
  name?: string;
  emoji?: string;
  description?: string;
  systemPrompt?: string;
  toolList?: string[];
  model?: string;
  provider?: string;
  baseUrl?: string;
  owner?: string;
  updatedAt?: string;
};

type Tool = { name: string; description: string };

export function AgentForm({ initial, onDone }: { initial?: Agent; onDone: () => void }) {
  const [form, setForm] = useState<Agent>({ ...initial, toolList: initial?.toolList || [] });
  const [tools, setTools] = useState<Tool[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.aiTools().then((data) => setTools(data as Tool[])).catch((e) => setError((e as Error).message));
  }, []);

  function toggleTool(name: string) {
    setForm((current) => {
      const selected = new Set(current.toolList || []);
      if (selected.has(name)) selected.delete(name);
      else selected.add(name);
      return { ...current, toolList: [...selected] };
    });
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name?.trim()) {
      setError('请填写智能体名称');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const payload = {
        name: form.name.trim(),
        emoji: form.emoji?.trim() || '',
        description: form.description?.trim() || '',
        systemPrompt: form.systemPrompt?.trim() || '',
        toolList: form.toolList || [],
        provider: form.provider?.trim() || '',
        model: form.model?.trim() || '',
        baseUrl: form.baseUrl?.trim() || '',
      };
      if (initial?.id) await api.aiUpdateAgent(initial.id, payload);
      else await api.aiCreateAgent(payload);
      onDone();
    } catch (e2) {
      setError((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <fieldset className="form-fieldset">
        <legend className="form-legend">基本信息</legend>
        <div className="form-grid">
          <label className="form-label">
            <span className="form-label-text">名称 *</span>
            <input className="form-input" value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label className="form-label">
            <span className="form-label-text">图标 Emoji</span>
            <input className="form-input" value={form.emoji || ''} onChange={(e) => setForm({ ...form, emoji: e.target.value })} />
          </label>
          <label className="form-label" style={{ gridColumn: '1 / -1' }}>
            <span className="form-label-text">描述</span>
            <input className="form-input" value={form.description || ''} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </label>
          <label className="form-label" style={{ gridColumn: '1 / -1' }}>
            <span className="form-label-text">系统人设（Markdown）</span>
            <textarea className="form-input" rows={6} value={form.systemPrompt || ''} onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })} />
          </label>
        </div>
      </fieldset>

      <fieldset className="form-fieldset">
        <legend className="form-legend">模型绑定</legend>
        <div className="form-grid">
          <label className="form-label">
            <span className="form-label-text">Provider</span>
            <input className="form-input" value={form.provider || ''} onChange={(e) => setForm({ ...form, provider: e.target.value })} placeholder="openai" />
          </label>
          <label className="form-label">
            <span className="form-label-text">模型 Model</span>
            <input className="form-input" value={form.model || ''} onChange={(e) => setForm({ ...form, model: e.target.value })} />
          </label>
          <label className="form-label" style={{ gridColumn: '1 / -1' }}>
            <span className="form-label-text">Base URL</span>
            <input className="form-input" value={form.baseUrl || ''} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />
          </label>
        </div>
      </fieldset>

      <fieldset className="form-fieldset">
        <legend className="form-legend">可用工具</legend>
        <p className="page-subtitle" style={{ margin: '0 0 14px' }}>不选择时允许使用全部工具。</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {tools.map((tool) => {
            const selected = (form.toolList || []).includes(tool.name);
            return (
              <button key={tool.name} type="button" className={`btn btn-sm ${selected ? 'btn-primary' : 'btn-outline'}`} title={tool.description} onClick={() => toggleTool(tool.name)}>
                {tool.name}
              </button>
            );
          })}
        </div>
      </fieldset>

      {error && <p className="msg-error">{error}</p>}
      <div style={{ display: 'flex', gap: 10 }}>
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? '保存中…' : '保存'}</button>
        <button type="button" className="btn btn-ghost" onClick={onDone}>取消</button>
      </div>
    </form>
  );
}
