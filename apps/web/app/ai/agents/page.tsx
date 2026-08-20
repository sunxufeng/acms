'use client';

import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';

type Agent = {
  id: string;
  name: string;
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

const field: React.CSSProperties = { width: '100%', background: 'var(--bg-tertiary)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', fontSize: 13, marginBottom: 10 };
const label: React.CSSProperties = { fontSize: 12, color: 'var(--text-muted)', marginBottom: 4, display: 'block' };
const btn = (primary = false): React.CSSProperties => ({
  background: primary ? 'var(--accent)' : 'transparent', color: primary ? '#fff' : 'var(--text)',
  border: primary ? 'none' : '1px solid var(--border)', borderRadius: 8, padding: '7px 14px', cursor: 'pointer', fontSize: 13,
});

export default function AiAgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [tools, setTools] = useState<Tool[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Agent | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Partial<Agent>>({});
  const [busy, setBusy] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const [a, t] = await Promise.all([api.aiListAgents(), api.aiTools()]);
      setAgents(a as Agent[]);
      setTools(t as Tool[]);
    } catch (e) { alert(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }

  useEffect(() => { load(); }, []);

  function openCreate() { setForm({ toolList: [] }); setEditing(null); setOpen(true); }
  function openEdit(a: Agent) { setForm({ ...a, toolList: a.toolList || [] }); setEditing(a); setOpen(true); }

  function toggleTool(name: string) {
    setForm((f) => {
      const set = new Set(f.toolList || []);
      if (set.has(name)) set.delete(name); else set.add(name);
      return { ...f, toolList: [...set] };
    });
  }

  async function save() {
    setBusy(true);
    try {
      if (editing) await api.aiUpdateAgent(editing.id, form as Record<string, unknown>);
      else await api.aiCreateAgent(form as Record<string, unknown>);
      setOpen(false);
      await load();
    } catch (e) { alert(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function del(a: Agent) {
    if (!confirm(`确认删除智能体「${a.name}」？`)) return;
    try { await api.aiDeleteAgent(a.id); await load(); } catch (e) { alert(e instanceof Error ? e.message : String(e)); }
  }

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div>
          <h2 style={{ margin: 0 }}>智能体配置</h2>
          <small style={{ color: 'var(--text-muted)' }}>创建 / 编辑智能体（人设 + 可用工具 + 模型绑定）。当前为配置态，可在后续对话中按智能体选用。</small>
        </div>
        <button style={btn(true)} onClick={openCreate}>＋ 新建智能体</button>
      </div>

      {loading ? <div style={{ color: 'var(--text-muted)' }}>加载中…</div> :
        agents.length === 0 ? <div style={{ color: 'var(--text-muted)' }}>暂无智能体，点击右上角新建。</div> :
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(280px,1fr))', gap: 12 }}>
          {agents.map((a) => (
            <div key={a.id} style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 10, padding: 14 }}>
              <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 6 }}>{a.emoji || '🤖'} {a.name}</div>
              <div style={{ color: 'var(--text-muted)', fontSize: 12, minHeight: 32 }}>{a.description || '（无描述）'}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', margin: '8px 0' }}>
                工具：{(a.toolList && a.toolList.length) ? a.toolList.join('、') : '全部'}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button style={btn()} onClick={() => openEdit(a)}>编辑</button>
                <button style={btn()} onClick={() => del(a)}>删除</button>
              </div>
            </div>
          ))}
        </div>}

      {open && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', justifyContent: 'flex-end', zIndex: 50 }} onClick={() => setOpen(false)}>
          <div style={{ width: 480, height: '100%', background: 'var(--bg-secondary)', overflowY: 'auto', padding: 20 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 style={{ margin: 0 }}>{editing ? '编辑智能体' : '新建智能体'}</h3>
              <button style={btn()} onClick={() => setOpen(false)}>关闭</button>
            </div>

            <label style={label}>名称 name</label>
            <input style={field} value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} />

            <label style={label}>图标 emoji</label>
            <input style={field} value={form.emoji || ''} onChange={(e) => setForm({ ...form, emoji: e.target.value })} />

            <label style={label}>描述 description</label>
            <input style={field} value={form.description || ''} onChange={(e) => setForm({ ...form, description: e.target.value })} />

            <label style={label}>系统人设 systemPrompt（Markdown）</label>
            <textarea style={{ ...field, height: 120, resize: 'vertical' }} value={form.systemPrompt || ''} onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })} />

            <label style={label}>可用工具（不选 = 全部）</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
              {tools.map((t) => {
                const on = (form.toolList || []).includes(t.name);
                return (
                  <button key={t.name} type="button" onClick={() => toggleTool(t.name)}
                    style={{ ...btn(), borderColor: on ? 'var(--accent)' : 'var(--border)', color: on ? 'var(--accent)' : 'var(--text)' }}
                    title={t.description}>{t.name}</button>
                );
              })}
            </div>

            <div style={{ display: 'flex', gap: 10 }}>
              <div style={{ flex: 1 }}>
                <label style={label}>Provider</label>
                <input style={field} value={form.provider || ''} onChange={(e) => setForm({ ...form, provider: e.target.value })} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={label}>模型 Model</label>
                <input style={field} value={form.model || ''} onChange={(e) => setForm({ ...form, model: e.target.value })} />
              </div>
            </div>
            <label style={label}>Base URL</label>
            <input style={field} value={form.baseUrl || ''} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />

            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button style={btn(true)} disabled={busy} onClick={save}>保存</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
