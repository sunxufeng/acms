'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, type MyFollowupItem, type MyFollowupsResp } from '../../lib/api';
import { FilterSelect } from '../../components/FilterSelect';
import { formatDate } from '../../lib/date';
import { useTranslations } from 'next-intl';

const PAGE_SIZE = 20;

type Kind = 'progress' | 'source' | 'mail';

/**
 * 展开状态写进地址栏（`?open=<联系人 id>`）。
 *
 * 目的：刷新、从联系人档案返回后**仍是展开的**，用户不用再点一次。
 * ⚠️ 不用 `useSearchParams` —— 那要求页面被 Suspense 包裹，而这里只是在
 *    挂载时读一次、点击时改一次，直接用 `window.location` 更省事也更稳。
 */
function readOpenFromUrl(): string {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get('open') ?? '';
}
function writeOpenToUrl(id: string): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (id) url.searchParams.set('open', id);
  else url.searchParams.delete('open');
  window.history.replaceState(null, '', url.toString());
}

/** 「查看全部」的去处：跟进记录在联系人档案里，另两类各回自己的列表（带上该联系人筛选） */
function hrefOf(kind: Kind, it: MyFollowupItem): string {
  if (kind === 'progress') return `/weiling-contacts/${it.id}`;
  if (kind === 'source') return `/source-followups?关联联系人__has=${it.id}`;
  return `/mail-archive?related=${encodeURIComponent(it.name)}`;
}

function kindLabelKey(kind: Kind): string {
  return kind === 'progress' ? 'kindProgress' : kind === 'source' ? 'kindSource' : 'kindMail';
}

