'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useTl } from '../lib/useTl';

export interface MultiOption {
  /** 写入表单的值（如用户 record id / 部门 open_department_id / 人员姓名） */
  value: string;
  /** 展示文本 */
  label: string;
}

/**
 * 可搜索的**多选**控件。
 *
 * 为什么需要它（2026-09-19）：改版前多选字段是把**全部候选项铺成一堆带复选框的胶囊**。
 * 会议纪要里参会 / 缺席 / 列席 / 可见用户四处、每处 28 个候选 = 表单里塞进 84 个复选框，
 * 占三屏以上，选人只能一个个找。这里改成「已选留在上面 + 候选收进下拉、输入即筛」。
 *
 * ⚠️ 候选不铺开 ≠ 候选不存在：下拉里仍能看到未选项（过滤后），已选的在上面可逐个删。
 * ⚠️ 用 `onMouseDown` + `preventDefault()` 选候选项：直接 `onClick` 会先触发输入框 blur
 *    导致下拉被关掉、点不中（Combobox 那边是靠 blur 延迟 120ms 绕过的，这里用更稳的写法）。
 */
export default function SearchMultiSelect({
  value,
  onChange,
  options,
  placeholder,
  disabled,
  /** 已选超过这个数量时折叠成「+N」（悬停可看全） */
  maxChips = 30,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  options: MultiOption[];
  placeholder?: string;
  disabled?: boolean;
  maxChips?: number;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  // ⚠️ 两个翻译器的分工（别混）：
  //    t()  → 纯 UI 文案（走 next-intl 的 crud / common 命名空间）
  //    tl() → **数据类**文本（人员姓名、部门名这种「中文既是 key 也是显示文本」的）
  const t = useTranslations();
  const tl = useTl();

  /** 已选项（找不到候选项时退回显示原值 —— 例如历史数据里的名字） */
  const selected = useMemo(
    () => value.map((v) => options.find((o) => o.value === v) ?? { value: v, label: v }),
    [value, options],
  );

  const filtered = useMemo(() => {
    const rest = options.filter((o) => !value.includes(o.value));
    const q = query.trim().toLowerCase();
    if (!q) return rest;
    return rest.filter((o) => `${o.label}${o.value}`.toLowerCase().includes(q));
  }, [options, value, query]);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const add = (v: string) => {
    onChange([...value, v]);
    setQuery('');
    setHighlight(0);
  };
  const remove = (v: string) => onChange(value.filter((x) => x !== v));

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    // 输入框为空时按退格 = 删掉最后一个已选（常见的多选交互）
    if (e.key === 'Backspace' && !query && value.length) {
      e.preventDefault();
      remove(value[value.length - 1]);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setHighlight((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const opt = filtered[highlight];
      if (opt) add(opt.value);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  const shown = selected.slice(0, maxChips);
  const restCount = selected.length - shown.length;

  return (
    <div ref={boxRef} style={{ position: 'relative', width: '100%' }}>
      <div
        className="form-input"
        onClick={() => {
          if (!disabled) setOpen(true);
        }}
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 6,
          minHeight: 36,
          padding: '5px 8px',
          cursor: disabled ? 'not-allowed' : 'text',
          opacity: disabled ? 0.75 : 1,
        }}
        title={disabled ? t('crud.noEditPerm') : undefined}
      >
        {shown.map((o) => (
          <span
            key={o.value}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              padding: '2px 6px 2px 8px',
              borderRadius: 'var(--radius-full)',
              background: 'var(--accent-soft)',
              color: 'var(--accent-strong)',
              fontSize: 'var(--font-xs)',
              maxWidth: 200,
            }}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tl(o.label)}</span>
            {disabled ? null : (
              <button
                type="button"
                aria-label={t('common.delete')}
                onClick={(e) => {
                  e.stopPropagation();
                  remove(o.value);
                }}
                style={{
                  border: 'none',
                  background: 'transparent',
                  color: 'inherit',
                  cursor: 'pointer',
                  padding: 0,
                  lineHeight: 1,
                  fontSize: 'var(--font-sm)',
                }}
              >
                ×
              </button>
            )}
          </span>
        ))}
        {restCount > 0 ? (
          <span
            title={selected.map((o) => tl(o.label)).join('、')}
            style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)', cursor: 'default' }}
          >
            +{restCount}
          </span>
        ) : null}
        <input
          value={query}
          disabled={disabled}
          autoComplete="off"
          placeholder={selected.length ? '' : placeholder}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setHighlight(0);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          style={{
            flex: '1 1 70px',
            minWidth: 70,
            border: 'none',
            outline: 'none',
            background: 'transparent',
            color: 'inherit',
            fontSize: 'inherit',
            padding: '2px 0',
          }}
        />
      </div>

      {open ? (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            zIndex: 60,
            marginTop: 4,
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)',
            boxShadow: 'var(--shadow-md)',
            maxHeight: 220,
            overflowY: 'auto',
          }}
        >
          {filtered.length === 0 ? (
            <div style={{ padding: '8px 10px', fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>
              {options.length > 0 && value.length >= options.length ? t('crud.allSelected') : t('crud.noMatch')}
            </div>
          ) : (
            filtered.slice(0, 200).map((o, i) => (
              <div
                key={o.value}
                // mousedown + preventDefault：不让输入框失焦，避免下拉先被关掉
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => add(o.value)}
                onMouseEnter={() => setHighlight(i)}
                style={{
                  padding: '7px 10px',
                  fontSize: 'var(--font-sm)',
                  color: 'var(--fg-primary)',
                  cursor: 'pointer',
                  background: i === highlight ? 'var(--bg-hover)' : 'transparent',
                }}
              >
                {tl(o.label)}
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
