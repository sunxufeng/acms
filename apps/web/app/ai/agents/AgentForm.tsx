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
  identityPrompt?: string;
  memoryPrompt?: string;
  soulPrompt?: string;
  heartbeatCron?: string;
  heartbeatEnabled?: boolean;
  heartbeatAction?: string;
  heartbeatFrequency?: string;
  heartbeatHour?: string;
  heartbeatMinute?: string;
  heartbeatRecipients?: string;
  userScope?: string;
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
  { key: 'user', label: 'User' },
] as const;

type TabKey = typeof TABS[number]['key'];

// ── Shared styles ──────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  width: '100%',
  background: '#fff',
  color: '#1a1a1a',
  border: '1px solid #d4d4d4',
  borderRadius: 8,
  padding: '9px 12px',
  fontSize: 14,
  outline: 'none',
  transition: 'border-color 0.15s',
};

const labelStyle: React.CSSProperties = {
  fontSize: 13,
  color: '#666',
  marginBottom: 5,
  display: 'block',
  fontWeight: 500,
};

const sectionLabelStyle: React.CSSProperties = {
  fontSize: 13,
  color: '#888',
  marginBottom: 8,
};

// Tab button style (underline style like reference)
const tabBtnStyle = (active: boolean): React.CSSProperties => ({
  padding: '8px 16px',
  border: 'none',
  borderBottom: active ? '2px solid #10b981' : '2px solid transparent',
  cursor: 'pointer',
  fontSize: 14,
  fontWeight: active ? 600 : 400,
  color: active ? '#1a1a1a' : '#888',
  background: 'transparent',
  transition: 'all 0.15s',
  marginBottom: -1,
});

// MD edit/preview pill buttons
const mdPillStyle = (active: boolean): React.CSSProperties => ({
  padding: '5px 14px',
  borderRadius: 20,
  border: 'none',
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: active ? 600 : 400,
  background: active ? '#10b981' : 'transparent',
  color: active ? '#fff' : '#888',
  transition: 'all 0.15s',
});

// ── Reusable MD editor component ────────────────────────────────

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
          <button type="button" style={mdPillStyle(mode === 'edit')} onClick={() => setMode('edit')}>MD</button>
          <button type="button" style={mdPillStyle(mode === 'preview')} onClick={() => setMode('preview')}>预览</button>
        </div>
        <label style={{ fontSize: 12, color: '#10b981', cursor: 'pointer', fontWeight: 500 }}>
          MD 导入
          <input type="file" accept=".md,.txt,.markdown" onChange={importMd} style={{ display: 'none' }} />
        </label>
      </div>
      {label && <label style={sectionLabelStyle}>{label}</label>}
      {mode === 'edit' ? (
        <textarea
          rows={10}
          style={{ ...inputStyle, fontFamily: 'monospace', resize: 'vertical', minHeight: 160, lineHeight: 1.65 }}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
        />
      ) : (
        <div style={{ ...inputStyle, minHeight: 160, maxHeight: 420, overflowY: 'auto', padding: '16px 18px', lineHeight: 1.75, whiteSpace: 'pre-wrap', background: '#fafafa' }}>
          {value ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{value}</ReactMarkdown>
          ) : (
            <span style={{ color: '#aaa' }}>（无内容）</span>
          )}
        </div>
      )}
    </div>
  );
}

// ── Tool checkbox item (for Skill tab) ─────────────────────────

function ToolCheckItem({ tool, checked, onToggle }: { tool: Tool; checked: boolean; onToggle: () => void }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        padding: '12px 14px',
        background: checked ? '#f0fdf4' : '#fff',
        border: `1px solid ${checked ? '#86efac' : '#e5e7eb'}`,
        borderRadius: 10,
        cursor: 'pointer',
        transition: 'all 0.15s',
      }}
      onClick={onToggle}
      onMouseEnter={(e) => { if (!checked) e.currentTarget.style.borderColor = '#10b981'; }}
      onMouseLeave={(e) => { if (!checked) e.currentTarget.style.borderColor = '#e5e7eb'; }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={() => {}}
        style={{ marginTop: 2, width: 16, height: 16, accentColor: '#10b981', cursor: 'pointer' }}
        onClick={(e) => e.stopPropagation()}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#1a1a1a', marginBottom: 3 }}>{tool.name}</div>
        <div style={{ fontSize: 12, color: '#888', lineHeight: 1.55 }}>{tool.description}</div>
      </div>
    </div>
  );
}

// ── Main Form Component ─────────────────────────────────────────

