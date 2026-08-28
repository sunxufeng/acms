'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
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

export function ApiConfigForm({ initial, onDone }: { initial?: ApiConfig | null; onDone: () => void }) {
  const t = useTranslations('ai.config');
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
    if (!form.provider) return t('errProvider');
    if (!form.baseUrl?.trim()) return t('errBaseUrl');
    if (!/^https?:\/\//.test(form.baseUrl.trim())) return t('errBaseUrlScheme');
    if (!form.model?.trim()) return t('errModel');
    if (!initial?.hasApiKey && form.provider !== 'ollama' && !form.apiKey?.trim()) return t('errApiKey');
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
      setTestMessage(result.ok ? t('connectOk') : result.error || t('connectFail'));
    } catch (e2) {
      setError((e2 as Error).message);
    } finally {
      setTesting(false);
    }
  }

  return (
    <form id="api-config-form" onSubmit={save} style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 920 }}>
      <fieldset className="form-fieldset">
        <legend className="form-legend">{t('legend')}</legend>
        <p className="page-subtitle" style={{ margin: '0 0 18px' }}>
          {t('note')}
        </p>
        <div className="form-grid">
          <label className="form-label">
            <span className="form-label-text">{t('preset')}</span>
            <select className="form-input" value={presetLabel} onChange={(e) => selectPreset(e.target.value)}>
              <option value="">{t('custom')}</option>
              {presets.map((preset) => <option key={preset.label} value={preset.label}>{preset.label}</option>)}
            </select>
          </label>

          <label className="form-label">
            <span className="form-label-text">{t('provider')}</span>
            <input className="form-input" value={form.provider || ''} onChange={(e) => setForm({ ...form, provider: e.target.value })} placeholder={t('providerPlaceholder')} />
          </label>

          <label className="form-label" style={{ gridColumn: '1 / -1' }}>
            <span className="form-label-text">{t('baseUrl')}</span>
            <input className="form-input" value={form.baseUrl || ''} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder={t('baseUrlPlaceholder')} />
          </label>

          <label className="form-label">
            <span className="form-label-text">{t('apiKey')}{initial?.hasApiKey ? ` ${t('apiKeySaved')}` : ' *'}</span>
            <input className="form-input" type="password" autoComplete="new-password" value={form.apiKey || ''} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} placeholder={initial?.hasApiKey ? t('apiKeyPlaceholderSaved') : t('apiKeyPlaceholder')} />
          </label>

          <label className="form-label">
            <span className="form-label-text">{t('model')}</span>
            <input className="form-input" value={form.model || ''} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder={t('modelPlaceholder')} />
          </label>

          <label className="form-label">
            <span className="form-label-text">{t('temperature')}</span>
            <input className="form-input" type="number" step="0.1" min={0} max={2} value={form.temperature ?? 0.7} onChange={(e) => setForm({ ...form, temperature: Number(e.target.value) })} />
          </label>

          <label className="form-label">
            <span className="form-label-text">{t('maxTokens')}</span>
            <input className="form-input" type="number" min={1} step={1} value={form.maxTokens ?? 2048} onChange={(e) => setForm({ ...form, maxTokens: Number(e.target.value) })} />
          </label>
        </div>
      </fieldset>

      {error && <p className="msg-error">{error}</p>}
      {testMessage && <p className="msg-success">{testMessage}</p>}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
        <button type="button" className="btn btn-outline" disabled={testing} onClick={testConnection}>{testing ? t('testing') : t('testConnection')}</button>
        <div style={{ display: 'flex', gap: 10 }}>
          <button type="button" className="btn btn-ghost" onClick={onDone}>{t('cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? t('saving') : t('save')}</button>
        </div>
      </div>
    </form>
  );
}
