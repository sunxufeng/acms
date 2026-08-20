'use client';

import { useEffect, useState } from 'react';
import { api, type SessionUser } from '../../../lib/api';

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

const field: React.CSSProperties = { width: '100%', background: 'var(--bg-tertiary)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', fontSize: 13, marginBottom: 10 };
const label: React.CSSProperties = { fontSize: 12, color: 'var(--text-muted)', marginBottom: 4, display: 'block' };
const btn = (primary = false): React.CSSProperties => ({
  background: primary ? 'var(--accent)' : 'transparent',
  color: primary ? '#fff' : 'var(--text)',
  border: primary ? 'none' : '1px solid var(--border)',
  borderRadius: 8, padding: '7px 14px', cursor: 'pointer', fontSize: 13,
});

export default function AiConfigPage() {
  const [me, setMe] = useState<SessionUser | null>(null);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [config, setConfig] = useState<Cfg | null>(null);
  const [form, setForm] = useState<Cfg>({ provider: 'openai', baseUrl: '', apiKey: '', model: '', botName: '', systemPrompt: '', temperature: 0.7, maxTokens: 2048 });

  const isAdmin = !!me?.roles?.includes('系统管理员');
  const [busy, setBusy] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const [testMsg, setTestMsg] = useState('');
  const [orgDefault, setOrgDefault] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    api.me().then(setMe).catch(() => null);
    api.aiPresets().then((p) => setPresets(p as Preset[])).catch(() => null);
    api.aiGetConfig().then((c) => {
      setConfig(c as Cfg);
      setForm({
        provider: (c as Cfg)?.provider || presets[0]?.type || 'openai',
        baseUrl: (c as Cfg)?.baseUrl || presets[0]?.defaultBaseUrl || '',
        apiKey: '',
        model: (c as Cfg)?.model || '',
        botName: (c as Cfg)?.botName || '',
        systemPrompt: (c as Cfg)?.systemPrompt || '',
        temperature: (c as Cfg)?.temperature ?? 0.7,
        maxTokens: (c as Cfg)?.maxTokens ?? 2048,
      });
    }).catch(() => null);
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
      if (!payload.apiKey) delete payload.apiKey;
      const c = await api.aiSaveConfig(payload);
      setConfig(c as Cfg);
      setSaveMsg('已保存');
      setTimeout(() => setSaveMsg(''), 2000);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function del() {
    if (!confirm('确认清除你的模型配置（API Key 将被删除）？')) return;
    try { await api.aiDeleteConfig(); setConfig({} as Cfg); setForm({ ...form, apiKey: '' }); } catch (e) { alert(e instanceof Error ? e.message : String(e)); }
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

  return (
    <div style={{ padding: 16, maxWidth: 640 }}>
      <h2 style={{ margin: '0 0 4px' }}>AI 设置</h2>
      <small style={{ color: 'var(--text-muted)' }}>配置你的个人模型网关（Provider / API Key / Model）。密钥经 KMS 信封加密存储，页面不会回显明文。</small>

      <div style={{ marginTop: 18 }}>
        <label style={label}>预设厂商</label>
        <select style={field} value={presets.find((p) => p.type === form.provider)?.label || ''} onChange={(e) => pickPreset(e.target.value)}>
          <option value="">自定义</option>
          {presets.map((p) => <option key={p.label} value={p.label}>{p.label}</option>)}
        </select>

        <label style={label}>Provider 类型</label>
        <input style={field} value={form.provider || ''} onChange={(e) => setForm({ ...form, provider: e.target.value })} />

        <label style={label}>Base URL</label>
        <input style={field} value={form.baseUrl || ''} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />

        <label style={label}>API Key {config?.hasApiKey ? '（已保存，留空则沿用）' : ''}</label>
        <input style={field} type="password" placeholder={config?.hasApiKey ? '留空沿用已存密钥' : '必填'} value={form.apiKey as string || ''} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} />

        <label style={label}>模型 Model</label>
        <input style={field} value={form.model || ''} onChange={(e) => setForm({ ...form, model: e.target.value })} />

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

        <label style={label}>助手名称 botName</label>
        <input style={field} value={form.botName || ''} onChange={(e) => setForm({ ...form, botName: e.target.value })} />

        <label style={label}>专属系统提示 systemPrompt</label>
        <textarea style={{ ...field, height: 80, resize: 'vertical' }} value={form.systemPrompt || ''} onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })} />

        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button style={btn(true)} disabled={busy} onClick={save}>保存</button>
          <button style={btn()} onClick={test}>测试连接</button>
          <button style={btn()} onClick={del}>清除</button>
          {saveMsg && <span style={{ color: 'var(--accent)', alignSelf: 'center', fontSize: 13 }}>{saveMsg}</span>}
        </div>
        {testMsg && <div style={{ marginTop: 8, fontSize: 13, color: testMsg.startsWith('✅') ? 'var(--accent)' : '#e5534b' }}>{testMsg}</div>}
      </div>

      {isAdmin && (
        <div style={{ marginTop: 28, borderTop: '1px solid var(--border)', paddingTop: 16 }}>
          <h4 style={{ margin: '0 0 8px' }}>组织默认配置（管理员下发模板，不含密钥）</h4>
          <label style={label}>Base URL</label>
          <input style={field} value={(orgDefault?.baseUrl as string) || ''} onChange={(e) => setOrgDefault({ ...(orgDefault || {}), baseUrl: e.target.value })} />
          <label style={label}>模型 Model</label>
          <input style={field} value={(orgDefault?.model as string) || ''} onChange={(e) => setOrgDefault({ ...(orgDefault || {}), model: e.target.value })} />
          <button style={btn()} onClick={saveOrg}>保存组织默认</button>
        </div>
      )}
    </div>
  );
}
