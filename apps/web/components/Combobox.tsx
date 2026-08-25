'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

export interface ComboboxOption {
  /** 选中后写入表单的值 */
  value: string;
  /** 下拉中展示的辅助文本（如 中文名 / 英文名） */
  label?: string;
}

function normalize(v: string): string {
  return v.toLowerCase().replace(/\s+/g, '');
}

/**
 * 可输入筛选的下拉框（自定义实现）。
 * - 输入框只显示 label，不会暴露 id 等内部 value
 * - 按 label 关键字筛选，不显示无关 value
 * - 可直接点击选择，也支持上下键、回车选择
 * 用于导师（可自由输入）、关联学生等「选择或手输」的字段。
 */
export default function Combobox({
  value,
  onChange,
  options,
  placeholder,
  allowFreeText,
}: {
  value: string;
  onChange: (v: string) => void;
  options: ComboboxOption[];
  placeholder?: string;
  allowFreeText?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [display, setDisplay] = useState('');
  const [highlight, setHighlight] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const ignoreBlurRef = useRef(false);

  // 根据外部 value 同步显示文本（优先 label，找不到则回退 value）
  useEffect(() => {
    const opt = options.find((o) => o.value === value);
    if (opt) {
      setDisplay(opt.label || opt.value);
    } else if (allowFreeText) {
      setDisplay(value);
    } else {
      setDisplay('');
    }
  }, [value, options, allowFreeText]);

  const filtered = useMemo(() => {
    if (!display.trim()) return options;
    const q = normalize(display);
    return options.filter((o) => {
      const text = normalize(o.label || o.value);
      return text.includes(q);
    });
  }, [display, options]);

  useEffect(() => {
    setHighlight(0);
  }, [filtered.length]);

  // 点击外部关闭
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  function selectOption(opt: ComboboxOption) {
    setDisplay(opt.label || opt.value);
    onChange(opt.value);
    setOpen(false);
  }

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = e.target.value;
    setDisplay(v);
    setOpen(true);
    if (allowFreeText) onChange(v);
  }

  function handleBlur() {
    // 给 click 选择留一点时间
    window.setTimeout(() => {
      if (ignoreBlurRef.current) {
        ignoreBlurRef.current = false;
        return;
      }
      if (!allowFreeText) {
        const opt = options.find((o) => (o.label || o.value) === display);
        if (opt) {
          onChange(opt.value);
        } else if (!value) {
          setDisplay('');
        } else {
          const selected = options.find((o) => o.value === value);
          setDisplay(selected ? selected.label || selected.value : '');
        }
      }
      setOpen(false);
    }, 120);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') setOpen(true);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const opt = filtered[highlight];
      if (opt) selectOption(opt);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  return (
    <div ref={containerRef} style={{ position: 'relative', width: '100%' }}>
      <input
        className="form-input"
        value={display}
        placeholder={placeholder}
        autoComplete="off"
        onChange={handleInputChange}
        onFocus={() => setOpen(true)}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
      />
      {open && filtered.length > 0 && (
        <ul
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            right: 0,
            maxHeight: 280,
            overflow: 'auto',
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
            zIndex: 100,
            margin: 0,
            padding: 4,
            listStyle: 'none',
          }}
        >
          {filtered.map((o, i) => (
            <li
              key={o.value}
              onMouseDown={() => { ignoreBlurRef.current = true; }}
              onClick={() => selectOption(o)}
              style={{
                padding: '8px 10px',
                borderRadius: 6,
                cursor: 'pointer',
                background: i === highlight ? 'var(--accent-soft)' : 'transparent',
                color: 'var(--fg-primary)',
                fontSize: 'var(--font-sm)',
              }}
              onMouseEnter={() => setHighlight(i)}
            >
              {o.label || o.value}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
