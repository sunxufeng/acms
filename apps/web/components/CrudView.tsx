'use client';

import type { CrudColumn } from './CrudPage';
import Markdown from './Markdown';

/** 只读记录渲染器：用于「详情页」展示，不可修改。复用 CrudColumn 定义决定字段顺序与类型。 */
export default function CrudView({ columns, record }: { columns: CrudColumn[]; record: Record<string, unknown> }) {
  // 仅渲染在表单 / 列表中出现的字段（避免内部字段如 *_link 误显示）
  const cols = columns.filter((c) => c.form || c.list !== false);

  function disp(c: CrudColumn): React.ReactNode {
    const v = record[c.key];
    if (c.type === 'attachment') {
      const files = attachmentFiles(v);
      if (!files.length) return <span className="view-empty">—</span>;
      return (
        <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 8 }}>
          {files.map((a, i) => (
            <a key={a.file_token ?? i} href={`/api/v1/files/${a.file_token}`} target="_blank" rel="noreferrer" className="name-link">
              {a.name}
            </a>
          ))}
        </span>
      );
    }
    if (c.type === 'markdown') {
      const text = str(v);
      if (!text.trim()) return <span className="view-empty">—</span>;
      return (
        <div className="md-view">
          <Markdown>{text}</Markdown>
        </div>
      );
    }
    if (c.type === 'date') {
      const t = str(v);
      return t ? <span>{t}</span> : <span className="view-empty">—</span>;
    }
    const text = str(v);
    return text ? <span>{text}</span> : <span className="view-empty">—</span>;
  }

  return (
    <div className="crud-view">
      {cols.map((c) => (
        <div
          key={c.key}
          className="crud-view-field"
          style={c.type === 'textarea' || c.type === 'markdown' ? { gridColumn: '1 / -1' } : undefined}
        >
          <div className="crud-view-label">{c.label}</div>
          <div className="crud-view-value">{disp(c)}</div>
        </div>
      ))}
    </div>
  );
}

function str(v: unknown): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : String((x as { text?: string })?.text ?? ''))).join('、');
  if (typeof v === 'object') return String((v as { text?: string })?.text ?? '');
  return String(v);
}

function attachmentFiles(v: unknown): { file_token: string; name: string }[] {
  if (Array.isArray(v)) return v as { file_token: string; name: string }[];
  if (typeof v === 'string' && v.trim()) {
    try {
      const p = JSON.parse(v);
      if (Array.isArray(p)) return p as { file_token: string; name: string }[];
    } catch {
      /* ignore */
    }
  }
  return [];
}
