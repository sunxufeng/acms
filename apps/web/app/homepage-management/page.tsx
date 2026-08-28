'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  DEFAULT_HOMEPAGE_CONFIG,
  type DashboardTheme,
  type HomepageConfig,
  imageUrl,
} from '@acms/contracts';
import { api } from '../../lib/api';
import ImageField from '../homepage-settings/ImageField';
import { useTranslations } from 'next-intl';

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

function ColorInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <input
        type="color"
        value={value.startsWith('#') ? value : '#000000'}
        onChange={(e) => onChange(e.target.value)}
        style={{ width: 40, height: 32, padding: 0, border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer' }}
      />
      <input className="input" type="text" value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function DashboardPreview({ theme }: { theme: DashboardTheme }) {
  const __lT = useTranslations('labels'); const tl = ((k: string, v?: any) => { const __r = __lT(k as any, v); return (__r === k || __r.startsWith('labels.')) ? k : __r; }) as any;
  const logoSrc = theme.logoUrl ? imageUrl(theme.logoUrl) : '/logo.png';
  const brandName = theme.brandName || 'ARETE';
  const brandSubtitle = theme.brandSubtitle || 'COLLEGE OPS';

  const sidebarStyle: React.CSSProperties = {
    width: theme.sidebarWidth ?? 252,
    background: theme.sidebarBgColor,
    color: theme.sidebarTextColor,
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    flexShrink: 0,
    borderRight: `1px solid ${theme.sidebarBorderColor || 'rgba(0,0,0,0.08)'}`,
    fontFamily: 'inherit',
  };

  const mainStyle: React.CSSProperties = {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    background: theme.mainBgColor,
    color: theme.mainTextColor,
    height: '100%',
  };

  const topbarStyle: React.CSSProperties = {
    height: 56,
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 24px',
    background: theme.headerBgColor,
    color: theme.headerTextColor,
    borderBottom: `1px solid ${theme.headerBorderColor || 'rgba(0,0,0,0.08)'}`,
  };

  const navItemStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '10px 16px',
    borderRadius: 8,
    margin: '2px 10px',
    cursor: 'pointer',
  };

  return (
    <div style={{ display: 'flex', height: '100%', fontSize: 13 }}>
      {/* Sidebar */}
      <aside style={sidebarStyle}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '18px 20px',
            borderBottom: `1px solid ${theme.sidebarBorderColor || 'rgba(255,255,255,0.08)'}`,
          }}
        >
          {theme.logoUrl ? (
            <img src={logoSrc} alt={brandName} style={{ width: 32, height: 32, objectFit: 'contain' }} />
          ) : (
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: 6,
                border: '1.5px solid currentColor',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: 800,
                fontSize: 14,
              }}
            >
              {brandName.charAt(0).toUpperCase()}
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2 }}>
            <strong style={{ fontSize: 13, fontWeight: 800, letterSpacing: 1 }}>{brandName}</strong>
            <small style={{ fontSize: 9, opacity: 0.7, letterSpacing: 1 }}>{brandSubtitle}</small>
          </div>
        </div>

        <div style={{ padding: '12px 0', flex: 1 }}>
          <div style={{ fontSize: 10, fontWeight: 700, padding: '8px 20px', color: theme.sidebarSectionColor }}>
            工作台
          </div>
          <div
            style={{
              ...navItemStyle,
              background: theme.sidebarActiveBgColor,
              color: theme.sidebarActiveTextColor,
            }}
          >
            <span>▣</span>
            <span>{tl('概览')}</span>
          </div>
          <div
            style={{
              ...navItemStyle,
              color: theme.sidebarTextColor,
            }}
          >
            <span>👤</span>
            <span>{tl('学生档案')}</span>
          </div>

          <div style={{ fontSize: 10, fontWeight: 700, padding: '14px 20px 6px', color: theme.sidebarSectionColor }}>
            后台管理
          </div>
          <div style={{ ...navItemStyle, color: theme.sidebarTextColor }}>
            <span>⚙</span>
            <span>{tl('工作台主题')}</span>
          </div>
          <div style={{ ...navItemStyle, color: theme.sidebarTextColor }}>
            <span>☰</span>
            <span>{tl('菜单管理')}</span>
          </div>
        </div>
      </aside>

      {/* Main area */}
      <div style={mainStyle}>
        <header style={topbarStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span>☰</span>
            <span style={{ fontWeight: 600, fontSize: 14 }}>{tl('工作台 / 概览')}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span>{tl('🔍 搜索')}</span>
            <span>{tl('👤 管理员')}</span>
          </div>
        </header>
        <main style={{ flex: 1, padding: 24 }}>
          <div
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 12,
              padding: 24,
              height: '100%',
              color: theme.mainTextColor,
            }}
          >
            <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>{tl('工作台预览')}</div>
            <div style={{ fontSize: 13, opacity: 0.7 }}>{tl('右侧主内容区域背景色预览')}</div>
          </div>
        </main>
      </div>
    </div>
  );
}

