'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

/**
 * 颜色选择控件（2026-09-20）：**色板点选 + 手输色值 + 系统取色器**三合一。
 *
 * 为什么要有它：
 *  1. 此前「颜色」字段是**纯手打文本框**（考核类型 / 主题配置都是），
 *     要用户自己记住并打出 `#4ECDC4` —— 少一位、少个 `#`、记错色号都只能靠肉眼试，
 *     而色值错了**不报错**，只是列头色块不显示（看起来像功能坏了）。
 *  2. 主题配置页（首页设置 / 首页管理）各自内联了一份「原生取色器 + 文本框」，
 *     两处实现几乎一样 —— 同一件事两种长相，所以收口到这里一份。
 *
 * 设计取舍：
 *  - **不收敛用户输入**：文本框原样回写（允许边打边改），只有「够不够格的 hex」由
 *    `normalizeHex` 判断；不合法时给提示，但**不阻断保存** ——
 *    老数据里可能有 `red`、`rgb(...)` 这类写法，硬拦会把存量卡死。
 *  - 色板分两组：前 12 个是**分类色**（成绩分类、标签、列头色块都合用，明度接近、并排不打架），
 *    后 5 个是**中性色**（文字/边框/底）。点一下即选中并关闭面板。
 *  - 系统取色器用隐藏的 `<input type="color">`（`width:0` 时部分浏览器点不开，用 1px + opacity:0）。
 */

/**
 * 分类色（明度接近，适合做一组并列色块）+ 中性色。
 * 前 12 个直接沿用成绩册列头原本在用的那批色（`#4ECDC4` 等），保证老手感一致。
 */
const PRESET_COLORS: readonly string[] = [
  '#4ECDC4', '#45B7D1', '#5B8FF9', '#7C6BF5', '#B37FEB', '#F759AB',
  '#FF7875', '#FFA940', '#FFC53D', '#95DE64', '#36CFC9', '#597EF7',
  '#1F2430', '#5A6472', '#8B95A5', '#D9D9D9', '#FFFFFF', '#000000',
];

/**
 * 把各种写法归一成 `#RRGGBB`（大写）；不合法返回空串。
 * 支持：`4ECDC4` / `#4ecdc4` / `#ABC`（三位简写按 CSS 语义展开）。
 */
export function normalizeHex(input: unknown): string {
  const raw = String(input ?? '').trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{6}$/.test(raw)) return `#${raw.toUpperCase()}`;
  if (/^[0-9a-fA-F]{3}$/.test(raw)) {
    return `#${raw.split('').map((c) => c + c).join('').toUpperCase()}`;
  }
  return '';
}

/** 是不是一个能显示出来的颜色（空串算「没设」，不算非法） */
export function isHexColor(v: unknown): boolean {
  return normalizeHex(v) !== '';
}

function Swatch({ hex, size = 14 }: { hex: string; size?: number }) {
  const base = { width: size, height: size, borderRadius: 4, display: 'block', flex: `0 0 ${size}px` } as const;
  if (!hex) {
    // 没有色值 / 非法值：虚线框（不假装是某种颜色）
    return <i style={{ ...base, border: '1px dashed var(--border)', background: 'transparent' }} />;
  }
  return <i style={{ ...base, background: hex, border: '1px solid rgba(0,0,0,.10)' }} />;
}

/** 列表里的色值单元格：色块 + 等宽色值。非法值只显示原文，不误导成颜色 */
export function ColorChip({ value }: { value: string }) {
  const text = String(value ?? '').trim();
  if (!text) return <span className="muted">—</span>;
  const hex = normalizeHex(text);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <Swatch hex={hex} />
      <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11.5, color: 'var(--fg-secondary)' }}>{text}</span>
    </span>
  );
}

export interface ColorPickerProps {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  /** 文本框的类名：CrudPage 的表单用 `form-input`，主题配置页用 `input` */
  inputClassName?: string;
  placeholder?: string;
}

export default function ColorPicker({
  value,
  onChange,
  disabled,
  inputClassName = 'form-input',
  placeholder,
}: ColorPickerProps) {
  const t = useTranslations('crud');
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const nativeRef = useRef<HTMLInputElement>(null);

  const text = String(value ?? '');
  const hex = normalizeHex(text);
  // 有内容但不是合法色值 ⇒ 提示（保存不拦，见文件头）
  const invalid = text.trim() !== '' && !hex;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={boxRef} style={{ position: 'relative' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen((o) => !o)}
          title={t('pickColor')}
          aria-label={t('pickColor')}
          aria-expanded={open}
          style={{
            width: 40,
            height: 32,
            flex: '0 0 40px',
            borderRadius: 6,
            border: `1px solid ${invalid ? 'var(--danger, #d33)' : 'var(--border)'}`,
            background: hex || 'var(--bg-alt)',
            cursor: disabled ? 'not-allowed' : 'pointer',
            opacity: disabled ? 0.6 : 1,
            padding: 0,
            position: 'relative',
          }}
        >
          {/* 空值时按钮上给一个「展开」提示，否则它看起来就是个灰方块 */}
          {!hex && (
            <span
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 11,
                color: 'var(--fg-tertiary)',
              }}
            >
              ▾
            </span>
          )}
        </button>
        <input
          className={inputClassName}
          placeholder={placeholder ?? '#4ECDC4'}
          value={text}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>

      {invalid && (
        <p className="form-hint" style={{ color: 'var(--danger, #d33)' }}>
          {t('invalidColor')}
        </p>
      )}

      {open && (
        <div
          style={{
            position: 'absolute',
            top: '110%',
            left: 0,
            zIndex: 30,
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            borderRadius: 10,
            padding: 10,
            boxShadow: 'var(--shadow-lg)',
            width: 236,
          }}
        >
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 6 }}>
            {PRESET_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                title={c}
                aria-label={c}
                onClick={() => {
                  onChange(c);
                  setOpen(false);
                }}
                style={{
                  width: 26,
                  height: 22,
                  padding: 0,
                  borderRadius: 5,
                  background: c,
                  cursor: 'pointer',
                  border: hex === c ? '2px solid var(--accent)' : '1px solid var(--border)',
                }}
              />
            ))}
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => nativeRef.current?.click()}
            >
              {t('customColor')}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                onChange('');
                setOpen(false);
              }}
            >
              {t('clearColor')}
            </button>
          </div>
          {/*
            系统取色器：`display:none` / `width:0` 在部分浏览器里 `click()` 点不开，
            所以留 1px + opacity:0（不可见但可点）。
          */}
          <input
            ref={nativeRef}
            type="color"
            tabIndex={-1}
            aria-hidden="true"
            value={hex || '#000000'}
            onChange={(e) => {
              onChange(normalizeHex(e.target.value) || e.target.value);
              setOpen(false);
            }}
            style={{ position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none', border: 0, padding: 0 }}
          />
        </div>
      )}
    </div>
  );
}