export default function MyFollowupsPage() {
  const t = useTranslations('myFollowups');

  const [q, setQ] = useState('');
  const [owner, setOwner] = useState('');
  const [stage, setStage] = useState('');
  const [channel, setChannel] = useState('');
  const [allScope, setAllScope] = useState(false);
  const [page, setPage] = useState(1);

  const [data, setData] = useState<MyFollowupsResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [openId, setOpenId] = useState('');
  const [hoverId, setHoverId] = useState<string | null>(null);
  /** 只有真正支持悬停的设备才做 hover 预览（手机上会变成"点一下就弹"的干扰） */
  const [canHover, setCanHover] = useState(false);

  useEffect(() => {
    setOpenId(readOpenFromUrl());
    if (typeof window !== 'undefined' && window.matchMedia) {
      setCanHover(window.matchMedia('(hover: hover)').matches);
    }
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    setErr('');
    api
      .listMyFollowups({
        q,
        owner,
        page: String(page),
        pageSize: String(PAGE_SIZE),
        scope: allScope ? 'all' : 'active',
        ...(stage ? { 阶段: stage } : {}),
        ...(channel ? { 来源渠道: channel } : {}),
      })
      .then(setData)
      .catch((e) => {
        setErr(String((e as Error)?.message ?? e));
        setData(null);
      })
      .finally(() => setLoading(false));
  }, [q, owner, stage, channel, allScope, page]);

  useEffect(() => {
    load();
  }, [load]);

  function toggle(id: string) {
    const next = openId === id ? '' : id;
    setOpenId(next);
    writeOpenToUrl(next);
  }

  const items = data?.items ?? [];

  return (
    <div>
      <div className="page-header">
        <div className="page-header-row">
          <div>
            <div className="page-eyebrow">ADMISSIONS</div>
            <h1 className="page-title">{t('title')}</h1>
            <p className="page-subtitle">{t('subtitle')}</p>
          </div>
        </div>
      </div>

      {/* ── 筛选条 ── */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
        <FilterSelect
          label={t('ownerLabel')}
          options={data?.ownerOptions ?? []}
          value={owner}
          onChange={(v) => {
            setOwner(v);
            setPage(1);
          }}
          clearable={false}
        />
        <input
          className="form-input"
          style={{ width: 200 }}
          placeholder={t('searchPlaceholder')}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
        />
        <FilterSelect
          label={t('stageLabel')}
          options={data?.stages ?? []}
          value={stage}
          onChange={(v) => {
            setStage(v);
            setPage(1);
          }}
        />
        <FilterSelect
          label={t('channelLabel')}
          options={data?.channels ?? []}
          value={channel}
          onChange={(v) => {
            setChannel(v);
            setPage(1);
          }}
        />
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--fg-secondary)' }}>
          <input
            type="checkbox"
            checked={allScope}
            onChange={(e) => {
              setAllScope(e.target.checked);
              setPage(1);
            }}
          />
          {t('scopeAll')}
        </label>
      </div>

      {/* ── 统计（说明"我的 12 人里有 8/5/3 人有互动"，让筛选口径一目了然） ── */}
      {data ? (
        <div style={{ fontSize: 12.5, color: 'var(--fg-secondary)', marginBottom: 10 }}>
          {t('statsLine', {
            contacts: data.stats.contacts,
            progress: data.stats.withProgress,
            source: data.stats.withSource,
            mail: data.stats.withMail,
          })}
          {data.owner ? <span style={{ color: 'var(--fg-tertiary)' }}> · {t('ownerInUse', { owner: data.owner })}</span> : null}
        </div>
      ) : null}

      {err ? <p className="msg-error">{t('loadFailed', { msg: err })}</p> : null}
      {loading ? <p style={{ color: 'var(--fg-tertiary)' }}>{t('loading')}</p> : null}

      {!loading && !err && items.length === 0 ? (
        data?.ownerUnresolved ? (
          <p style={{ color: 'var(--fg-secondary)' }}>{t('ownerUnresolved', { me: data.myName })}</p>
        ) : (
          <p style={{ color: 'var(--fg-tertiary)' }}>{allScope ? t('emptyAll') : t('empty')}</p>
        )
      ) : null}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {items.map((it) => {
          const open = openId === it.id;
          const hovered = canHover && hoverId === it.id && !open;
          const lastText = it.lastAt ? `${formatDate(it.lastAt)} ${it.lastSummary}` : '';
          return (
            <div
              key={it.id}
              style={{ position: 'relative' }}
              onMouseEnter={() => setHoverId(it.id)}
              onMouseLeave={() => setHoverId((h) => (h === it.id ? null : h))}
            >
              {/* 收起态行：整行可点展开；姓名是链接（点它才进档案），两者互不干扰 */}
              <div
                onClick={() => toggle(it.id)}
                style={{
                  cursor: 'pointer',
                  padding: '9px 12px',
                  border: '1px solid var(--border)',
                  borderRadius: open ? '8px 8px 0 0' : 8,
                  background: 'var(--bg-elevated)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ width: 10, color: open ? 'var(--accent)' : 'var(--fg-tertiary)', fontSize: 11, flexShrink: 0 }}>
                    {open ? '▾' : '▸'}
                  </span>
                  <Link
                    href={`/weiling-contacts/${it.id}`}
                    onClick={(e) => e.stopPropagation()}
                    style={{ color: 'var(--accent)', fontWeight: 500, flexShrink: 0, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {it.name}
                  </Link>
                  {it.stage ? <span className="badge">{it.stage}</span> : null}
                  <span style={{ flex: 1, minWidth: 0 }} />
                  <span style={{ fontSize: 12, color: it.counts.progress ? 'var(--fg)' : 'var(--fg-tertiary)', flexShrink: 0 }}>
                    {t('countProgress', { count: it.counts.progress })}
                  </span>
                  <span style={{ fontSize: 12, color: it.counts.source ? 'var(--fg)' : 'var(--fg-tertiary)', flexShrink: 0 }}>
                    {t('countSource', { count: it.counts.source })}
                  </span>
                  <span style={{ fontSize: 12, color: it.counts.mail ? 'var(--fg)' : 'var(--fg-tertiary)', flexShrink: 0 }}>
                    {t('countMail', { count: it.counts.mail })}
                  </span>
                  <span style={{ fontSize: 11.5, color: 'var(--fg-tertiary)', flexShrink: 0, width: 62, textAlign: 'right' }}>
                    {it.lastAt ? formatDate(it.lastAt) : '—'}
                  </span>
                </div>
                {/* 这一行让「他现在什么进展」0 次点击就能看到 */}
                {lastText ? (
                  <div style={{ marginTop: 3, marginLeft: 20, fontSize: 11.5, color: 'var(--fg-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t('lastPrefix')}
                    {lastText}
                  </div>
                ) : null}
              </div>

              {/* 悬停预览：桌面端不点也能看三类明细（pointerEvents:none 不挡点击） */}
              {hovered ? (
                <div
                  style={{
                    position: 'absolute',
                    left: 16,
                    top: 'calc(100% - 2px)',
                    zIndex: 20,
                    width: 460,
                    padding: '9px 12px',
                    borderRadius: 8,
                    border: '1px solid var(--border)',
                    background: 'var(--bg-elevated)',
                    boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
                    pointerEvents: 'none',
                  }}
                >
                  {(['progress', 'source', 'mail'] as Kind[]).map((k) => {
                    const rows = it.detail[k];
                    if (!it.counts[k]) return null;
                    const first = rows[0];
                    return (
                      <div key={k} style={{ display: 'flex', gap: 8, fontSize: 11.5, padding: '2px 0' }}>
                        <span style={{ width: 62, color: 'var(--fg-secondary)', flexShrink: 0 }}>{t(kindLabelKey(k))}</span>
                        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--fg)' }}>
                          {first?.at ? `${formatDate(first.at)} ` : ''}
                          {first?.summary ?? ''}
                        </span>
                      </div>
                    );
                  })}
                  <div style={{ marginTop: 6, fontSize: 11, color: 'var(--fg-tertiary)' }}>{t('hoverHint')}</div>
                </div>
              ) : null}

              {/* 展开态：三类各一行明细 + 查看全部 */}
              {open ? (
                <div
                  style={{
                    border: '1px solid var(--border)',
                    borderTop: 'none',
                    borderRadius: '0 0 8px 8px',
                    background: 'var(--bg-elevated)',
                    padding: '8px 12px 10px',
                  }}
                >
                  {(['progress', 'source', 'mail'] as Kind[]).map((k) => {
                    const rows = it.detail[k];
                    const n = it.counts[k];
                    if (!n) {
                      return (
                        <div key={k} style={{ display: 'flex', gap: 8, fontSize: 12, padding: '3px 0', color: 'var(--fg-tertiary)' }}>
                          <span style={{ width: 70, flexShrink: 0 }}>{t(kindLabelKey(k))}</span>
                          <span>{t('noneOfKind')}</span>
                        </div>
                      );
                    }
                    const first = rows[0];
                    return (
                      <div key={k} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12, padding: '3px 0' }}>
                        <span style={{ width: 70, color: 'var(--fg-secondary)', flexShrink: 0 }}>{t(kindLabelKey(k))}</span>
                        <span style={{ width: 44, color: 'var(--accent)', flexShrink: 0 }}>{n}</span>
                        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--fg)' }}>
                          {first?.at ? `${formatDate(first.at)} ` : ''}
                          {first?.summary ?? ''}
                          {first?.meta ? <span style={{ color: 'var(--fg-tertiary)' }}> · {first.meta}</span> : null}
                        </span>
                        <Link
                          href={hrefOf(k, it)}
                          onClick={(e) => e.stopPropagation()}
                          style={{ color: 'var(--accent)', flexShrink: 0, fontSize: 11.5 }}
                        >
                          {t('viewAll')} →
                        </Link>
                      </div>
                    );
                  })}
                  <div
                    style={{
                      marginTop: 7,
                      paddingTop: 7,
                      borderTop: '1px solid var(--border)',
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: 10,
                      fontSize: 11.5,
                      color: 'var(--fg-tertiary)',
                    }}
                  >
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {[it.channel ? t('channelInline', { v: it.channel }) : '', it.phone ? it.phone : '', it.followCount ? t('followTimes', { count: it.followCount }) : '']
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                    <Link
                      href={`/weiling-contacts/${it.id}`}
                      onClick={(e) => e.stopPropagation()}
                      style={{ color: 'var(--accent)', flexShrink: 0 }}
                    >
                      {t('openContact')} →
                    </Link>
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {/* ── 分页 ── */}
      {data && data.total > PAGE_SIZE ? (
        <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 10, marginTop: 12, fontSize: 12.5 }}>
          <button className="btn btn-outline btn-sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
            {t('prevPage')}
          </button>
          <span style={{ color: 'var(--fg-tertiary)' }}>
            {page} / {Math.max(1, Math.ceil(data.total / PAGE_SIZE))}
          </span>
          <button className="btn btn-outline btn-sm" disabled={!data.hasMore} onClick={() => setPage((p) => p + 1)}>
            {t('nextPage')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
