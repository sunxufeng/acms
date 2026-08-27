'use client';

import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

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
  // Extended fields for richer editing
  identityPrompt?: string;   // Identity tab
  memoryPrompt?: string;     // Memory tab
  soulPrompt?: string;       // Soul tab
  heartbeatCron?: string;    // Heartbeat tab
  userScope?: string;        // User tab
};

type Tool = { name: string; description: string };
type BoundConfig = { provider?: string; model?: string; baseUrl?: string; hasApiKey?: boolean } | null;
type ProviderPreset = { type: string; label: string; defaultBaseUrl: string; sampleModels: string; hint: string };

const TABS = [
  { key: 'agent', label: 'Agent' },
  { key: 'skill', label: 'Skill' },
  { key: 'heartbeat', label: 'Heartbeat' },
  { key: 'identity', label: 'Identity' },
  { key: 'memory', label: 'Memory' },
  { key: 'soul', label: 'Soul' },
  { key: 'tools', label: 'Tools' },
  { key: 'user', label: 'User' },
] as const;

type TabKey = typeof TABS[number]['key'];

const fieldStyle: React.CSSProperties = {
  width: '100%',
  background: 'var(--bg-tertiary)',
  color: 'var(--text)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  padding: '8px 10px',
  fontSize: 13,
};

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--text-muted)',
  marginBottom: 4,
  display: 'block',
};

const tabBtnStyle = (active: boolean): React.CSSProperties => ({
  padding: '6px 16px',
  borderRadius: 20,
  border: 'none',
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: active ? 600 : 400,
  background: active ? '#10b981' : 'transparent',
  color: active ? '#fff' : 'var(--text-muted)',
  transition: 'all 0.15s',
});

