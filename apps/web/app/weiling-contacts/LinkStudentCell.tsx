'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { linkSourceOf, type LinkSource } from '@acms/contracts';
import { api } from '../../lib/api';
import { humanizeError } from '../../lib/errMsg';
import { usePermissions } from '../../lib/permissions';

/**
 * 「联系人管理」列表里「关联学生」这一格（2026-10-01 峰哥需求）。
 *
 * 峰哥原话：「关联学生列再增加一个功能，可以关联学生，具体可参考
 * `/mail-archive` 邮件归档页面『关联』列，可点击 `+ 学生` 手工关联学生」。
 * ⇒ 交互与 `apps/web/app/mail-archive/columns.tsx` 的 `LinkRelatedCell` **同构**：
 *    · 没关联时是一个虚线「+ 学生」按钮，点开即搜即选；
 *    · 已关联时是一个 chip，右侧 `×` 取消关联；
 *    · 自己维护本地状态以获得即时反馈（父级 CrudPage 重拉数据时按 seed 复位）。
 *
 * 🔴 与邮件归档**唯一的实质差别**：那边一个邮件能挂多个学生（id 数组），
 *    这边是**单值**（`关联学生ID` + `关联学生` 两个字段），所以 `+ 学生` 是"从无到有"
 *    或"换一个"，没有"再加一个"的加法语义。这也正是设计里 U4 说"暂不支持多学生"的现状。
 *
 * 🔴 文案复用 `mailArchive` 命名空间的键，**故意的**：峰哥要求"参考邮件归档页"，
 *    两处措辞必须逐字一致（`+ 学生` / `取消关联` / `无匹配学生`…）。
 *    等这一页整体做 i18n 时再把公共键抽出来，现在各自新增一份只会让措辞漂移。
 */
type Cand = { id: string; name: string };

