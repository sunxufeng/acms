import { useEffect, useState, type CSSProperties } from 'react';
import { useTranslations } from 'next-intl';
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
  const t = useTranslations('mailArchive');
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
      alert(t('attachmentUrlFailed'));
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

type Linked = { id: string; name: string };

/**
 * 列表页「关联学生」单元格：内联搜索 + 关联/解除，无需进入详情页。
 * 与详情页逻辑一致，区别在于此处自维护本地 linked 状态以获得即时反馈；
 * 父级 CrudPage 重新拉取数据时（过滤/翻页）通过 seed 同步重置。
 */
function LinkStudentCell({ row }: { row: Record<string, unknown> }) {
  const t = useTranslations('mailArchive');
  const recordId = String(row.id ?? '');
  const seedIds = Array.isArray(row['关联学生__link']) ? (row['关联学生__link'] as string[]) : [];
  const seedNames = String(row['关联学生'] ?? '')
    .split('、')
    .map((s) => s.trim())
    .filter(Boolean);

  const [linked, setLinked] = useState<Linked[]>(() =>
    seedIds.map((id, i) => ({ id, name: seedNames[i] || id })),
  );
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [cands, setCands] = useState<Linked[]>([]);
  const [saving, setSaving] = useState(false);

  // 父级重拉数据后保持同步（row.id 不变、仅关联值变化时也会重置面板）
  useEffect(() => {
    setLinked(seedIds.map((id, i) => ({ id, name: seedNames[i] || id })));
    setOpen(false);
    setQ('');
    setCands([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordId, seedIds.join(','), seedNames.join(',')]);

  async function doSearch(term: string) {
    setQ(term);
    if (!term.trim()) {
      setCands([]);
      return;
    }
    try {
      const data = await api.listStudents({ q: term.trim() });
      const next = data.items
        .map((s) => ({ id: s.id, name: String(s['学生姓名'] ?? s['英文名'] ?? s.id) }))
        .filter((c) => !linked.some((l) => l.id === c.id));
      setCands(next);
    } catch {
      setCands([]);
    }
  }

  async function addLink(student: Linked) {
    if (linked.some((l) => l.id === student.id)) return;
    setSaving(true);
    try {
      await api.linkMailStudents(recordId, [...linked.map((l) => l.id), student.id]);
      setLinked([...linked, student]);
      setOpen(false);
      setQ('');
      setCands([]);
    } catch (e) {
      alert(t('linkFailed', { msg: String((e as { message?: string })?.message ?? e) }));
    } finally {
      setSaving(false);
    }
  }

  async function removeLink(id: string) {
    setSaving(true);
    try {
      await api.linkMailStudents(
        recordId,
        linked.filter((l) => l.id !== id).map((l) => l.id),
      );
      setLinked(linked.filter((l) => l.id !== id));
    } catch (e) {
      alert(t('unlinkFailed', { msg: String((e as { message?: string })?.message ?? e) }));
    } finally {
      setSaving(false);
    }
  }

  const chipStyle: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '1px 4px 1px 6px',
    borderRadius: 6,
    background: 'var(--accent-muted)',
    color: 'var(--accent)',
    fontSize: 'var(--font-xs)',
  };

  return (
    <div style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4, alignItems: 'center', position: 'relative' }}>
      {linked.map((l) => (
        <span key={l.id} style={chipStyle}>
          <a href={`/students/${l.id}`} style={{ color: 'inherit', textDecoration: 'none' }}>
            {l.name}
          </a>
          <button
            type="button"
            title={t('unlink')}
            disabled={saving}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              removeLink(l.id);
            }}
            style={{
              border: 'none',
              background: 'transparent',
              color: 'inherit',
              cursor: saving ? 'progress' : 'pointer',
              padding: 0,
              lineHeight: 1,
              fontSize: 'var(--font-sm)',
            }}
          >
            ×
          </button>
        </span>
      ))}
      <button
        type="button"
        disabled={saving}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        style={{
          padding: '1px 6px',
          borderRadius: 6,
          border: '1px dashed var(--border)',
          background: 'transparent',
          color: 'var(--fg-secondary)',
          cursor: saving ? 'progress' : 'pointer',
          fontSize: 'var(--font-xs)',
        }}
      >
        + 关联学生
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            zIndex: 20,
            marginTop: 4,
            width: 240,
            padding: 8,
            borderRadius: 8,
            border: '1px solid var(--border)',
            background: 'var(--bg-elevated)',
            boxShadow: 'var(--shadow-md)',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <input
            autoFocus
            value={q}
            onChange={(e) => doSearch(e.target.value)}
            placeholder={t('searchStudentNamePlaceholder')}
            style={{
              width: '100%',
              padding: '4px 8px',
              borderRadius: 6,
              border: '1px solid var(--border)',
              background: 'var(--bg)',
              color: 'var(--fg)',
              fontSize: 'var(--font-sm)',
            }}
          />
          <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 220, overflowY: 'auto' }}>
            {cands.length === 0 && (
              <span style={{ color: 'var(--fg-tertiary)', fontSize: 'var(--font-xs)' }}>
                {q.trim() ? t('noMatchStudent') : t('enterKeywordSearch')}
              </span>
            )}
            {cands.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => addLink(c)}
                style={{
                  textAlign: 'left',
                  padding: '4px 8px',
                  borderRadius: 6,
                  border: '1px solid var(--border)',
                  background: 'var(--bg)',
                  color: 'var(--fg)',
                  cursor: 'pointer',
                  fontSize: 'var(--font-sm)',
                }}
              >
                {c.name}
              </button>
            ))}
          </div>
        </div>
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
    width: '160px',
    filter: true,
    // API（linkField）返回：关联学生=姓名串；关联学生__link=学生 id 数组。列表页内联交互关联。
    render: (_v, row) => <LinkStudentCell row={row} />,
  },
  { key: '发送时间', label: '发送时间', width: '170px', type: 'datetime' },
  { key: '附件数', label: '附件', width: '190px', type: 'number', render: (_v, row) => <AttachmentCell row={row} /> },
  { key: '是否已读', label: '已读', width: '90px', type: 'select', options: ['是', '否'], filter: true },
];
