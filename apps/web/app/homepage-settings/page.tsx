'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { DEFAULT_HOMEPAGE_CONFIG, type HomepageConfig, type LoginFeature } from '@acms/contracts';
import { api } from '../../lib/api';
import LoginShell from '../login/LoginShell';
import ImageField from './ImageField';

const PREVIEW_BASE_W = 1440;
const PREVIEW_BASE_H = 900;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 12,
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--fg)' }}>{title}</div>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg-secondary)' }}>{label}</span>
      {children}
    </label>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <input
      className="input"
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
    />
  );
}

function NumberInput({
  value,
  onChange,
  min,
  max,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
}) {
  return (
    <input
      className="input"
      type="number"
      min={min}
      max={max}
      value={value}
      onChange={(e) => {
        const n = Number(e.target.value);
        if (!Number.isNaN(n)) onChange(n);
      }}
    />
  );
}

function RangeNumberInput({
  value,
  onChange,
  min,
  max,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => {
    setText(String(value));
  }, [value]);

  const commit = (v: number) => {
    const clamped = Math.max(min ?? 0, Math.min(max ?? 100, v));
    if (clamped !== value) onChange(clamped);
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ flex: 1, minWidth: 60 }}
      />
      <input
        className="input"
        type="number"
        min={min}
        max={max}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const n = Number(e.target.value);
          if (!Number.isNaN(n)) commit(n);
        }}
        onBlur={() => {
          const n = Number(text);
          if (Number.isNaN(n)) {
            setText(String(value));
          } else {
            commit(n);
          }
        }}
        style={{ width: 70, textAlign: 'center' }}
      />
      <span style={{ fontSize: 12, color: 'var(--fg-tertiary)', width: 16 }}>%</span>
    </div>
  );
}

function TextArea({
  value,
  onChange,
  placeholder,
  rows = 3,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
}) {
  return (
    <textarea
      className="input"
      rows={rows}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      style={{ resize: 'vertical' }}
    />
  );
}

function ColorInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ width: 40, height: 32, padding: 0, border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer' }}
      />
      <input className="input" type="text" value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function FeatureRow({
  idx,
  item,
  onChange,
}: {
  idx: number;
  item: LoginFeature;
  onChange: (next: LoginFeature) => void;
}) {
  const icons = ['shield', 'users', 'layers', 'lock', 'check', 'zap'];
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '80px 1fr 1fr',
        gap: 8,
        alignItems: 'center',
      }}
    >
      <select
        className="input"
        value={item.icon}
        onChange={(e) => onChange({ ...item, icon: e.target.value })}
      >
        {icons.map((ic) => (
          <option key={ic} value={ic}>
            {ic}
          </option>
        ))}
      </select>
      <input
        className="input"
        value={item.title}
        onChange={(e) => onChange({ ...item, title: e.target.value })}
        placeholder="标题"
      />
      <input
        className="input"
        value={item.desc}
        onChange={(e) => onChange({ ...item, desc: e.target.value })}
        placeholder="描述"
      />
    </div>
  );
}