export default function HomepageManagementPage() {

  const __lT = useTranslations('labels'); const tl = ((k: string, v?: any) => { const __r = __lT(k as any, v); return (__r === k || __r.startsWith('labels.')) ? k : __r; }) as any;  const [config, setConfig] = useState<HomepageConfig>(DEFAULT_HOMEPAGE_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    api
      .getHomepageConfig()
      .then((d) => {
        const merged = { ...DEFAULT_HOMEPAGE_CONFIG, ...d } as HomepageConfig;
        // 确保 dashboardTheme 字段齐全
        merged.dashboardTheme = { ...DEFAULT_HOMEPAGE_CONFIG.dashboardTheme!, ...(merged.dashboardTheme ?? {}) };
        setConfig(merged);
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

  const theme = useMemo(
    () => config.dashboardTheme ?? DEFAULT_HOMEPAGE_CONFIG.dashboardTheme!,
    [config.dashboardTheme],
  );

  function updateTheme<K extends keyof DashboardTheme>(key: K, value: DashboardTheme[K]) {
    setConfig((prev) => ({
      ...prev,
      dashboardTheme: { ...(prev.dashboardTheme ?? DEFAULT_HOMEPAGE_CONFIG.dashboardTheme!), [key]: value },
    }));
  }

  async function handleSave() {
    setSaving(true);
    try {
      await api.updateHomepageConfig(config);
      setToast('保存成功，刷新页面后工作台生效');
      setTimeout(() => setToast(null), 2500);
    } catch (err) {
      setToast(`保存失败：${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setSaving(false);
    }
  }

  function handleReset() {
    if (confirm('确定恢复为默认主页配置吗？未保存的修改将丢失。')) {
      setConfig(DEFAULT_HOMEPAGE_CONFIG);
    }
  }

  if (loading) {
    return <div style={{ padding: 40, color: 'var(--fg-secondary)' }}>{tl('加载中…')}</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div className="page-title">{tl('工作台主题')}</div>
          <div className="page-subtitle">{tl('配置登录后工作台的侧边栏、顶部导航栏、主内容区配色、Logo 与品牌文字，右侧实时预览并保存。')}</div>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <Link href="/homepage-settings" className="btn btn-outline">
            返回登录页配置
          </Link>
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
          <Section title={tl('品牌 Logo')}>
            <ImageField label="左上角 Logo" value={theme.logoUrl ?? ''} onChange={(v) => updateTheme('logoUrl', v)} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <Field label="品牌名称">
                <TextInput value={theme.brandName ?? ''} onChange={(v) => updateTheme('brandName', v)} />
              </Field>
              <Field label="品牌副标题">
                <TextInput value={theme.brandSubtitle ?? ''} onChange={(v) => updateTheme('brandSubtitle', v)} />
              </Field>
            </div>
          </Section>

          <Section title={tl('侧边栏')}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <Field label="背景色">
                <ColorInput value={theme.sidebarBgColor} onChange={(v) => updateTheme('sidebarBgColor', v)} />
              </Field>
              <Field label="文字色">
                <ColorInput value={theme.sidebarTextColor} onChange={(v) => updateTheme('sidebarTextColor', v)} />
              </Field>
              <Field label="悬停背景色">
                <ColorInput value={theme.sidebarHoverBgColor} onChange={(v) => updateTheme('sidebarHoverBgColor', v)} />
              </Field>
              <Field label="选中背景色">
                <ColorInput value={theme.sidebarActiveBgColor} onChange={(v) => updateTheme('sidebarActiveBgColor', v)} />
              </Field>
              <Field label="选中文字色">
                <ColorInput value={theme.sidebarActiveTextColor} onChange={(v) => updateTheme('sidebarActiveTextColor', v)} />
              </Field>
              <Field label="分组标题色">
                <ColorInput value={theme.sidebarSectionColor} onChange={(v) => updateTheme('sidebarSectionColor', v)} />
              </Field>
              <Field label="边框色">
                <ColorInput value={theme.sidebarBorderColor} onChange={(v) => updateTheme('sidebarBorderColor', v)} />
              </Field>
              <Field label="展开宽度 (px)">
                <NumberInput value={theme.sidebarWidth ?? 252} min={160} max={400} onChange={(v) => updateTheme('sidebarWidth', v)} />
              </Field>
            </div>
          </Section>

          <Section title={tl('顶部导航栏')}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
              <Field label="背景色">
                <ColorInput value={theme.headerBgColor} onChange={(v) => updateTheme('headerBgColor', v)} />
              </Field>
              <Field label="文字色">
                <ColorInput value={theme.headerTextColor} onChange={(v) => updateTheme('headerTextColor', v)} />
              </Field>
              <Field label="边框色">
                <ColorInput value={theme.headerBorderColor} onChange={(v) => updateTheme('headerBorderColor', v)} />
              </Field>
            </div>
          </Section>

          <Section title={tl('主内容区')}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <Field label="背景色">
                <ColorInput value={theme.mainBgColor ?? '#F4F7F6'} onChange={(v) => updateTheme('mainBgColor', v)} />
              </Field>
              <Field label="文字色">
                <ColorInput value={theme.mainTextColor ?? '#111827'} onChange={(v) => updateTheme('mainTextColor', v)} />
              </Field>
            </div>
          </Section>
        </div>

        {/* 实时预览 */}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--fg)' }}>{tl('实时预览')}</div>
          <div
            ref={previewRef}
            style={{
              flex: 1,
              overflow: 'auto',
              borderRadius: 12,
              border: '1px solid var(--border)',
              background: 'var(--surface)',
              position: 'relative',
            }}
          >
            <div
              style={{
                width: PREVIEW_BASE_W * scale,
                height: PREVIEW_BASE_H * scale,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  width: PREVIEW_BASE_W,
                  height: PREVIEW_BASE_H,
                  transform: `scale(${scale})`,
                  transformOrigin: 'top left',
                }}
              >
                <DashboardPreview theme={theme} />
              </div>
            </div>
          </div>
        </div>
      </div>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
