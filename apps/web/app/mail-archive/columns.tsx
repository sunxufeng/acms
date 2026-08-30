import { useState } from 'react';
import type { CrudColumn } from '../../components/CrudPage';
import { api } from '../../lib/api';

type AttMeta = { name: string; size: number; type: string; file_token: string };

/** 「附件信息」字段是 JSON 字符串；历史记录可能已是数组，两种形态都要兼容 */
function parseAtts(raw: unknown): AttMeta[] {
  if (Array.isArray(raw)) return raw as AttMeta[];
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const p = JSON.parse(raw) as unknown;
      if (Array.isArray(p)) return p as AttMeta[];
    } catch {
      /* 解析失败按无附件处理 */
    }
  }
  return [];
}

function fmtSize(n: number): string {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 附件单元格：直接列出附件名，点击即换取下载链接并打开 */
function AttachmentCell({ row }: { row: Record<string, unknown> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const atts = parseAtts(row['附件信息']);
  const failed = String(row['附件失败原因'] ?? '').trim();
  const recordId = String(row.id ?? '');

  if (atts.length === 0 && !failed) {
    return <span style={{ color: 'var(--fg-tertiary)' }}>—</span>;
  }

  async function download(token: string) {
    if (!recordId) return;
    setBusy(token);
    try {
      const { url } = await api.getMailAttachmentUrl(recordId, token);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch {
      alert('附件下载链接获取失败，请稍后重试');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
      {atts.map((a) => (
        <button
          key={a.file_token}
          type="button"
          title={`${a.name}${a.size ? ` (${fmtSize(a.size)})` : ''}`}
          disabled={busy === a.file_token}
          onClick={() => download(a.file_token)}
          style={{
            maxWidth: 170,
            display: 'flex',
            gap: 6,
            alignItems: 'baseline',
            padding: '2px 8px',
            borderRadius: 6,
            border: '1px solid var(--border)',
            background: 'var(--bg-elevated)',
            color: 'var(--accent)',
            cursor: busy === a.file_token ? 'progress' : 'pointer',
            fontSize: 'var(--font-xs)',
            textAlign: 'left',
          }}
        >
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
          {a.size ? (
            <span style={{ color: 'var(--fg-tertiary)', flexShrink: 0 }}>
              {busy === a.file_token ? '…' : fmtSize(a.size)}
            </span>
          ) : null}
        </button>
      ))}
      {failed && (
        <span
          title={failed}
          style={{
            padding: '2px 8px',
            borderRadius: 6,
            border: '1px solid var(--danger, #e5484d)',
            color: 'var(--danger, #e5484d)',
            fontSize: 'var(--font-xs)',
          }}
        >
          有附件上传失败
        </span>
      )}
    </div>
  );
}

export const COLUMNS: CrudColumn[] = [
  {
    key: '邮件方向',
    label: '方向',
    width: '84px',
    filter: true,
    filterOptions: ['收件', '发件'],
    render: (v) => {
      const s = String(v ?? '');
      if (s !== '收件' && s !== '发件') return <span style={{ color: 'var(--fg-tertiary)' }}>—</span>;
      const isSent = s === '发件';
      return (
        <span
          className="badge"
          style={{
            background: isSent ? 'var(--success-muted)' : 'var(--accent-muted)',
            color: isSent ? 'var(--success)' : 'var(--accent)',
          }}
        >
          {s}
        </span>
      );
    },
  },
  { key: '发件人', label: '发件人', width: '200px', filter: true, openRecord: true },
  { key: '收件人', label: '收件人', width: '200px', filter: true },
  { key: '主题', label: '主题', width: '300px', openRecord: true },
  { key: '归属账户', label: '归属账户', width: '130px', filter: true },
  { key: '邮箱文件夹', label: '文件夹', width: '140px', filter: true },
  {
    key: '关联学生',
    label: '关联学生',
    width: '140px',
    filter: true,
    // API（linkField）返回：关联学生=姓名串；关联学生__link=学生 id 数组。二者并行对应。
    render: (v, row) => {
      const ids = Array.isArray(row['关联学生__link']) ? (row['关联学生__link'] as string[]) : [];
      if (ids.length === 0) return <span style={{ color: 'var(--fg-tertiary)' }}>—</span>;
      const names = String(v ?? '')
        .split('、')
        .map((s) => s.trim())
        .filter(Boolean);
      return (
        <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4 }}>
          {ids.map((id, i) => (
            <span key={id} style={{ padding: '1px 6px', borderRadius: 6, background: 'var(--accent-muted)', color: 'var(--accent)', fontSize: 'var(--font-xs)' }}>
              {names[i] || id}
            </span>
          ))}
        </span>
      );
    },
  },
  { key: '发送时间', label: '发送时间', width: '170px', type: 'datetime' },
  { key: '附件数', label: '附件', width: '190px', type: 'number', render: (_v, row) => <AttachmentCell row={row} /> },
  { key: '是否已读', label: '已读', width: '90px', type: 'select', options: ['是', '否'], filter: true },
];