export default function HomepageSettingsPage() {
  const [config, setConfig] = useState<HomepageConfig>(DEFAULT_HOMEPAGE_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    api
      .getHomepageConfig()
      .then((d) => {
        setConfig({ ...DEFAULT_HOMEPAGE_CONFIG, ...d });
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useLayoutEffect(() => {
    function computeScale() {
      if (!previewRef.current) return;
      const containerWidth = previewRef.current.clientWidth;
      const s = Math.min(1, containerWidth / PREVIEW_BASE_W);
      setScale(s);
    }
    computeScale();
    window.addEventListener('resize', computeScale);
    return () => window.removeEventListener('resize', computeScale);
  }, []);

  function update<K extends keyof HomepageConfig>(key: K, value: HomepageConfig[K]) {
    setConfig((prev) => ({ ...prev, [key]: value }));
  }

  function updateFeature(idx: number, next: LoginFeature) {
    const list = config.features.slice();
    list[idx] = next;
    update('features', list);
  }

  async function handleSave() {
    setSaving(true);
    try {
      await api.updateHomepageConfig(config);
      setToast('保存成功');
      setTimeout(() => setToast(null), 2500);
    } catch (err) {
      setToast(`保存失败：${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setSaving(false);
    }
  }

  function handleReset() {
    if (confirm('确定要恢复为默认配置吗？未保存的修改将丢失。')) {
      setConfig(DEFAULT_HOMEPAGE_CONFIG);
    }
  }

  if (loading) {
    return <div style={{ padding: 40, color: 'var(--fg-secondary)' }}>加载中…</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div className="page-title">登录页配置</div>
          <div className="page-subtitle">配置登录页的布局、配色、Logo、文案与字体，右侧实时预览并保存。</div>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button type="button" className="btn btn-outline" onClick={handleReset}>
            恢复默认
          </button>
          <button type="button" className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? '保存中…' : '保存配置'}
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 16, flex: 1, minHeight: 0 }}>
        {/* 编辑器表单 */}
        <div
          style={{
            flex: 1,
            overflow: 'auto',
            paddingRight: 8,
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
            paddingBottom: 80,
          }}
        >
          <Section title="布局比例">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <Field label="左侧面板宽度 (%)">
                <RangeNumberInput
                  value={config.leftWidth}
                  min={20}
                  max={80}
                  onChange={(v) => {
                    update('leftWidth', v);
                    update('rightWidth', 100 - v);
                  }}
                />
              </Field>
              <Field label="右侧面板宽度 (%)">
                <RangeNumberInput
                  value={config.rightWidth}
                  min={20}
                  max={80}
                  onChange={(v) => {
                    update('rightWidth', v);
                    update('leftWidth', 100 - v);
                  }}
                />
              </Field>
            </div>
          </Section>

          <Section title="左侧面板">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <Field label="背景色">
                <ColorInput value={config.leftBgColor} onChange={(v) => update('leftBgColor', v)} />
              </Field>
              <Field label="文字色">
                <ColorInput value={config.leftTextColor} onChange={(v) => update('leftTextColor', v)} />
              </Field>
            </div>
            <ImageField
              label="背景图（可选）"
              value={config.leftBgImage}
              onChange={(v) => update('leftBgImage', v || null)}
            />
          </Section>

          <Section title="右侧面板">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <Field label="背景色">
                <ColorInput value={config.rightBgColor} onChange={(v) => update('rightBgColor', v)} />
              </Field>
              <Field label="文字色">
                <ColorInput value={config.rightTextColor} onChange={(v) => update('rightTextColor', v)} />
              </Field>
            </div>
            <ImageField
              label="背景图（可选）"
              value={config.rightBgImage}
              onChange={(v) => update('rightBgImage', v || null)}
            />
          </Section>

          <Section title="品牌 Logo">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <Field label="品牌名">
                <TextInput value={config.brandName} onChange={(v) => update('brandName', v)} />
              </Field>
              <Field label="品牌副标题">
                <TextInput value={config.brandSubtitle} onChange={(v) => update('brandSubtitle', v)} />
              </Field>
            </div>
            <ImageField
              label="Logo（留空则显示品牌首字母）"
              value={config.logoUrl}
              onChange={(v) => update('logoUrl', v || null)}
            />
          </Section>

          <Section title="字体排版">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 2fr', gap: 16 }}>
              <Field label="主标题字体大小">
                <TextInput value={config.headingFontSize} onChange={(v) => update('headingFontSize', v)} />
              </Field>
              <Field label="正文字体大小">
                <TextInput value={config.bodyFontSize} onChange={(v) => update('bodyFontSize', v)} />
              </Field>
              <Field label="字体族">
                <TextInput value={config.fontFamily} onChange={(v) => update('fontFamily', v)} />
              </Field>
            </div>
          </Section>

          <Section title="左侧文案">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <Field label="eyebrow 小字">
                <TextInput value={config.eyebrow} onChange={(v) => update('eyebrow', v)} />
              </Field>
              <Field label="section label">
                <TextInput value={config.sectionLabel} onChange={(v) => update('sectionLabel', v)} />
              </Field>
            </div>
            <Field label="主标题（用 \\n 换行）">
              <TextArea value={config.heroTitle} onChange={(v) => update('heroTitle', v)} rows={3} />
            </Field>
            <Field label="副标题">
              <TextArea value={config.heroSubtitle} onChange={(v) => update('heroSubtitle', v)} rows={3} />
            </Field>
            <Field label="特性列表">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {config.features.map((f, i) => (
                  <FeatureRow key={i} idx={i} item={f} onChange={(next) => updateFeature(i, next)} />
                ))}
              </div>
            </Field>
          </Section>

          <Section title="右侧文案">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <Field label="小标签">
                <TextInput value={config.rightLabel} onChange={(v) => update('rightLabel', v)} />
              </Field>
              <Field label="标题">
                <TextInput value={config.rightHeading} onChange={(v) => update('rightHeading', v)} />
              </Field>
            </div>
            <Field label="描述">
              <TextArea value={config.rightDesc} onChange={(v) => update('rightDesc', v)} rows={3} />
            </Field>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <Field label="登录按钮文字">
                <TextInput value={config.ctaText} onChange={(v) => update('ctaText', v)} />
              </Field>
              <Field label="状态标签">
                <TextInput value={config.statusTag} onChange={(v) => update('statusTag', v)} />
              </Field>
            </div>
            <Field label="状态说明">
              <TextArea value={config.statusText} onChange={(v) => update('statusText', v)} rows={2} />
            </Field>
          </Section>
        </div>

        {/* 实时预览 */}
        <div
          ref={previewRef}
          style={{
            width: '45%',
            minWidth: 320,
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 12,
            padding: 16,
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            position: 'sticky',
            top: 16,
            alignSelf: 'flex-start',
            height: 'calc(100vh - 140px)',
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--fg)' }}>实时预览</div>
          <div
            style={{
              flex: 1,
              overflow: 'hidden',
              borderRadius: 8,
              border: '1px solid var(--border)',
              background: '#000',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <div
              style={{
                width: PREVIEW_BASE_W * scale,
                height: PREVIEW_BASE_H * scale,
                overflow: 'hidden',
                position: 'relative',
              }}
            >
              <div
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: PREVIEW_BASE_W,
                  height: PREVIEW_BASE_H,
                  transform: `scale(${scale})`,
                  transformOrigin: 'top left',
                }}
              >
                <LoginShell config={config} preview />
              </div>
            </div>
          </div>
          <div style={{ fontSize: 12, color: 'var(--fg-tertiary)' }}>
            提示：保存后刷新 /login 即可看到登录页效果。
          </div>
        </div>
      </div>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
