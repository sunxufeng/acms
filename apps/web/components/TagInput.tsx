'use client';

import { useState, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';

export interface TagInputProps {
  value: string[];
  onChange: (v: string[]) => void;
  /** 候选建议（下拉展示未选中的项）；可留空仅作自由输入 */
  options?: string[];
  /** 占位提示 */
  placeholder?: string;
  /** 是否只读 */
  readOnly?: boolean;
  /** 输入新标签时回调（例如写回字典），可选 */
  onPersist?: (tag: string) => void;
  /** 额外的快捷添加按钮（如「添加当前 WiFi」）。返回 JSX 或 null */
  quickAdd?: React.ReactNode;
}

function TagInput({
  value,
  onChange,
  options = [],
  placeholder = '选择或输入标签',
  readOnly = false,
  onPersist,
  quickAdd,
}: TagInputProps) {
  // 变量名为 tc：避免与下方 map 回调 / add() 内的局部变量 t 重名
  const tc = useTranslations('common');
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const selected = Array.isArray(value) ? value : [];
  const rest = options.filter((o) => !selected.includes(o));
  const draftTrim = draft.trim();
  const draftMatch =
    draftTrim && !selected.includes(draftTrim) && !options.includes(draftTrim);

  const add = (tag: string) => {
    const t = tag.trim();
    if (!t || selected.includes(t)) return;
    onChange([...selected, t]);
    if (!options.includes(t)) onPersist?.(t);
    setDraft('');
    setOpen(false);
  };
  const remove = (tag: string) => onChange(selected.filter((x) => x !== tag));

  if (readOnly) {
    return (
      <div className="tag-input-wrap">
        <div className="tag-chips">
          {selected.length ? (
            selected.map((t) => (
              <span key={t} className="tag-chip">{t}</span>
            ))
          ) : (
            <span style={{ color: 'var(--fg-tertiary)', fontSize: 'var(--font-sm)' }}>—</span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="tag-input-wrap" ref={wrapRef}>
      <div className="tag-chips">
        {selected.map((t) => (
          <span key={t} className="tag-chip">
            {t}
            <button type="button" className="tag-chip-x" onClick={() => remove(t)} aria-label="移除">
              ×
            </button>
          </span>
        ))}
        <input
          className="tag-input"
          placeholder={selected.length ? tc('continueAdding') : placeholder}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              add(draft);
            }
          }}
        />
      </div>
      {quickAdd}
      {open && (rest.length > 0 || draftMatch) && (
        <div className="tag-dropdown">
          {rest.map((o) => (
            <div key={o} className="tag-opt" onMouseDown={() => add(o)}>
              {o}
            </div>
          ))}
          {draftMatch && (
            <div className="tag-opt tag-opt-new" onMouseDown={() => add(draft)}>
              新建标签「{draftTrim}」
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default TagInput;