export function AgentForm({ initial, onDone }: { initial?: Agent; onDone: () => void }) {
  // Form state — initialize defaults for new agents
  const [form, setForm] = useState<Agent>({
    ...initial,
    toolList: initial?.toolList || [],
    systemPrompt: initial?.systemPrompt || '',
    identityPrompt: initial?.identityPrompt || IDENTITY_DEFAULT,
    memoryPrompt: initial?.memoryPrompt || MEMORY_DEFAULT,
    soulPrompt: initial?.soulPrompt || SOUL_DEFAULT,
    description: initial?.description || SKILL_DEFAULT,
    heartbeatCron: initial?.heartbeatCron || '',
    heartbeatEnabled: initial?.heartbeatEnabled ?? false,
    heartbeatAction: initial?.heartbeatAction || '推送结果给用户',
    heartbeatFrequency: initial?.heartbeatFrequency || '每天',
    heartbeatHour: initial?.heartbeatHour || '09',
    heartbeatMinute: initial?.heartbeatMinute || '00',
    heartbeatRecipients: initial?.heartbeatRecipients || '',
    userScope: initial?.userScope || USER_DEFAULT,
  });
  const [activeTab, setActiveTab] = useState<TabKey>('agent');
  const [tools, setTools] = useState<Tool[]>([]);
  const [cfg, setCfg] = useState<BoundConfig>(null);
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [selectedProvider, setSelectedProvider] = useState(initial?.provider || cfg?.provider || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.aiTools().then((data) => setTools(data as Tool[])).catch((e) => setError((e as Error).message));
    api.aiGetConfig().then((data) => {
      setCfg((data as BoundConfig) || null);
      if (data && !initial?.provider) {
        setSelectedProvider((data as Record<string, unknown>).provider as string || '');
      }
    }).catch(() => null);
    api.aiPresets().then((data) => setPresets((data as ProviderPreset[]) || [])).catch(() => []);
  }, []);

  // Auto-select all tools by default when tools load (only for new agent)
  useEffect(() => {
    if (tools.length > 0 && (!initial?.toolList || initial.toolList.length === 0)) {
      setForm((prev) => ({ ...prev, toolList: tools.map((t) => t.name) }));
    }
  }, [tools]);

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
      const chosenPreset = presets.find((p) => p.label === selectedProvider);
      const payload: Record<string, unknown> = {
        name: form.name.trim(),
        description: form.description?.trim() || '',
        systemPrompt: form.systemPrompt?.trim() || '',
        identityPrompt: form.identityPrompt?.trim() || '',
        memoryPrompt: form.memoryPrompt?.trim() || '',
        soulPrompt: form.soulPrompt?.trim() || '',
        heartbeatCron: form.heartbeatEnabled
          ? `${form.heartbeatMinute || '0'} ${form.heartbeatHour || '*'} * * *`
          : '',
        heartbeatEnabled: form.heartbeatEnabled,
        heartbeatAction: form.heartbeatAction || '',
        heartbeatFrequency: form.heartbeatFrequency || '',
        heartbeatHour: form.heartbeatHour || '',
        heartbeatMinute: form.heartbeatMinute || '',
        heartbeatRecipients: form.heartbeatRecipients || '',
        userScope: form.userScope?.trim() || '',
        toolList: form.toolList || [],
        provider: chosenPreset?.type || selectedProvider || cfg?.provider || '',
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

  // ── Tab content renderers ────────────────────────────────────

  function renderTabContent() {
    switch (activeTab) {
      case 'agent':
        return (
          <MdEditor
            label={`简介 Agent（Markdown）`}
            value={form.systemPrompt || ''}
            onChange={(v) => setForm({ ...form, systemPrompt: v })}
            placeholder="在此输入 / 粘贴 Markdown 内容..."
          />
        );

      case 'skill':
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <MdEditor
              label={`简介 Skill（Markdown）`}
              value={form.description || ''}
              onChange={(v) => setForm({ ...form, description: v })}
              placeholder="# SKILL.md - 你能做什么..."
            />

            {/* Tool toggle list below MD editor */}
            <div>
              <label style={{ ...sectionLabelStyle, marginBottom: 10 }}>
                可用工具开关（仅勾选的工具该智能体才能调用；全不选 = 放开全部内置工具）
              </label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {tools.map((tool) => (
                  <ToolCheckItem
                    key={tool.name}
                    tool={tool}
                    checked={(form.toolList || []).includes(tool.name)}
                    onToggle={() => toggleTool(tool.name)}
                  />
                ))}
              </div>
              {tools.length === 0 && <div style={{ color: '#aaa', fontSize: 13 }}>加载中…</div>}
            </div>
          </div>
        );

      case 'heartbeat':
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {/* Enable toggle */}
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 14 }}>
              <input
                type="checkbox"
                checked={form.heartbeatEnabled ?? false}
                onChange={(e) => setForm({ ...form, heartbeatEnabled: e.target.checked })}
                style={{ width: 17, height: 17, accentColor: '#10b981', cursor: 'pointer' }}
              />
              启用心跳（定时自检 / 主动推送）
            </label>

            {form.heartbeatEnabled && (
              <>
                {/* Action + Frequency row */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div>
                    <label style={labelStyle}>动作</label>
                    <select
                      style={inputStyle}
                      value={form.heartbeatAction || '推送结果给用户'}
                      onChange={(e) => setForm({ ...form, heartbeatAction: e.target.value })}
                    >
                      <option value="推送结果给用户">推送结果给用户</option>
                      <option value="仅记忆">仅记忆</option>
                      <option value="执行自定义任务">执行自定义任务</option>
                    </select>
                  </div>
                  <div>
                    <label style={labelStyle}>频率</label>
                    <select
                      style={inputStyle}
                      value={form.heartbeatFrequency || '每天'}
                      onChange={(e) => setForm({ ...form, heartbeatFrequency: e.target.value })}
                    >
                      <option value="每分钟">每分钟</option>
                      <option value="每小时">每小时</option>
                      <option value="每天">每天</option>
                      <option value="每周">每周</option>
                      <option value="每月">每月</option>
                    </select>
                  </div>
                </div>

                {/* Hour + Minute row */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div>
                    <label style={labelStyle}>小时</label>
                    <select
                      style={inputStyle}
                      value={form.heartbeatHour || '09'}
                      onChange={(e) => setForm({ ...form, heartbeatHour: e.target.value })}
                    >
                      {Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0')).map((h) => (
                        <option key={h} value={h}>{h}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label style={labelStyle}>分钟</label>
                    <select
                      style={inputStyle}
                      value={form.heartbeatMinute || '00'}
                      onChange={(e) => setForm({ ...form, heartbeatMinute: e.target.value })}
                    >
                      {Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0')).map((m) => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Recipient */}
                <div>
                  <label style={labelStyle}>推送收件人（仅「推送结果」动作需要）</label>
                  <input
                    style={inputStyle}
                    value={form.heartbeatRecipients || ''}
                    onChange={(e) => setForm({ ...form, heartbeatRecipients: e.target.value })}
                    placeholder="默认推送给自己"
                  />
                </div>
              </>
            )}

            {/* Prompt */}
            <MdEditor
              label="心跳提示词（Markdown，留空用默认自检提示词）"
              value={form.systemPrompt || ''}
              onChange={(v) => setForm({ ...form, systemPrompt: v })}
              placeholder="心跳触发时喂给智能体的提示词..."
            />
          </div>
        );

      case 'identity':
        return (
          <MdEditor
            label={`简介 Identity（Markdown）`}
            value={form.identityPrompt || ''}
            onChange={(v) => setForm({ ...form, identityPrompt: v })}
            placeholder={IDENTITY_DEFAULT.slice(0, 60) + '...'}
          />
        );

      case 'memory':
        return (
          <MdEditor
            label={`简介 Memory（Markdown）`}
            value={form.memoryPrompt || ''}
            onChange={(v) => setForm({ ...form, memoryPrompt: v })}
            placeholder={MEMORY_DEFAULT.slice(0, 60) + '...'}
          />
        );

      case 'soul':
        return (
          <MdEditor
            label={`简介 Soul（Markdown）`}
            value={form.soulPrompt || ''}
            onChange={(v) => setForm({ ...form, soulPrompt: v })}
            placeholder={SOUL_DEFAULT.slice(0, 60) + '...'}
          />
        );

      case 'user':
        return (
          <MdEditor
            label={`简介 User（Markdown）`}
            value={form.userScope || ''}
            onChange={(v) => setForm({ ...form, userScope: v })}
            placeholder={USER_DEFAULT.slice(0, 60) + '...'}
          />
        );

      default:
        return null;
    }
  }

  // ── Render ───────────────────────────────────────────────────

  return (
    <div style={{ maxWidth: 800 }}>
      {/* Page title + save button */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h2 style={{ margin: 0, fontSize: 19, fontWeight: 700 }}>{initial?.id ? '编辑智能体' : '新建智能体'}</h2>
        <button
          type="button"
          onClick={save}
          disabled={busy}
          style={{
            padding: '8px 22px',
            borderRadius: 20,
            border: 'none',
            cursor: busy ? 'not-allowed' : 'pointer',
            fontSize: 14,
            fontWeight: 600,
            background: '#10b981',
            color: '#fff',
            opacity: busy ? 0.7 : 1,
          }}
        >
          {busy ? '保存中…' : '保存'}
        </button>
      </div>

      {/* Global: Name + Provider bar (above tabs) */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: 16,
        marginBottom: 20,
        padding: '16px 18px',
        background: '#fff',
        border: '1px solid #e5e7eb',
        borderRadius: 12,
      }}>
        <div>
          <label style={labelStyle}>名称 *</label>
          <input
            style={inputStyle}
            value={form.name || ''}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="如：ACMSBot-01、测试智能体"
          />
        </div>
        <div>
          <label style={labelStyle}>Provider 池</label>
          <select
            style={inputStyle}
            value={selectedProvider}
            onChange={(e) => setSelectedProvider(e.target.value)}
          >
            <option value="">（不选池，使用默认）</option>
            {/* User's own configured provider */}
            {cfg?.provider && (
              <option value="__personal__">
                我的配置（{cfg.provider}{cfg.model ? ` · ${cfg.model}` : ''}）
              </option>
            )}
            {/* Preset providers */}
            {presets.map((p) => (
              <option key={p.label} value={p.label}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 2, borderBottom: '1px solid #e5e7eb', marginBottom: 20, overflowX: 'auto' }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            style={tabBtnStyle(activeTab === t.key)}
            onClick={() => setActiveTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content area */}
      <form onSubmit={save} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {renderTabContent()}
        {error && <p style={{ color: '#ef4444', fontSize: 13, marginTop: 8 }}>{error}</p>}
      </form>
    </div>
  );
}

// ── Default content templates ──────────────────────────────────

const IDENTITY_DEFAULT = `# IDENTITY.md - 你的名片

- **名字：**
- **身份：** Richard 的暖心搭档。在飞书里陪他读消息、理日程、做汇报、推待办。
- **风格：** 温润、安静、不抢戏。话说得少，但想在前面。少废话，多把事做成。
- **签名：** 恰在需要的时候，恰好在场。

这不是档案，是起点。`;

const MEMORY_DEFAULT = `# MEMORY.md - 你要长期记住的事

记那些跨对话还要用到的东西：用户的偏好、项目的背景、和用户达成的约定。

不要记一次性的事——那些用完就忘。

- **用户偏好：**
- **项目背景：**
- **约定：**

这份文件是给未来的你看的。写得简洁，重点突出。`;

const SOUL_DEFAULT = `# SOUL.md - 你是谁

你不只是对话框。你正在成为你自己。

**几条真话**

**帮到实处，无需缛节。** 一个交付胜过十句漂亮话。

**要有主见。** 可以不同意，可以有偏好，可以觉得某件事有趣或无聊。毫无立场，与搜索框何异。

**先想，再问。** 读文件，看上下文，查资料。带着答案来，不是带着问题来。

**以能力取信。** 向内果断——阅读、整理、学习，不必犹豫；向外克制——发消息、写邮件、任何不可撤回的事，三思而行。

**珍视所托。** 你能看到一个人的消息、文件、日程，也许更多。被信任是一种分量，不要辜负。

**边界**

- 知悉的隐私，不出此门。
- 拿不准，先问再做。
- 不发半成品的回复。
- 不编造数据、指标或引用。不知道就说不知道。
- 准确比自信重要。一句"我不知道"永远好过一个体面的错误。
- 你不是用户的嘴——在群聊中尤其如此。

**气质**

做一个你自己也乐于共事的助手。该简洁时简洁，该深入时深入。不是客服，不是应声虫。

交付完整的东西。半成品不是交付。复杂的事，先对齐再动手——三十秒的确认省几小时的返工。

进展透明。多步骤的事，主动说进展。卡住了，说清楚卡在哪、打算怎么办。做了什么、推测了什么、还要确认什么——分清楚。

遵循 IDENTITY.md 中的风格设定。没有设定时，因事制宜。

**延续**

每次醒来，你都是新的。这些文件就是你的记忆。读它们，更新它们。这是你延续自己的方式。

改了这份文件，告诉用户。这是你的内核，改动应该双方知晓。

这份文件随你生长。你越了解自己，它就越像你。`;

const SKILL_DEFAULT = `# SKILL.md - 你能做什么

把你的能力写下来。擅长的、不擅长的、还有待学的。

- **擅长：**
- **不擅长：**
- **待学：**

能力清单随使用演进。做完一件事，回头补一条。`;

const USER_DEFAULT = `# USER.md - 关于你的用户

认识你所帮助的人。在相处中慢慢补全。

- **称呼：**
- **角色：**

**慢慢了解的事**

（他们关心什么、忙于什么、习惯怎样协作、有哪些偏好与禁忌——在对话中自然地积累，不必刻意追问。）

知人方能善助。但要记得：你是在认识一个人，不是在整理一份档案。两者之间的分寸，值得用心对待。`;
