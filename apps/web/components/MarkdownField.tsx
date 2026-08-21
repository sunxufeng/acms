'use client';

import { useState, useRef } from 'react';
import Markdown from './Markdown';

export interface MarkdownFieldProps {
  /** 当前 Markdown 文本 */
  value: string;
  /** 编辑回调；不传则进入只读模式（仅浏览，不显示导入按钮） */
  onChange?: (v: string) => void;
  /** 编辑区高度（px），默认 320 */
  height?: number;
}

/**
 * 双 Tab 的 Markdown 编辑/浏览组件：
 *  - MD tab：可编辑的纯文本（仅 onChange 存在时可编辑）
 *  - 浏览 tab：只读渲染后的标准格式内容（不可修改）
 *  - MD导入：从本地选择 .md/.markdown/.txt 文件，读入为 Markdown 文本
 * 被「沟通明细（MD 对话记录）」「沟通总结（报告）」等字段复用。
 */
export default function MarkdownField({ value, onChange, height = 320 }: MarkdownFieldProps) {
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
      setImportError(err instanceof Error ? err.message : '导入失败');
    } finally {
      e.target.value = '';
    }
  }

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden', background: 'var(--bg-input, var(--bg-elevated))' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 8px', borderBottom: '1px solid var(--border)', background: 'var(--bg-hover, rgba(127,127,127,0.06))' }}>
        <button
          type="button"
          onClick={() => setTab('md')}
          className={tab === 'md' ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-ghost'}
          style={{ minWidth: 64 }}
        >
          MD
        </button>
        <button
          type="button"
          onClick={() => setTab('view')}
          className={tab === 'view' ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-ghost'}
          style={{ minWidth: 64 }}
        >
          浏览
        </button>
        <div style={{ flex: 1 }} />
        {editable && (
          <>
            <button type="button" className="btn btn-outline btn-sm" onClick={() => fileRef.current?.click()}>
              MD 导入
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
          placeholder="在此输入 / 粘贴 Markdown 内容…"
        />
      ) : (
        <div style={{ minHeight: height, maxHeight: height * 1.5, overflowY: 'auto', padding: '12px 14px' }}>
          {value && value.trim() ? (
            <Markdown>{value}</Markdown>
          ) : (
            <span style={{ color: 'var(--fg-tertiary)', fontSize: 'var(--font-sm)' }}>暂无内容</span>
          )}
        </div>
      )}

      {importError && <p className="msg-error" style={{ margin: '6px 8px 8px' }}>{importError}</p>}
    </div>
  );
}
