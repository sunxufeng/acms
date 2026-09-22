'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { api } from '../../../lib/api';
import { humanizeError } from '../../../lib/errMsg';
import { useTl } from '../../../lib/useTl';
import { NotePanel } from '../../../components/NotePanel';
import { useTranslations } from 'next-intl';

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
  const t = useTranslations('common');
  const tl = useTl();
  const tm = useTranslations('mailArchive');
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;
  const [rec, setRec] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [atts, setAtts] = useState<AttachmentMeta[]>([]);
  const [busyToken, setBusyToken] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  /** 当前在搜哪一类（学生 / 联系人）—— 一个搜索框两用，避免同时冒出两个输入框 */
  const [linkKind, setLinkKind] = useState<LinkKind>('student');
  const [search, setSearch] = useState('');
  const [cands, setCands] = useState<{ id: string; name: string }[]>([]);
  const [saving, setSaving] = useState(false);

  type Linked = { id: string; name?: string };
  type LinkKind = 'student' | 'contact';

  /** 从详情记录里还原某一类关联（后端把 id 数组放在 `<字段>__link`，姓名串放在 `<字段>`） */
  function linkedOf(field: string): Linked[] {
    const ids = Array.isArray(rec?.[field + '__link']) ? (rec![field + '__link'] as string[]) : [];
    const names = String(rec?.[field] ?? '')
      .split('、')
      .map((s) => s.trim())
      .filter(Boolean);
    return ids.map((id, i) => ({ id, name: names[i] || id }));
  }
  const students = linkedOf('关联学生');
  const contacts = linkedOf('关联联系人');
  const listOf = (kind: LinkKind) => (kind === 'student' ? students : contacts);

  async function refresh() {
    try {
      const r = await api.getMailArchive(id);
      setRec(r);
    } catch {
      /* 忽略刷新失败 */
    }
  }

  async function doSearch(kind: LinkKind, q: string) {
    setLinkKind(kind);
    setLinking(true);
    setSearch(q);
    if (!q.trim()) {
      setCands([]);
      return;
    }
    const kw = q.trim();
    try {
      if (kind === 'student') {
        const data = await api.listStudents({ q: kw });
        setCands(
          data.items
            .map((s) => ({ id: String(s.id), name: String(s['学生姓名'] ?? s['英文名'] ?? s.id) }))
            .filter((c) => !students.some((l) => l.id === c.id)),
        );
      } else {
        // 联系人来自卫瓴同步表：没有 weiling 读权限的角色会 403，静默降级成「无候选」，
        // 不弹错（避免把权限问题伪装成功能坏了）—— 与列表页 LinkRelatedCell 同一口径。
        const data = await api.listWeilingContacts({ q: kw });
        setCands(
          data.items
            .map((s) => ({ id: String(s.id), name: String(s['联系人姓名'] ?? s.id) }))
            .filter((c) => !contacts.some((l) => l.id === c.id)),
        );
      }
    } catch {
      setCands([]);
    }
  }

  async function addLink(kind: LinkKind, targetId: string) {
    const cur = listOf(kind);
    if (cur.some((l) => l.id === targetId)) return;
    setSaving(true);
    try {
      const nextIds = [...cur.map((l) => l.id), targetId];
      if (kind === 'student') await api.linkMailStudents(id, nextIds);
      else await api.linkMailContacts(id, nextIds);
      setLinking(false);
      setSearch('');
      setCands([]);
      await refresh();
    } catch (e) {
      alert(tm('linkFailed', { msg: humanizeError(e) }));
    } finally {
      setSaving(false);
    }
  }

  /** 取消关联：传**剩余** id 列表（传 [] 即清空该类） */
  async function removeLink(kind: LinkKind, targetId: string) {
    setSaving(true);
    try {
      const nextIds = listOf(kind)
        .filter((l) => l.id !== targetId)
        .map((l) => l.id);
      if (kind === 'student') await api.linkMailStudents(id, nextIds);
      else await api.linkMailContacts(id, nextIds);
      await refresh();
    } catch (e) {
      alert(tm('unlinkFailed', { msg: humanizeError(e) }));
    } finally {
      setSaving(false);
    }
  }

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
      alert(tm('getDownloadUrlFailed', { msg: humanizeError(e) }));
    } finally {
      setBusyToken(null);
    }
  };

  if (loading) return <div style={{ padding: 32 }}>{t('loading')}</div>;
  if (err) return <div style={{ padding: 32, color: 'var(--fg-error)' }}>加载失败：{err}</div>;
  if (!rec) return null;

  const body = String(rec['正文'] ?? tm('noBody'));

  /**
   * 渲染一类关联（学生 / 联系人）：已关联的标签（可点进详情、可 × 取消）+ 「+ 加入」入口。
   *
   * 两类共用一份实现 —— 详情页此前**只做了「关联学生」**，联系人的入口只在列表页有，
   * 老师从详情页进来就找不到（2026-09-23 补齐；两类走的是同一个接口，只传一类时另一类不动）。
   */
  function renderLinks(kind: LinkKind) {
    const list = listOf(kind);
    const isStudent = kind === 'student';
    const searching = linking && linkKind === kind;
    return (
      <>
        <span>{isStudent ? tl('关联学生') : tm('relatedContact')}</span>
        <span style={{ color: 'var(--fg)' }}>
          {list.length === 0 && !searching && <span style={{ color: 'var(--fg-tertiary)' }}>{tm('notLinked')}</span>}
          <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            {list.map((l) => (
              <span
                key={`${kind}:${l.id}`}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '1px 4px 1px 6px',
                  borderRadius: 6,
                  background: isStudent ? 'var(--accent-muted)' : 'var(--success-muted)',
                  color: isStudent ? 'var(--accent)' : 'var(--success)',
                  fontSize: 13,
                }}
              >
                <Link href={isStudent ? `/students/${l.id}` : `/weiling-contacts/${l.id}`} style={{ color: 'inherit' }}>
                  {l.name || l.id}
                </Link>
                <button
                  type="button"
                  /** 取消关联入口：悬停转红 + 写明「取消与 X 的关联」（原来是个不显眼的 ×） */
                  className="mail-unlink"
                  title={tm('unlinkHint', { name: l.name || l.id })}
                  aria-label={tm('unlinkHint', { name: l.name || l.id })}
                  disabled={saving}
                  onClick={() => void removeLink(kind, l.id)}
                  style={{ cursor: saving ? 'progress' : 'pointer' }}
                >
                  ×
                </button>
              </span>
            ))}
            {searching ? (
              <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 4, minWidth: 220 }}>
                <input
                  autoFocus
                  value={search}
                  placeholder={isStudent ? tm('searchStudentPlaceholder') : tm('searchContactPlaceholder')}
                  onChange={(e) => void doSearch(kind, e.target.value)}
                  style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border)', fontSize: 13 }}
                />
                {cands.length > 0 && (
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 2, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-elevated)', padding: 4 }}>
                    {cands.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        disabled={saving}
                        onClick={() => void addLink(kind, c.id)}
                        style={{ textAlign: 'left', border: 'none', background: 'transparent', color: 'var(--fg)', cursor: 'pointer', padding: '4px 6px', borderRadius: 4, fontSize: 13 }}
                      >
                        {c.name}
                      </button>
                    ))}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setLinking(false);
                    setSearch('');
                    setCands([]);
                  }}
                  style={{ fontSize: 12, color: 'var(--fg-tertiary)', background: 'transparent', border: 'none', cursor: 'pointer' }}
                >
                  {tm('cancelEntry')}
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setLinkKind(kind);
                  setLinking(true);
                  setSearch('');
                  setCands([]);
                }}
                style={{ padding: '2px 8px', borderRadius: 6, border: '1px dashed var(--border)', background: 'transparent', color: 'var(--accent)', cursor: 'pointer', fontSize: 13, whiteSpace: 'nowrap' }}
              >
                {isStudent ? tm('addStudent') : tm('addContact')}
              </button>
            )}
          </span>
        </span>
      </>
    );
  }

  return (
    <div style={{ maxWidth: 920, margin: '0 auto', padding: '24px 16px 64px' }}>
      <div style={{ marginBottom: 16 }}>
        <Link href="/mail-archive" style={{ color: 'var(--accent)', fontSize: 14 }}>
          ← 返回邮件归档
        </Link>
      </div>

      <h1 style={{ fontSize: 20, margin: '8px 0', wordBreak: 'break-word' }}>{String(rec['主题'] ?? tm('noSubject'))}</h1>

      <div style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '6px 16px', fontSize: 14, color: 'var(--fg-secondary)', marginBottom: 20 }}>
        <span>{tl('发件人')}</span><span style={{ color: 'var(--fg)' }}>{String(rec['发件人'] ?? '')}</span>
        <span>{tl('收件人')}</span><span style={{ color: 'var(--fg)' }}>{String(rec['收件人'] ?? '')}</span>
        <span>{tm('cc')}</span><span style={{ color: 'var(--fg)' }}>{String(rec['抄送'] ?? '')}</span>
        <span>{tl('归属账户')}</span><span style={{ color: 'var(--fg)' }}>{String(rec['归属账户'] ?? '')}</span>
        {renderLinks('student')}
        {renderLinks('contact')}
        <span>{tl('发送时间')}</span><span style={{ color: 'var(--fg)' }}>{String(rec['发送时间'] ?? '')}</span>
        <span>{tm('receivedAt')}</span><span style={{ color: 'var(--fg)' }}>{String(rec['收取时间'] ?? '')}</span>
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

      {/* ── 关联笔记（得到大脑） ─────────── */}
      <NotePanel
        entityType="邮件归档"
        entityId={id}
        entityName={String(rec['主题'] ?? '')}
        seedTitle={String(rec['主题'] ?? '')}
        seedContent={body}
      />
    </div>
  );
}
