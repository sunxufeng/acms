'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, type GetnoteLink } from '../lib/api';
import { useTranslations } from 'next-intl';

/** 语义搜索召回的候选笔记 */
interface Candidate {
  noteId: string;
  label: string;
}

/**
 * 业务实体详情页的「关联笔记」面板。
 *
 * 关联机制是**标签 + 映射表双写**（后端 GetnoteService 负责）：
 *  - 飞书「笔记关联」映射表 —— 让 ACMS 能按实体查笔记
 *  - 笔记上的 `acms:<类型>:<ID>` 标签 —— 在 Get笔记 App 里也能看出归属
 *
 * ⚠️ 写入采用**全量覆盖式 PUT**（与邮件归档「手动关联学生」同一范式）：
 * UI 上是 chip 增删，提交时始终传最终完整名单，传空数组即清空。
 * 所以每次增删都要先拿到当前 links 再整体回写，不能只发增量。
 */
export interface NotePanelProps {
  /** 业务实体类型，必须与后端 ENTITY_TAG 的中文 key 一致（如「学生档案」「家校沟通」） */
  entityType: string;
  /** 业务实体记录 ID（飞书 recordId） */
  entityId: string;
  /** 实体展示名，写进映射表便于事后核对 */
  entityName?: string;
  /** 反向归档：新建笔记时预填的标题 */
  seedTitle?: string;
  /** 反向归档：新建笔记时预填的正文 */
  seedContent?: string;
  /** 外部新增了关联笔记时递增此值，面板会重新拉取（如「存为笔记」之后） */
  reloadKey?: number;
}

/**
 * 从飞书关联字段里取出展示文本，用于 entityName。
 * 关联字段（type=18）的取值形态不固定：可能是 `[{text,record_ids}]`、`{text}` 或纯字符串。
 */
export function linkText(v: unknown): string {
  if (Array.isArray(v)) return v.length ? linkText(v[0]) : '';
  if (v && typeof v === 'object') return String((v as { text?: string }).text ?? '');
  return String(v ?? '');
}

/**
 * 记录字段 → 展示文本（给「存为笔记」拼正文用）。
 * 与 linkText 的区别：数组会全部展开并用「、」连接，而 linkText 只取第一个。
 */
export function fieldText(v: unknown): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(fieldText).filter(Boolean).join('、');
  if (typeof v === 'object') return String((v as { text?: string }).text ?? '');
  return String(v);
}

