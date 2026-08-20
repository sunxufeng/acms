'use client';

import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';

type Preset = {
  type: string;
  label: string;
  defaultBaseUrl: string;
  sampleModels: string;
  hint: string;
};

export type ApiConfig = {
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  hasApiKey?: boolean;
  updatedAt?: string;
};

const PROVIDER_DESCRIPTIONS: Record<string, string> = {
  openai: 'OpenAI 兼容协议',
  anthropic: 'Anthropic Messages 协议',
  ollama: 'Ollama 本地推理',
  custom: '自定义 OpenAI 兼容网关',
  acplugin: 'AC Plugin 协议',
};

export function providerDescription(provider?: string) {
  return provider ? PROVIDER_DESCRIPTIONS[provider] || provider : '—';
}

export function ApiConfigForm({ initial, onDone }: { initial?: ApiConfig | null; onDone: () => void }) {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [presetLabel, setPresetLabel] = useState('');
  const [form, setForm] = useState<ApiConfig>({
    provider: initial?.provider || 'openai',
    baseUrl: initial?.baseUrl || '',
    apiKey: '',
    model: initial?.model || '',
    temperature: initial?.temperature ?? 0.7,
    maxTokens: initial?.maxTokens ?? 2048,
  });
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState('');
  const [testMessage, setTestMessage] = useState('');

  useEffect(() => {
    api.aiPresets().then((data) => {
      const next = data as Preset[];
      setPresets(next);
      const matched = next.find((item) => item.type === form.provider && item.defaultBaseUrl === form.baseUrl);
      if (matched) setPresetLabel(matched.label);
    }).catch((e) => setError((e as Error).message));
  }, []);

  function selectPreset(label: string) {
    setPresetLabel(label);
    const preset = presets.find((item) => item.label === label);
    if (!preset) return;
    const firstModel = preset.sampleModels.split('\n').map((item) => item.trim()).find(Boolean) || '';
    setForm((current) => ({
      ...current,
      provider: preset.type,
      baseUrl: preset.defaultBaseUrl,
      model: current.model || firstModel,
    }));
  }

  function payload() {
    const data: Record<string, unknown> = {
      provider: form.provider,
      baseUrl: form.baseUrl?.trim(),
      model: form.model?.trim(),
      temperature: Number(form.temperature),
      maxTokens: Number(form.maxTokens),
    };
    if (form.apiKey?.trim()) data.apiKey = form.apiKey.trim();
    return data;
  }

  function validate() {
    if (!form.provider) return '请选择 Provider 描述';
    if (!form.baseUrl?.trim()) return '请填写 Base URL';
    if (!/^https?:\/\//.test(form.baseUrl.trim())) return 'Base URL 必须以 http:// 或 https:// 开头';
    if (!form.model?.trim()) return '请填写模型 Model';
    if (!initial?.hasApiKey && form.provider !== 'ollama' && !form.apiKey?.trim()) return '请填写 API Key';
    return '';
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api.aiSaveConfig(payload());
      onDone();
    } catch (e2) {
      setError((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function testConnection() {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    setTesting(true);
    setError('');
    setTestMessage('');
    try {
      const result = await api.aiTestConfig(payload());
      setTestMessage(result.ok ? '连接成功' : result.error || '连接失败');
    } catch (e2) {
      setError((e2 as Error).message);
    } finally {
      setTesting(false);
    }
  }

  return (
    <form onSubmit={save} style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 920 }}>
      <fieldset className="form-fieldset">
        <legend className="form-legend">个人 API 配置</legend>
        <p className="page-subtitle" style={{ margin: '0 0 18px' }}>
          配置仅归当前账号所有。API Key 经加密存储，页面不会回显明文。
        </p>
        <div className="form-grid">
          <label className="form-label">
            <span className="form-label-text">预设厂商</span>
            <select className="form-input" value={presetLabel} onChange={(e) => selectPreset(e.target.value)}>
              <option value="">自定义</option>
              {presets.map((preset) => <option key={preset.label} value={preset.label}>{preset.label}</option>)}
            </select>
          </label>

          <label className="form-label">
            <span className="form-label-text">Provider 描述 *</span>
            <select className="form-input" value={form.provider || ''} onChange={(e) => setForm({ ...form, provider: e.target.value })}>
              {Object.entries(PROVIDER_DESCRIPTIONS).map(([value, text]) => (
                <option key={value} value={value}>{text}</option>
              ))}
            </select>
          </label>

          <label className="form-label" style={{ gridColumn: '1 / -1' }}>
            <span className="form-label-text">Base URL *</span>
            <input className="form-input" value={form.baseUrl || ''} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://api.deepseek.com" />
          </label>

          <label className="form-label">
            <span className="form-label-text">API Key {initial?.hasApiKey ? '（已保存，留空则沿用）' : '*'}</span>
            <input className="form-input" type="password" autoComplete="new-password" value={form.apiKey || ''} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} placeholder={initial?.hasApiKey ? '留空沿用已保存密钥' : '请输入个人 API Key'} />
          </label>

          <label className="form-label">
            <span className="form-label-text">模型 Model *</span>
            <input className="form-input" value={form.model || ''} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder="deepseek-chat" />
          </label>

          <label className="form-label">
            <span className="form-label-text">温度 temperature</span>
            <input className="form-input" type="number" step="0.1" min={0} max={2} value={form.temperature ?? 0.7} onChange={(e) => setForm({ ...form, temperature: Number(e.target.value) })} />
          </label>

          <label className="form-label">
            <span className="form-label-text">最大输出 maxTokens</span>
            <input className="form-input" type="number" min={1} step={1} value={form.maxTokens ?? 2048} onChange={(e) => setForm({ ...form, maxTokens: Number(e.target.value) })} />
          </label>
        </div>
      </fieldset>

      {error && <p className="msg-error">{error}</p>}
      {testMessage && <p className="msg-success">{testMessage}</p>}

      <div style={{ display: 'flex', gap: 10 }}>
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? '保存中…' : '保存'}</button>
        <button type="button" className="btn btn-outline" disabled={testing} onClick={testConnection}>{testing ? '测试中…' : '测试连接'}</button>
        <button type="button" className="btn btn-ghost" onClick={onDone}>取消</button>
      </div>
    </form>
  );
}
