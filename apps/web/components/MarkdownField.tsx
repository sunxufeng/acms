'use client';

import { useState, useRef } from 'react';
import { useTranslations } from 'next-intl';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export interface MarkdownFieldProps {
  /** 当前 Markdown 文本 */
  value: string;
  /** 编辑回调；不传则进入只读模式（仅浏览，不显示导入按钮） */
  onChange?: (v: string) => void;
  /** 编辑区高度（px），默认 320 */
  height?: number;
  /** 可选：显示在编辑器上方的说明标签 */
  label?: string;
  /** 可选：编辑区占位提示；不传则用 i18n 默认文案 */
  placeholder?: string;
}

/**
 * 全站统一的 Markdown 编辑器（MD / 浏览双 Tab + MD 导入）。
 *  - MD tab：可编辑的纯文本（仅 onChange 存在时可编辑）
 *  - 浏览 tab：只读渲染后的内容，走 react-markdown + remarkGfm（支持表格、任务列表、删除线）
 *  - MD导入：从本地选择 .md/.markdown/.txt 文件，读入为 Markdown 文本
 * 渲染样式来自 globals.css 的 .md 规则集，与 components/Markdown.tsx 共用同一套。
 * 被 CrudPage 的 markdown 类型字段、ai/agents 各 Tab、ai/skills 等复用。
 */
export default function MarkdownField({
  value,
  onChange,
  height = 320,
  label,
  placeholder,
}: MarkdownFieldProps) {
  const t = useTranslations('common');
  const [tab, setTab] = useState<'md' | 'view'>('md');
  const fileRef = useRef<HTMLInputElement>(null);
  const editable = typeof onChange === 'function';
  const [importError, setImportError] = useState<string | null>(null);

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportError(null);
    try {
      const text = await file.text();
      onChange?.(text);
      setTab('md');
    } catch (err) {
      setImportError(err instanceof Error ? err.message : t('mdImportFailed'));
    } finally {
      e.target.value = '';
    }
  }

  return (
    <div>
      {label && <div className="form-hint" style={{ marginBottom: 8 }}>{label}</div>}

      <div style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden', background: 'var(--bg-input, var(--bg-elevated))' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 8px', borderBottom: '1px solid var(--border)', background: 'var(--bg-hover, rgba(127,127,127,0.06))' }}>
          <button
            type="button"
            onClick={() => setTab('md')}
            className={tab === 'md' ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-ghost'}
            style={{ minWidth: 64 }}
          >
            {t('mdTabMd')}
          </button>
          <button
            type="button"
            onClick={() => setTab('view')}
            className={tab === 'view' ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-ghost'}
            style={{ minWidth: 64 }}
          >
            {t('mdTabView')}
          </button>
          <div style={{ flex: 1 }} />
          {editable && (
            <>
              <button type="button" className="btn btn-outline btn-sm" onClick={() => fileRef.current?.click()}>
                {t('mdImport')}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".md,.markdown,.txt,text/markdown,text/plain"
                style={{ display: 'none' }}
                onChange={handleImport}
              />
            </>
          )}
        </div>

        {tab === 'md' ? (
          <textarea
            className="form-input"
            value={value}
            readOnly={!editable}
            onChange={(e) => onChange?.(e.target.value)}
            rows={Math.max(4, Math.round(height / 22))}
            style={{
              width: '100%',
              minHeight: height,
              border: 'none',
              borderRadius: 0,
              resize: 'vertical',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
              fontSize: 13,
              lineHeight: 1.6,
              background: 'transparent',
            }}
            placeholder={placeholder ?? t('mdPlaceholder')}
          />
        ) : (
          <div style={{ minHeight: height, maxHeight: height * 1.5, overflowY: 'auto', padding: '12px 14px' }}>
            {value && value.trim() ? (
              <div className="md">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{value}</ReactMarkdown>
              </div>
            ) : (
              <span style={{ color: 'var(--fg-tertiary)', fontSize: 'var(--font-sm)' }}>{t('mdEmpty')}</span>
            )}
          </div>
        )}

        {importError && <p className="msg-error" style={{ margin: '6px 8px 8px' }}>{importError}</p>}
      </div>
    </div>
  );
}