// Reusable MD editor component with edit/preview tabs + MD import
function MdEditor({ value, onChange, placeholder, label }: { value: string; onChange: (v: string) => void; placeholder?: string; label?: string }) {
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');

  async function importMd(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const text = await f.text();
    onChange(text);
    e.target.value = '';
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <div style={{ display: 'flex', gap: 4 }}>
          <button type="button" style={tabBtnStyle(mode === 'edit')} onClick={() => setMode('edit')}>编辑</button>
          <button type="button" style={tabBtnStyle(mode === 'preview')} onClick={() => setMode('preview')}>预览</button>
        </div>
        <label style={{ fontSize: 12, color: 'var(--accent)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
          导入 MD
          <input type="file" accept=".md,.txt,.markdown" onChange={importMd} style={{ display: 'none' }} />
        </label>
      </div>
      {label && <label style={labelStyle}>{label}</label>}
      {mode === 'edit' ? (
        <textarea
          className="form-input"
          rows={10}
          style={{ ...fieldStyle, fontFamily: 'monospace', resize: 'vertical', minHeight: 160 }}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
        />
      ) : (
        <div style={{ ...fieldStyle, minHeight: 160, maxHeight: 400, overflowY: 'auto', padding: '14px 16px', lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>
          {value ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{value}</ReactMarkdown>
          ) : (
            <span style={{ color: 'var(--text-muted)' }}>（无内容）</span>
          )}
        </div>
      )}
    </div>
  );
}

export function AgentForm({ initial, onDone }: { initial?: Agent; onDone: () => void }) {
  const [form, setForm] = useState<Agent>({
    ...initial,
    toolList: initial?.toolList || [],
    systemPrompt: initial?.systemPrompt || '',
    identityPrompt: initial?.identityPrompt || '',
    memoryPrompt: initial?.memoryPrompt || '',
    soulPrompt: initial?.soulPrompt || '',
    heartbeatCron: initial?.heartbeatCron || '',
    userScope: initial?.userScope || '',
  });
  const [activeTab, setActiveTab] = useState<TabKey>('agent');
  const [tools, setTools] = useState<Tool[]>([]);
  const [cfg, setCfg] = useState<BoundConfig>(null);
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [selectedProviderLabel, setSelectedProviderLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.aiTools().then((data) => setTools(data as Tool[])).catch((e) => setError((e as Error).message));
    api.aiGetConfig().then((data) => {
      setCfg((data as BoundConfig) || null);
      // If agent already has provider info, try to match to a preset label
      if (data && (data as Record<string, unknown>).provider) {
        setSelectedProviderLabel((data as Record<string, unknown>).provider as string || '');
      }
    }).catch(() => null);
    api.aiPresets().then((data) => setPresets((data as ProviderPreset[]) || [])).catch(() => []);
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
    // Find the selected preset to get provider type + baseUrl
    const chosenPreset = presets.find((p) => p.label === selectedProviderLabel);
    const provider = chosenPreset?.type || cfg?.provider || '';
    if (!provider) {
      setError('请选择一个 Provider，或先在「AI 设置」中配置可用模型。');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const payload = {
        name: form.name.trim(),
        description: form.description?.trim() || '',
        systemPrompt: form.systemPrompt?.trim() || '',
        identityPrompt: form.identityPrompt?.trim() || '',
        memoryPrompt: form.memoryPrompt?.trim() || '',
        soulPrompt: form.soulPrompt?.trim() || '',
        heartbeatCron: form.heartbeatCron?.trim() || '',
        userScope: form.userScope?.trim() || '',
        toolList: form.toolList || [],
        provider,
        model: cfg?.model || '',
        baseUrl: chosenPreset?.defaultBaseUrl || cfg?.baseUrl || '',
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

  function renderTabContent() {
    switch (activeTab) {
      case 'agent':
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, alignItems: 'start' }}>
              <div>
                <label style={labelStyle}>名称 *</label>
                <input className="form-input" style={fieldStyle} value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="如：ACMSBot-01、测试智能体" />
              </div>
              <div>
                <label style={labelStyle}>Provider 池</label>
                <select
                  className="form-input"
                  style={fieldStyle}
                  value={selectedProviderLabel}
                  onChange={(e) => setSelectedProviderLabel(e.target.value)}
                >
                  <option value="">（不选池，使用默认）</option>
                  {presets.map((p) => (
                    <option key={p.label} value={p.label}>
                      {p.label}{cfg?.model && p.label === selectedProviderLabel ? ` · ${cfg.model}` : ''}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <MdEditor
              label={`简介 ${activeTab}（Markdown）`}
              value={form.systemPrompt || ''}
              onChange={(v) => setForm({ ...form, systemPrompt: v })}
              placeholder="一句话简介（支持 **加粗** / 列表 / 链接 等 Markdown）。点「导入 MD」可载入 .md 文件。"
            />
          </div>
        );

      case 'skill':
        return (
          <MdEditor
            label={`简介 ${activeTab}（Markdown）`}
            value={form.description || ''}
            onChange={(v) => setForm({ ...form, description: v })}
            placeholder="# AGENTS.md — 你的工作空间\n\n这是家，善待它。\n\n## 首次启动\n\n如果 `BOOTSTRAP.md` 存在，那是你的出生证明..."
          />
        );

      case 'identity':
        return (
          <MdEditor
            label={`简介 ${activeTab}（Markdown）`}
            value={form.identityPrompt || ''}
            onChange={(v) => setForm({ ...form, identityPrompt: v })}
            placeholder="定义智能体的身份设定：你是谁？你的角色、语气、知识边界..."
          />
        );

      case 'memory':
        return (
          <MdEditor
            label={`简介 ${activeTab}（Markdown）`}
            value={form.memoryPrompt || ''}
            onChange={(v) => setForm({ ...form, memoryPrompt: v })}
            placeholder="记忆管理规则：什么该记住、什么该遗忘、记忆的格式与触发条件..."
          />
        );

      case 'soul':
        return (
          <MdEditor
            label={`简介 ${activeTab}（Markdown）`}
            value={form.soulPrompt || ''}
            onChange={(v) => setForm({ ...form, soulPrompt: v })}
            placeholder="灵魂/性格层：价值观、决策偏好、情感倾向、独特表达方式..."
          />
        );

      case 'heartbeat':
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <label style={labelStyle}>心跳 Cron 表达式</label>
            <input className="form-input" style={fieldStyle} value={form.heartbeatCron || ''} onChange={(e) => setForm({ ...form, heartbeatCron: e.target.value })} placeholder="如：0 */30 * * * （每30分钟一次），留空则不启用心跳" />
            <MdEditor
              label="心跳提示词（每次心跳执行时发送给模型的指令）"
              value={form.systemPrompt || ''}
              onChange={(v) => setForm({ ...form, systemPrompt: v })}
              placeholder="心跳任务的内容描述..."
            />
          </div>
        );

      case 'tools':
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>不选择时允许使用全部工具。</p>
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
          </div>
        );

      case 'user':
        return (
          <MdEditor
            label={`简介 ${activeTab}（Markdown）`}
            value={form.userScope || ''}
            onChange={(v) => setForm({ ...form, userScope: v })}
            placeholder="用户权限范围、可见数据边界、个性化规则..."
          />
        );

      default:
        return null;
    }
  }

  return (
    <div>
      {/* Header bar — no back button (breadcrumb already has one) */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>{initial?.id ? '编辑智能体' : '新建智能体'}</h2>
        <button type="button" onClick={save} disabled={busy} style={{ ...tabBtnStyle(true), padding: '7px 20px' }}>
          {busy ? '保存中…' : '保存'}
        </button>
      </div>

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 2, borderBottom: '1px solid var(--border)', marginBottom: 18, overflowX: 'auto', flexWrap: 'wrap' }}>
        {TABS.map((t) => (
          <button key={t.key} type="button" style={{
            padding: '8px 14px',
            border: 'none',
            borderBottom: activeTab === t.key ? '2px solid #10b981' : '2px solid transparent',
            cursor: 'pointer',
            fontSize: 13,
            fontWeight: activeTab === t.key ? 600 : 400,
            color: activeTab === t.key ? 'var(--text)' : 'var(--text-muted)',
            background: 'transparent',
            transition: 'all 0.15s',
            marginBottom: -1,
          }} onClick={() => setActiveTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <form onSubmit={save} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {renderTabContent()}
        {error && <p className="msg-error">{error}</p>}
      </form>
    </div>
  );
}
