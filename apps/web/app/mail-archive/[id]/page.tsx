'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { api } from '../../../lib/api';

interface AttachmentMeta {
  name: string;
  size: number;
  type: string;
  file_token: string;
}

function fmtSize(n?: number): string {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function MailArchiveDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;
  const [rec, setRec] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [atts, setAtts] = useState<AttachmentMeta[]>([]);
  const [busyToken, setBusyToken] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .getMailArchive(id)
      .then((r) => {
        if (!alive) return;
        setRec(r);
        try {
          const raw = r['附件信息'];
          const arr = typeof raw === 'string' && raw.trim() ? JSON.parse(raw) : [];
          if (Array.isArray(arr)) setAtts(arr as AttachmentMeta[]);
        } catch {
          setAtts([]);
        }
      })
      .catch((e) => alive && setErr(String(e?.message ?? e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [id]);

  const download = async (token: string) => {
    setBusyToken(token);
    try {
      const { url } = await api.getMailAttachmentUrl(id, token);
      window.open(url, '_blank', 'noopener');
    } catch (e) {
      alert('获取下载链接失败：' + String((e as { message?: string })?.message ?? e));
    } finally {
      setBusyToken(null);
    }
  };

  if (loading) return <div style={{ padding: 32 }}>加载中…</div>;
  if (err) return <div style={{ padding: 32, color: 'var(--fg-error)' }}>加载失败：{err}</div>;
  if (!rec) return null;

  const body = String(rec['正文'] ?? '(无正文)');

  return (
    <div style={{ maxWidth: 920, margin: '0 auto', padding: '24px 16px 64px' }}>
      <div style={{ marginBottom: 16 }}>
        <Link href="/mail-archive" style={{ color: 'var(--accent)', fontSize: 14 }}>
          ← 返回邮件归档
        </Link>
      </div>

      <h1 style={{ fontSize: 20, margin: '8px 0', wordBreak: 'break-word' }}>{String(rec['主题'] ?? '(无主题)')}</h1>

      <div style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '6px 16px', fontSize: 14, color: 'var(--fg-secondary)', marginBottom: 20 }}>
        <span>发件人</span><span style={{ color: 'var(--fg)' }}>{String(rec['发件人'] ?? '')}</span>
        <span>收件人</span><span style={{ color: 'var(--fg)' }}>{String(rec['收件人'] ?? '')}</span>
        <span>抄送</span><span style={{ color: 'var(--fg)' }}>{String(rec['抄送'] ?? '')}</span>
        <span>归属账户</span><span style={{ color: 'var(--fg)' }}>{String(rec['归属账户'] ?? '')}</span>
        <span>关联学生</span><span style={{ color: 'var(--fg)' }}>{String(rec['关联学生'] ?? '')}</span>
        <span>发送时间</span><span style={{ color: 'var(--fg)' }}>{String(rec['发送时间'] ?? '')}</span>
        <span>收取时间</span><span style={{ color: 'var(--fg)' }}>{String(rec['收取时间'] ?? '')}</span>
      </div>

      {atts.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>附件（{atts.length}）</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {atts.map((a) => (
              <button
                key={a.file_token}
                onClick={() => download(a.file_token)}
                disabled={busyToken === a.file_token}
                style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
                  padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)',
                  background: 'var(--bg-elevated)', cursor: 'pointer', color: 'var(--fg)',
                }}
              >
                <span style={{ fontSize: 13, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
                <span style={{ fontSize: 11, color: 'var(--fg-tertiary)' }}>{fmtSize(a.size)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div
        style={{
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          lineHeight: 1.7,
          fontSize: 14,
          borderTop: '1px solid var(--border)',
          paddingTop: 16,
          color: 'var(--fg)',
        }}
      >
        {body}
      </div>
    </div>
  );
}
