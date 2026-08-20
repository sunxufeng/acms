'use client';

import { useEffect, useRef, useState } from 'react';
import { api, type SessionUser } from '../../../lib/api';

type Msg = { role: 'user' | 'assistant' | 'system'; content: string };
type Preset = { type: string; label: string; defaultBaseUrl: string; sampleModels: string; hint: string };
type Cfg = {
  provider?: string;
  baseUrl?: string;
  model?: string;
  botName?: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  hasApiKey?: boolean;
  displayName?: string;
  [k: string]: unknown;
};

const wrap: React.CSSProperties = {
  display: 'flex',
  height: 'calc(100vh - 120px)',
  gap: 12,
};
const panel: React.CSSProperties = {
  background: 'var(--bg-secondary)',
  border: '1px solid var(--border)',
  borderRadius: 10,
  overflow: 'hidden',
};
const btn = (primary = false): React.CSSProperties => ({
  background: primary ? 'var(--accent)' : 'transparent',
  color: primary ? '#fff' : 'var(--text)',
  border: primary ? 'none' : '1px solid var(--border)',
  borderRadius: 8,
  padding: '7px 14px',
  cursor: 'pointer',
  fontSize: 13,
});

export default function AiChatPage() {
  const [me, setMe] = useState<SessionUser | null>(null);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [config, setConfig] = useState<Cfg | null>(null);
  const [convs, setConvs] = useState<{ id: string; title: string; updatedAt: string }[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const [testMsg, setTestMsg] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  const isAdmin = !!me?.roles?.includes('系统管理员');

  useEffect(() => {
    api.me().then(setMe).catch(() => null);
    api.aiPresets().then((p) => setPresets(p as Preset[])).catch(() => null);
    api.aiGetConfig().then(setConfig).catch(() => null);
    api.aiListConversations().then(setConvs).catch(() => null);
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 1e9, behavior: 'smooth' });
  }, [messages]);

  async function send() {
    const text = input.trim();
    if (!text || sending) return;
    setInput('');
    const next = [...messages, { role: 'user' as const, content: text }];
    setMessages(next);
    setSending(true);
    try {
      const r = await api.aiChat({ message: text, sessionId: sessionId ?? undefined, history: next });
      setMessages([...next, { role: 'assistant' as const, content: r.content }]);
      if (r.sessionId && !sessionId) setSessionId(r.sessionId);
      api.aiListConversations().then(setConvs).catch(() => null);
    } catch (e) {
      setMessages([...next, { role: 'assistant' as const, content: `⚠️ ${e instanceof Error ? e.message : String(e)}` }]);
    } finally {
      setSending(false);
    }
  }

  async function newChat() {
    try {
      const r = await api.aiCreateConversation({ title: '新对话' });
      setSessionId(r.id);
      setMessages([]);
      api.aiListConversations().then(setConvs).catch(() => null);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  }

  async function openConv(id: string) {
    setSessionId(id);
    try {
      const h = await api.aiGetConversation(id);
      setMessages(h as Msg[]);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div>
          <h2 style={{ margin: 0 }}>AI 对话</h2>
          <small style={{ color: 'var(--text-muted)' }}>基于你个人配置的模型网关；未配置则请先在「模型设置」中填写 Provider / API Key / Model。</small>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button style={btn()} onClick={newChat}>＋ 新对话</button>
          <button style={btn()} onClick={() => setDrawer(true)}>⚙ 模型设置</button>
        </div>
      </div>

      <div style={wrap}>
        {/* 会话列表 */}
        <div style={{ ...panel, width: 240, flexShrink: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)', fontWeight: 600, fontSize: 13 }}>对话历史</div>
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {convs.length === 0 && <div style={{ padding: 12, color: 'var(--text-muted)', fontSize: 13 }}>暂无对话</div>}
            {convs.map((c) => (
              <div
                key={c.id}
                onClick={() => openConv(c.id)}
                style={{
                  padding: '10px 12px',
                  cursor: 'pointer',
                  borderBottom: '1px solid var(--border)',
                  background: c.id === sessionId ? 'var(--bg-hover)' : 'transparent',
                  fontSize: 13,
                }}
              >
                <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.title || '未命名'}</div>
                <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>{c.updatedAt?.slice(0, 16) || ''}</div>
              </div>
            ))}
          </div>
        </div>

        {/* 对话区 */}
        <div style={{ ...panel, flex: 1, display: 'flex', flexDirection: 'column' }}>
          <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
            {messages.length === 0 && (
              <div style={{ color: 'var(--text-muted)', margin: 'auto', textAlign: 'center' }}>
                开始与你的 AI 助手对话吧。支持天气、联网搜索、网页总结等实时能力。
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
                <div
                  style={{
                    maxWidth: '78%',
                    background: m.role === 'user' ? 'var(--accent)' : 'var(--bg-tertiary)',
                    color: m.role === 'user' ? '#fff' : 'var(--text)',
                    padding: '10px 14px',
                    borderRadius: 12,
                    whiteSpace: 'pre-wrap',
                    fontSize: 14,
                    lineHeight: 1.6,
                  }}
                >
                  {m.content}
                </div>
              </div>
            ))}
            {sending && <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>思考中…</div>}
          </div>
          <div style={{ borderTop: '1px solid var(--border)', padding: 12, display: 'flex', gap: 8 }}>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
              placeholder="输入消息，Enter 发送，Shift+Enter 换行"
              style={{ flex: 1, resize: 'none', height: 44, background: 'var(--bg-tertiary)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 8, padding: 10, fontSize: 14 }}
            />
            <button style={btn(true)} disabled={sending} onClick={send}>{sending ? '发送中' : '发送'}</button>
          </div>
        </div>
      </div>

      {drawer && (
        <ConfigDrawer
          presets={presets}
          config={config}
          isAdmin={isAdmin}
          onClose={() => setDrawer(false)}
          onSaved={(c) => { setConfig(c); setSaveMsg('已保存'); setTimeout(() => setSaveMsg(''), 2000); }}
          saveMsg={saveMsg}
          testMsg={testMsg}
          setTestMsg={setTestMsg}
        />
      )}
    </div>
  );
}

function ConfigDrawer({
  presets, config, isAdmin, onClose, onSaved, saveMsg, testMsg, setTestMsg,
}: {
  presets: Preset[]; config: Cfg | null; isAdmin: boolean; onClose: () => void;
  onSaved: (c: Cfg) => void; saveMsg: string; testMsg: string; setTestMsg: (s: string) => void;
}) {
  const [form, setForm] = useState<Cfg>(() => ({
    provider: config?.provider || presets[0]?.type || 'openai',
    baseUrl: config?.baseUrl || presets[0]?.defaultBaseUrl || '',
    apiKey: '',
    model: config?.model || '',
    botName: config?.botName || '',
    systemPrompt: config?.systemPrompt || '',
    temperature: config?.temperature ?? 0.7,
    maxTokens: config?.maxTokens ?? 2048,
  }));
  const [busy, setBusy] = useState(false);
  const [orgDefault, setOrgDefault] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    if (isAdmin) api.aiGetOrgDefault().then(setOrgDefault).catch(() => null);
  }, [isAdmin]);

  function pickPreset(label: string) {
    const p = presets.find((x) => x.label === label);
    if (p) setForm((f) => ({ ...f, provider: p.type, baseUrl: p.defaultBaseUrl }));
  }

  async function save() {
    setBusy(true);
    try {
      const payload: Record<string, unknown> = { ...form };
      if (!payload.apiKey) delete payload.apiKey; // 留空 = 沿用已存
      const c = await api.aiSaveConfig(payload);
      onSaved(c as Cfg);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function del() {
    if (!confirm('确认清除你的模型配置（API Key 将被删除）？')) return;
    try { await api.aiDeleteConfig(); onSaved({} as Cfg); } catch (e) { alert(e instanceof Error ? e.message : String(e)); }
  }

  async function test() {
    setTestMsg('测试中…');
    try {
      const r = await api.aiTestConfig(form);
      setTestMsg(r.ok ? '✅ 连接成功' : '❌ ' + (r.error || '连接失败'));
    } catch (e) { setTestMsg('❌ ' + (e instanceof Error ? e.message : String(e))); }
  }

  async function saveOrg() {
    if (!orgDefault) return;
    try { await api.aiSaveOrgDefault(orgDefault); alert('组织默认配置已保存'); } catch (e) { alert(e instanceof Error ? e.message : String(e)); }
  }

  const field: React.CSSProperties = { width: '100%', background: 'var(--bg-tertiary)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', fontSize: 13, marginBottom: 10 };
  const label: React.CSSProperties = { fontSize: 12, color: 'var(--text-muted)', marginBottom: 4, display: 'block' };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', justifyContent: 'flex-end', zIndex: 50 }} onClick={onClose}>
      <div style={{ width: 440, height: '100%', background: 'var(--bg-secondary)', overflowY: 'auto', padding: 20 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h3 style={{ margin: 0 }}>模型设置</h3>
          <button style={btn()} onClick={onClose}>关闭</button>
        </div>

        <div style={{ marginBottom: 8 }}>
          <label style={label}>预设厂商</label>
          <select style={field} value={presets.find((p) => p.type === form.provider)?.label || ''} onChange={(e) => pickPreset(e.target.value)}>
            <option value="">自定义</option>
            {presets.map((p) => <option key={p.label} value={p.label}>{p.label}</option>)}
          </select>
        </div>
        <div style={{ marginBottom: 8 }}>
          <label style={label}>Provider 类型</label>
          <input style={field} value={form.provider || ''} onChange={(e) => setForm({ ...form, provider: e.target.value })} />
        </div>
        <div style={{ marginBottom: 8 }}>
          <label style={label}>Base URL</label>
          <input style={field} value={form.baseUrl || ''} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />
        </div>
        <div style={{ marginBottom: 8 }}>
          <label style={label}>API Key {config?.hasApiKey ? '（已保存，留空则沿用）' : ''}</label>
          <input style={field} type="password" placeholder={config?.hasApiKey ? '留空沿用已存密钥' : '必填'} value={form.apiKey as string || ''} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} />
        </div>
        <div style={{ marginBottom: 8 }}>
          <label style={label}>模型 Model</label>
          <input style={field} value={form.model || ''} onChange={(e) => setForm({ ...form, model: e.target.value })} />
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <label style={label}>温度 temperature</label>
            <input style={field} type="number" step="0.1" min={0} max={2} value={form.temperature ?? 0.7} onChange={(e) => setForm({ ...form, temperature: Number(e.target.value) })} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={label}>maxTokens</label>
            <input style={field} type="number" step="1" min={1} value={form.maxTokens ?? 2048} onChange={(e) => setForm({ ...form, maxTokens: Number(e.target.value) })} />
          </div>
        </div>
        <div style={{ marginBottom: 8 }}>
          <label style={label}>助手名称 botName</label>
          <input style={field} value={form.botName || ''} onChange={(e) => setForm({ ...form, botName: e.target.value })} />
        </div>
        <div style={{ marginBottom: 8 }}>
          <label style={label}>专属系统提示 systemPrompt</label>
          <textarea style={{ ...field, height: 80, resize: 'vertical' }} value={form.systemPrompt || ''} onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })} />
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button style={btn(true)} disabled={busy} onClick={save}>保存</button>
          <button style={btn()} onClick={test}>测试连接</button>
          <button style={btn()} onClick={del}>清除</button>
          {saveMsg && <span style={{ color: 'var(--accent)', alignSelf: 'center', fontSize: 13 }}>{saveMsg}</span>}
        </div>
        {testMsg && <div style={{ marginTop: 8, fontSize: 13, color: testMsg.startsWith('✅') ? 'var(--accent)' : '#e5534b' }}>{testMsg}</div>}

        {isAdmin && (
          <div style={{ marginTop: 24, borderTop: '1px solid var(--border)', paddingTop: 16 }}>
            <h4 style={{ margin: '0 0 8px' }}>组织默认配置（管理员下发模板，不含密钥）</h4>
            <div style={{ marginBottom: 8 }}>
              <label style={label}>Base URL</label>
              <input style={field} value={(orgDefault?.baseUrl as string) || ''} onChange={(e) => setOrgDefault({ ...(orgDefault || {}), baseUrl: e.target.value })} />
            </div>
            <div style={{ marginBottom: 8 }}>
              <label style={label}>模型 Model</label>
              <input style={field} value={(orgDefault?.model as string) || ''} onChange={(e) => setOrgDefault({ ...(orgDefault || {}), model: e.target.value })} />
            </div>
            <button style={btn()} onClick={saveOrg}>保存组织默认</button>
          </div>
        )}
      </div>
    </div>
  );
}