/** recall 返回的字段是 note_id/title/content；标题可能为空，用正文片段兜底 */
function toCandidate(r: Record<string, unknown>): Candidate {
  const noteId = String(r.note_id ?? r.id ?? '');
  const title = String(r.title ?? '').trim();
  const snippet = String(r.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return { noteId, label: title || snippet || noteId };
}

export function NotePanel({
  entityType,
  entityId,
  entityName = '',
  seedTitle = '',
  seedContent = '',
  reloadKey = 0,
}: NotePanelProps) {
  const t = useTranslations('getnote');

  const [links, setLinks] = useState<GetnoteLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const [picking, setPicking] = useState(false);
  const [kw, setKw] = useState('');
  const [cands, setCands] = useState<Candidate[]>([]);
  const [searching, setSearching] = useState(false);

  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState(seedTitle);
  const [content, setContent] = useState(seedContent);

  /**
   * 当前用户是否连好了自己的得到大脑账号。
   * 关联记录本身走飞书（全员可见），但「搜索笔记」和「新建笔记」必须打 Get笔记 API，
   * 没凭证就一定失败 —— 所以这里提前拦住并引导，而不是让用户撞 412。
   */
  const [credOk, setCredOk] = useState<boolean | null>(null);

  useEffect(() => {
    api
      .getGetnoteCredential()
      .then((c) => setCredOk(Boolean(c?.configured)))
      .catch(() => setCredOk(false));
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setLinks(await api.listGetnoteLinks(entityType, entityId));
    } catch (e) {
      setError((e as Error).message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, [entityType, entityId]);

  useEffect(() => {
    void reload();
  }, [reload, reloadKey]);

  /** 语义搜索防抖。Get笔记 只有语义召回，没有关键字匹配接口。 */
  useEffect(() => {
    if (!picking) return;
    const q = kw.trim();
    if (!q) {
      setCands([]);
      return;
    }
    const timer = setTimeout(() => {
      setSearching(true);
      api
        .searchGetnote(q, 10)
        .then((rows) => setCands(rows.map(toCandidate).filter((c) => c.noteId)))
        .catch(() => setCands([]))
        .finally(() => setSearching(false));
    }, 350);
    return () => clearTimeout(timer);
  }, [kw, picking]);

  /** 全量覆盖式回写。⚠️ 传的是最终完整名单，不是增量。 */
  const persist = async (next: { noteId: string; title?: string }[]) => {
    setSaving(true);
    setError('');
    try {
      await api.replaceGetnoteLinks(entityType, entityId, entityName, next);
      await reload();
    } catch (e) {
      setError(t('opFailed', { msg: (e as Error).message ?? String(e) }));
    } finally {
      setSaving(false);
    }
  };

  const closePicker = () => {
    setPicking(false);
    setKw('');
    setCands([]);
  };

  const addLink = async (c: Candidate) => {
    closePicker();
    if (links.some((l) => l.noteId === c.noteId)) return;
    await persist([...links.map((l) => ({ noteId: l.noteId, title: l.title })), { noteId: c.noteId, title: c.label }]);
  };

  const removeLink = (noteId: string) =>
    persist(links.filter((l) => l.noteId !== noteId).map((l) => ({ noteId: l.noteId, title: l.title })));

  const submitCreate = async () => {
    setSaving(true);
    setError('');
    try {
      await api.createAndLinkGetnote({
        title: title.trim(),
        content,
        entityType,
        entityId,
        entityName,
      });
      setTitle('');
      setContent('');
      setCreating(false);
      await reload();
    } catch (e) {
      setError(t('opFailed', { msg: (e as Error).message ?? String(e) }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="card" style={{ padding: 16, marginTop: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <h2 style={{ fontSize: 15, margin: 0 }}>{t('linkedNotes')}</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={saving || !credOk}
            onClick={() => {
              setCreating(false);
              setPicking((v) => !v);
            }}
          >
            + {t('linkNote')}
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={saving || !credOk}
            onClick={() => {
              closePicker();
              setTitle(seedTitle);
              setContent(seedContent);
              setCreating((v) => !v);
            }}
          >
            + {t('newNote')}
          </button>
        </div>
      </div>

      {error && (
        <p className="muted" style={{ color: 'var(--fg-error)', marginTop: 0 }}>
          {error}
        </p>
      )}

      {credOk === false && (
        <p className="muted" style={{ marginTop: 0 }}>
          {t('keyRequired')}
          {' · '}
          <Link href="/getnote" style={{ color: 'var(--accent)' }}>
            {t('goToKnowledgeBase')}
          </Link>
        </p>
      )}

      {loading ? (
        <p className="muted" style={{ margin: 0 }}>{t('loading')}</p>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          {links.length === 0 && <span className="muted">{t('notLinked')}</span>}
          {links.map((l) => (
            <span
              key={l.id}
              title={l.noteId}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                padding: '2px 6px',
                borderRadius: 6,
                background: 'var(--accent-muted)',
                color: 'var(--accent)',
                fontSize: 13,
              }}
            >
              {l.title || l.noteId}
              {l.linkedBy && (
                <span style={{ fontSize: 11, opacity: 0.65, whiteSpace: 'nowrap' }}>
                  {t('linkedByLabel', { name: l.linkedBy })}
                </span>
              )}
              <button
                type="button"
                title={t('unlink')}
                disabled={saving}
                onClick={() => removeLink(l.noteId)}
                style={{
                  border: 'none',
                  background: 'transparent',
                  color: 'inherit',
                  cursor: 'pointer',
                  fontSize: 14,
                  lineHeight: 1,
                  padding: 0,
                }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {picking && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 10, minWidth: 240 }}>
          <input
            autoFocus
            value={kw}
            placeholder={t('searchPlaceholder')}
            onChange={(e) => setKw(e.target.value)}
            style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border)', fontSize: 13 }}
          />
          {searching && <span className="muted" style={{ fontSize: 12 }}>{t('searching')}</span>}
          {!searching && kw.trim() && cands.length === 0 && (
            <span className="muted" style={{ fontSize: 12 }}>
              {t('noMatch')} · {t('searchOwnOnly')}
            </span>
          )}
          {cands.length > 0 && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
                border: '1px solid var(--border)',
                borderRadius: 6,
                background: 'var(--bg-elevated)',
                padding: 4,
              }}
            >
              {cands.map((c) => (
                <button
                  key={c.noteId}
                  type="button"
                  disabled={saving}
                  onClick={() => addLink(c)}
                  style={{
                    textAlign: 'left',
                    border: 'none',
                    background: 'transparent',
                    color: 'var(--fg)',
                    cursor: 'pointer',
                    padding: '4px 6px',
                    borderRadius: 4,
                    fontSize: 13,
                  }}
                >
                  {c.label}
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            onClick={closePicker}
            style={{ fontSize: 12, color: 'var(--fg-tertiary)', background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }}
          >
            {t('cancel')}
          </button>
        </div>
      )}

      {creating && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
          <input
            value={title}
            placeholder={t('titleLabel')}
            onChange={(e) => setTitle(e.target.value)}
            style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border)', fontSize: 13 }}
          />
          <textarea
            value={content}
            placeholder={t('contentLabel')}
            onChange={(e) => setContent(e.target.value)}
            rows={6}
            style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border)', fontSize: 13, resize: 'vertical' }}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn btn-primary btn-sm" disabled={saving} onClick={submitCreate}>
              {t('save')}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={saving}
              onClick={() => {
                setCreating(false);
                setTitle('');
                setContent('');
              }}
            >
              {t('cancel')}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

export default NotePanel;
