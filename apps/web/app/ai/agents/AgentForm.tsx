'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { api } from '../../../lib/api';
import MarkdownField from '../../../components/MarkdownField';

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
  heartbeatRetries?: number;
  heartbeatTimeout?: number;
  heartbeatErrorNotify?: boolean;
  heartbeatPrompt?: string;
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

// MD 编辑器统一复用全站标准组件 components/MarkdownField
// （MD / 浏览双 Tab + MD 导入，高度与 CrudPage 一致用 300）

// ── Tool checkbox item ───────────────────────────────────────────

function ToolCheckItem({ tool, checked, onToggle }: { tool: Tool; checked: boolean; onToggle: () => void }) {
  return (
    <div
      className={`tool-check-item${checked ? ' checked' : ''}`}
      onClick={onToggle}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={() => {}}
        onClick={(e) => e.stopPropagation()}
      />
      <div className="tool-check-info">
        <div className="tool-check-name">{tool.name}</div>
        <div className="tool-check-desc">{tool.description}</div>
      </div>
    </div>
  );
}

// ── Main Form Component ─────────────────────────────────────────

export function AgentForm({ initial, onDone }: { initial?: Agent; onDone: () => void }) {
  const t = useTranslations('ai.agents');
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
    heartbeatRetries: initial?.heartbeatRetries ?? 3,
    heartbeatTimeout: initial?.heartbeatTimeout ?? 60,
    heartbeatErrorNotify: initial?.heartbeatErrorNotify ?? true,
    heartbeatPrompt: initial?.heartbeatPrompt || '',
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
      setError(t('errName'));
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
        heartbeatRetries: form.heartbeatRetries ?? 3,
        heartbeatTimeout: form.heartbeatTimeout ?? 60,
        heartbeatErrorNotify: form.heartbeatErrorNotify ?? true,
        heartbeatPrompt: form.heartbeatPrompt || '',
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
          <MarkdownField
            height={300}
            label={`${t('tabAgent')} (Markdown)`}
            value={form.systemPrompt || ''}
            onChange={(v) => setForm({ ...form, systemPrompt: v })}
            placeholder="在此输入 / 粘贴 Markdown 内容..."
          />
        );

      case 'skill':
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <MarkdownField
              height={300}
              label={`${t('tabSkill')} (Markdown)`}
              value={form.description || ''}
              onChange={(v) => setForm({ ...form, description: v })}
              placeholder="# SKILL.md - 你能做什么..."
            />

            <div>
              <span className="form-label-text" style={{ display: 'block', marginBottom: 12 }}>
                {t('skillToolsHint')}
              </span>
              <div className="tool-grid">
                {tools.map((tool) => (
                  <ToolCheckItem
                    key={tool.name}
                    tool={tool}
                    checked={(form.toolList || []).includes(tool.name)}
                    onToggle={() => toggleTool(tool.name)}
                  />
                ))}
              </div>
              {tools.length === 0 && <span style={{ color: 'var(--fg-tertiary)', fontSize: 13 }}>{t('loadingTools')}</span>}
            </div>
          </div>
        );

      case 'heartbeat':
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            {/* Enable toggle */}
            <label className="heartbeat-enable">
              <input
                type="checkbox"
                checked={form.heartbeatEnabled ?? false}
                onChange={(e) => setForm({ ...form, heartbeatEnabled: e.target.checked })}
              />
              <span>{t('heartbeatEnable')}</span>
              <small>{t('heartbeatEnableHint')}</small>
            </label>

            {form.heartbeatEnabled && (
              <>
                <div className="form-grid">
                  <div className="form-label">
                    <span className="form-label-text">{t('hbAction')}</span>
                    <select
                      className="form-input"
                      value={form.heartbeatAction || '推送结果给用户'}
                      onChange={(e) => setForm({ ...form, heartbeatAction: e.target.value })}
                    >
                      <option value="推送结果给用户">{t('hbActionPush')}</option>
                      <option value="仅记忆">{t('hbActionMemory')}</option>
                      <option value="执行自定义任务">{t('hbActionCustom')}</option>
                    </select>
                  </div>

                  <div className="form-label">
                    <span className="form-label-text">{t('hbFrequency')}</span>
                    <select
                      className="form-input"
                      value={form.heartbeatFrequency || '每天'}
                      onChange={(e) => setForm({ ...form, heartbeatFrequency: e.target.value })}
                    >
                      <option value="每分钟">{t('hbFreqEveryMinute')}</option>
                      <option value="每5分钟">{t('hbFreqEvery5Min')}</option>
                      <option value="每15分钟">{t('hbFreqEvery15Min')}</option>
                      <option value="每30分钟">{t('hbFreqEvery30Min')}</option>
                      <option value="每小时">{t('hbFreqHourly')}</option>
                      <option value="每天">{t('hbFreqDaily')}</option>
                      <option value="每周">{t('hbFreqWeekly')}</option>
                      <option value="每月">{t('hbFreqMonthly')}</option>
                      <option value="自定义 Cron">{t('hbFreqCustom')}</option>
                    </select>
                  </div>

                  <div className="form-label">
                    <span className="form-label-text">{t('hbCron')}</span>
                    <input
                      className="form-input"
                      style={{ fontFamily: 'monospace', background: 'var(--bg-subtle)' }}
                      readOnly
                      value={
                        form.heartbeatFrequency === '自定义 Cron'
                          ? form.heartbeatCron || ''
                          : form.heartbeatEnabled
                            ? `${form.heartbeatMinute || '0'} ${form.heartbeatHour || '*'} * * *`
                            : ''
                      }
                      placeholder={t('hbCronAuto')}
                    />
                  </div>
                </div>

                {/* Hour + Minute (only for daily+ frequencies) */}
                {!['每分钟', '每5分钟', '每15分钟', '每30分钟', '每小时'].includes(form.heartbeatFrequency || '') && (
                  <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
                    <div className="form-label">
                      <span className="form-label-text">{t('hbHour')}</span>
                      <select
                        className="form-input"
                        value={form.heartbeatHour || '09'}
                        onChange={(e) => setForm({ ...form, heartbeatHour: e.target.value })}
                      >
                        {Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0')).map((h) => (
                          <option key={h} value={h}>{h}</option>
                        ))}
                      </select>
                    </div>
                    <div className="form-label">
                      <span className="form-label-text">{t('hbMinute')}</span>
                      <select
                        className="form-input"
                        value={form.heartbeatMinute || '00'}
                        onChange={(e) => setForm({ ...form, heartbeatMinute: e.target.value })}
                      >
                        {Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0')).map((m) => (
                          <option key={m} value={m}>{m}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                )}

                <div className="form-label">
                  <span className="form-label-text">{t('hbRecipients')}</span>
                  <input
                    className="form-input"
                    value={form.heartbeatRecipients || ''}
                    onChange={(e) => setForm({ ...form, heartbeatRecipients: e.target.value })}
                    placeholder={t('hbRecipientsPlaceholder')}
                  />
                </div>

                <div className="form-grid">
                  <div className="form-label">
                    <span className="form-label-text">{t('hbMaxRetries')}</span>
                    <select
                      className="form-input"
                      value={String(form.heartbeatRetries ?? 3)}
                      onChange={(e) => setForm({ ...form, heartbeatRetries: Number(e.target.value) })}
                    >
                      {[0, 1, 2, 3, 5].map((n) => (
                        <option key={n} value={n}>{n === 0 ? t('hbNoRetry') : t('hbRetryTimes', { n })}</option>
                      ))}
                    </select>
                  </div>

                  <div className="form-label">
                    <span className="form-label-text">{t('hbTimeout')}</span>
                    <select
                      className="form-input"
                      value={String(form.heartbeatTimeout ?? 60)}
                      onChange={(e) => setForm({ ...form, heartbeatTimeout: Number(e.target.value) })}
                    >
                      {[30, 60, 120, 300, 600].map((n) => (
                        <option key={n} value={n}>{n >= 60 ? t('hbTimeoutMin', { n: n / 60 }) : t('hbTimeoutSec', { n })}</option>
                      ))}
                    </select>
                  </div>

                  <div className="form-label">
                    <span className="form-label-text">{t('hbFailNotifyLabel')}</span>
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={form.heartbeatErrorNotify ?? true}
                        onChange={(e) => setForm({ ...form, heartbeatErrorNotify: e.target.checked })}
                      />
                      {t('hbFailNotify')}
                    </label>
                  </div>
                </div>

                <MarkdownField
                  height={300}
                  label={t('hbPrompt')}
                  value={form.heartbeatPrompt || ''}
                  onChange={(v) => setForm({ ...form, heartbeatPrompt: v })}
                  placeholder={t('hbPromptPlaceholder')}
                />
              </>
            )}
          </div>
        );

      case 'identity':
        return (
          <MarkdownField
            height={300}
            label={`${t('tabIdentity')} (Markdown)`}
            value={form.identityPrompt || ''}
            onChange={(v) => setForm({ ...form, identityPrompt: v })}
            placeholder={IDENTITY_DEFAULT.slice(0, 60) + '...'}
          />
        );

      case 'memory':
        return (
          <MarkdownField
            height={300}
            label={`${t('tabMemory')} (Markdown)`}
            value={form.memoryPrompt || ''}
            onChange={(v) => setForm({ ...form, memoryPrompt: v })}
            placeholder={MEMORY_DEFAULT.slice(0, 60) + '...'}
          />
        );

      case 'soul':
        return (
          <MarkdownField
            height={300}
            label={`${t('tabSoul')} (Markdown)`}
            value={form.soulPrompt || ''}
            onChange={(v) => setForm({ ...form, soulPrompt: v })}
            placeholder={SOUL_DEFAULT.slice(0, 60) + '...'}
          />
        );

      case 'user':
        return (
          <MarkdownField
            height={300}
            label={`${t('tabUser')} (Markdown)`}
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
    <>
      {/* 页头由 CrudPage 的 standaloneForm 提供，这里只渲染表单主体，避免重复显示 */}

      {/* Form card — matches crud-inline-form */}
      <fieldset className="form-fieldset">
        <legend className="form-legend">{t('legendBasic')}</legend>

        {/* Name + Provider row using form-grid */}
        <div className="form-grid" style={{ gridTemplateColumns: '1.2fr 1fr 1fr' }}>
          <div className="form-label">
            <span className="form-label-text">{t('name')}</span>
            <input
              className="form-input"
              value={form.name || ''}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder={t('namePlaceholder')}
            />
          </div>
          <div className="form-label">
            <span className="form-label-text">{t('providerPool')}</span>
            <select
              className="form-input"
              value={selectedProvider}
              onChange={(e) => setSelectedProvider(e.target.value)}
            >
              <option value="">{t('providerPoolDefault')}</option>
              {cfg?.provider && (
                <option value="__personal__">
                  {t('providerPoolMine', { provider: cfg.provider, model: cfg.model ? ` · ${cfg.model}` : '' })}
                </option>
              )}
              {presets.map((p) => (
                <option key={p.label} value={p.label}>{p.label}</option>
              ))}
            </select>
          </div>
          <div className="form-label">
            <span className="form-label-text">{t('model')}</span>
            <input
              className="form-input"
              value={cfg?.model || ''}
              readOnly
              placeholder={t('modelFollow')}
            />
          </div>
        </div>
      </fieldset>

      {/* Tab bar + content — inside a second fieldset */}
      <fieldset className="form-fieldset" style={{ marginTop: 'var(--space-md)' }}>
        {/* Tab navigation */}
        <div className="agent-tabs">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              className={`agent-tab${activeTab === t.key ? ' active' : ''}`}
              onClick={() => setActiveTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <form onSubmit={save}>
          <div style={{ paddingTop: 'var(--space-md)' }}>
            {renderTabContent()}
          </div>
          {error && <p className="msg-error" style={{ marginTop: 'var(--space-md)' }}>{error}</p>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 'var(--space-md)' }}>
            <button type="button" className="btn btn-ghost" onClick={onDone}>{t('cancel')}</button>
            <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? t('saving') : t('save')}</button>
          </div>
        </form>
      </fieldset>
    </>
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