export default function LinkStudentCell({ row }: { row: Record<string, unknown> }) {
  const t = useTranslations('mailArchive');
  const perms = usePermissions();
  /** 维护联系人的权限 —— 与服务端 `requireModule(user,'weilingContacts','update')` 同一档 */
  const canEdit = perms.includes('module:weilingContacts:update');

  const contactId = String(row.id ?? '');
  const seedId = String(row['关联学生ID'] ?? '').trim();
  const seedName = String(row['关联学生'] ?? '').trim();
  const seedSource = linkSourceOf(row);
  const seedReason = String(row['匹配依据'] ?? '');
  const seedScore = Number(row['匹配置信度'] ?? 0);

  const [linked, setLinked] = useState<Cand | null>(seedId ? { id: seedId, name: seedName || seedId } : null);
  const [source, setSource] = useState<LinkSource>(seedSource);
  const [reason, setReason] = useState(seedReason);
  const [score, setScore] = useState(seedScore);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [cands, setCands] = useState<Cand[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [unlinkReason, setUnlinkReason] = useState('');

  /** 父级重拉数据（筛选 / 翻页）后按新值复位 */
  useEffect(() => {
    setLinked(seedId ? { id: seedId, name: seedName || seedId } : null);
    setSource(seedSource);
    setReason(seedReason);
    setScore(seedScore);
    setOpen(false);
    setConfirming(false);
    setQ('');
    setCands([]);
  }, [contactId, seedId, seedName, seedSource, seedReason, seedScore]);

  async function search(term: string) {
    setQ(term);
    const kw = term.trim();
    if (!kw) {
      setCands([]);
      return;
    }
    try {
      const data = await api.listStudents({ q: kw });
      setCands(
        data.items
          .map((s) => ({ id: String(s.id), name: String(s['学生姓名'] ?? s['英文名'] ?? s.id) }))
          .filter((c) => c.id !== linked?.id),
      );
    } catch {
      // 没有 students:read 的角色在这里会 403 —— 静默降级成「无候选」，
      // 不要把权限问题伪装成"功能坏了"（同邮件归档的处理）。
      setCands([]);
    }
  }

  async function pick(c: Cand) {
    setBusy(true);
    try {
      const r = await api.weilingRelinkContact(contactId, c.id);
      // ⚠️ 用服务端回的姓名，不用候选里的 —— 它可能已过期（学生改过名）
      setLinked({ id: r.studentId, name: r.studentName });
      setSource('人工');
      setReason('人工指定');
      setScore(100);
      setOpen(false);
      setQ('');
      setCands([]);
    } catch (e) {
      alert(t('linkFailed', { msg: humanizeError(e) }));
    } finally {
      setBusy(false);
    }
  }

  async function doUnlink() {
    setBusy(true);
    try {
      await api.weilingUnlinkContact(contactId, unlinkReason);
      setLinked(null);
      setSource('已忽略');
      setScore(0);
      setConfirming(false);
      setUnlinkReason('');
    } catch (e) {
      alert(t('unlinkFailed', { msg: humanizeError(e) }));
    } finally {
      setBusy(false);
    }
  }

  async function restoreAuto() {
    setBusy(true);
    try {
      await api.weilingRestoreAutoLink(contactId);
      setSource('自动');
    } catch (e) {
      alert(t('unlinkFailed', { msg: humanizeError(e) }));
    } finally {
      setBusy(false);
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
    // ⚠️ nowrap 是必须的：列宽被挤窄后按钮里的文字会**逐字换行**，变成竖排的「+ 学 生」
    whiteSpace: 'nowrap',
    flexShrink: 0,
  };

  const scoreBadge = (n: number) => {
    const color = n >= 90 ? '#2c6b45' : n >= 70 ? '#7a5c10' : '#6b6b66';
    const bg = n >= 90 ? '#eaf5ee' : n >= 70 ? '#fdf6e8' : '#f0efeb';
    return (
      <span
        title={reason}
        style={{ fontSize: 10, padding: '1px 5px', borderRadius: 8, background: bg, color, whiteSpace: 'nowrap' }}
      >
        {n}
      </span>
    );
  };

  return (
    <div style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4, alignItems: 'center', position: 'relative' }}>
      {linked ? (
        <>
          <span style={chipStyle}>
            {/* 真 <a>（Link 渲染出来的就是 <a href>）：可 Tab 聚焦、可右键复制、可中键新标签页 */}
            <Link
              href={`/students/${encodeURIComponent(linked.id)}`}
              title={t('chipStudent')}
              style={{ color: 'inherit', textDecoration: 'none' }}
            >
              {linked.name}
            </Link>
            {score > 0 ? scoreBadge(score) : null}
            {canEdit ? (
              <button
                type="button"
                className="mail-unlink"
                title={`${t('unlink')}（${linked.name}）`}
                aria-label={`${t('unlink')}（${linked.name}）`}
                disabled={busy}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setConfirming(true);
                }}
                style={{ cursor: busy ? 'progress' : 'pointer' }}
              >
                ×
              </button>
            ) : null}
          </span>
        </>
      ) : source === '已忽略' ? (
        <span
          title={reason}
          style={{
            fontSize: 'var(--font-xs)',
            color: 'var(--fg-tertiary)',
            background: 'var(--table-head-bg)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: '1px 6px',
            whiteSpace: 'nowrap',
          }}
        >
          已忽略关联
        </span>
      ) : null}

      {!linked && canEdit ? (
        <button
          type="button"
          title={t('addStudent')}
          disabled={busy}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setOpen((v) => !v);
          }}
          style={{
            padding: '1px 6px',
            borderRadius: 6,
            border: '1px dashed var(--border)',
            background: 'transparent',
            color: 'var(--fg-secondary)',
            cursor: busy ? 'progress' : 'pointer',
            fontSize: 'var(--font-xs)',
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          {t('linkStudent')}
        </button>
      ) : null}

      {!linked && !canEdit && source !== '已忽略' ? <span style={{ color: 'var(--fg-tertiary)' }}>—</span> : null}

      {/* 已忽略的行给出「恢复自动匹配」的回头路 —— 否则「已忽略」是单向门 */}
      {!linked && source === '已忽略' && canEdit ? (
        <button
          type="button"
          className="link-btn"
          style={{ fontSize: 10 }}
          disabled={busy}
          title="放回自动匹配：下一轮同步会重新按姓名/手机号匹配这条联系人"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            restoreAuto();
          }}
        >
          恢复自动
        </button>
      ) : null}

      {open ? (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            zIndex: 30,
            marginTop: 4,
            width: 280,
            background: 'var(--surface)',
            border: '1px solid var(--border-strong)',
            borderRadius: 'var(--radius-md)',
            boxShadow: 'var(--shadow-card)',
            padding: 8,
          }}
        >
          <input
            autoFocus
            value={q}
            onChange={(e) => search(e.target.value)}
            placeholder={t('searchStudentNamePlaceholder')}
            aria-label={t('addStudent')}
            style={{
              width: '100%',
              padding: '6px 8px',
              borderRadius: 6,
              border: '1px solid var(--border)',
              background: 'var(--surface-input, transparent)',
              color: 'var(--fg)',
              fontSize: 'var(--font-sm)',
            }}
          />
          <div style={{ maxHeight: 200, overflowY: 'auto', marginTop: 6 }}>
            {cands.length === 0 ? (
              <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)', padding: '6px 4px' }}>
                {q.trim() ? t('noMatchStudent') : ''}
              </div>
            ) : (
              cands.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  disabled={busy}
                  onClick={() => pick(c)}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    padding: '6px 8px',
                    borderRadius: 6,
                    border: 'none',
                    background: 'transparent',
                    color: 'var(--fg)',
                    cursor: 'pointer',
                    fontSize: 'var(--font-sm)',
                  }}
                >
                  {c.name}
                </button>
              ))
            )}
          </div>
        </div>
      ) : null}

      {confirming ? (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            zIndex: 30,
            marginTop: 4,
            width: 300,
            background: 'var(--surface)',
            border: '1px solid var(--border-strong)',
            borderRadius: 'var(--radius-md)',
            boxShadow: 'var(--shadow-card)',
            padding: 10,
          }}
        >
          <div style={{ fontSize: 'var(--font-sm)', marginBottom: 6 }}>
            {t('unlinkHint', { name: linked?.name ?? '' })}
          </div>
          {/* 说清三件事里最重要的一件：取消之后**不会再被自动匹配回来** */}
          <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)', marginBottom: 8 }}>
            取消后这条会被标成「已忽略关联」，每天 07:00 的自动同步不会再把它匹配回来。
          </div>
          <input
            value={unlinkReason}
            onChange={(e) => setUnlinkReason(e.target.value)}
            placeholder="原因（可选，默认「误关联」）"
            style={{
              width: '100%',
              padding: '6px 8px',
              borderRadius: 6,
              border: '1px solid var(--border)',
              background: 'var(--surface-input, transparent)',
              color: 'var(--fg)',
              fontSize: 'var(--font-sm)',
              marginBottom: 8,
            }}
          />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirming(false)}>
              {t('cancelEntry')}
            </button>
            <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={doUnlink}>
              {t('unlink')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
