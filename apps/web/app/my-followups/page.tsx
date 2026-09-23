'use client';

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import Link from 'next/link';
import { api, type MyFollowupItem, type MyFollowupsResp, type MyFollowupKindRow } from '../../lib/api';
import { FilterSelect } from '../../components/FilterSelect';
import Pagination from '../../components/Pagination';
import SourceFollowupModal from '../../components/SourceFollowupModal';
import MailDetailModal from '../../components/MailDetailModal';
import { formatDate } from '../../lib/date';
import { useTranslations } from 'next-intl';

type Kind = 'progress' | 'source' | 'mail';

const PAGE_SIZE = 20;

const checkStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  fontSize: 12.5,
  color: 'var(--fg-secondary)',
  cursor: 'pointer',
};

/** 展开状态写进地址栏（`?open=<联系人 id>`）：刷新、从别处返回后仍是展开的 */
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

function kindLabelKey(kind: Kind): string {
  return kind === 'progress' ? 'kindProgress' : kind === 'source' ? 'kindSource' : 'kindMail';
}

export default function MyFollowupsPage() {
  const t = useTranslations('myFollowups');

  const [q, setQ] = useState('');
  /** 筛选用**用户**（不是归属人）：下拉只列配过映射的用户 */
  const [userId, setUserId] = useState('');
  const [stage, setStage] = useState('');
  const [channel, setChannel] = useState('');
  const [allScope, setAllScope] = useState(false);
  /** 三个勾选框：勾上 → 只留**有该类**互动的；全不勾 → 不限 */
  const [kindProgress, setKindProgress] = useState(false);
  const [kindSource, setKindSource] = useState(false);
  const [kindMail, setKindMail] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE);

  const [data, setData] = useState<MyFollowupsResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [openId, setOpenId] = useState('');
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [canHover, setCanHover] = useState(false);
  /** 弹窗：招生跟进 / 邮件 */
  const [sourceModal, setSourceModal] = useState('');
  const [mailModal, setMailModal] = useState('');

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
        user: userId,
        page: String(page),
        pageSize: String(pageSize),
        scope: allScope ? 'all' : 'active',
        ...(stage ? { 阶段: stage } : {}),
        ...(channel ? { 来源渠道: channel } : {}),
        ...(kindProgress ? { kindProgress: '1' } : {}),
        ...(kindSource ? { kindSource: '1' } : {}),
        ...(kindMail ? { kindMail: '1' } : {}),
      })
      .then(setData)
      .catch((e) => {
        setErr(String((e as Error)?.message ?? e));
        setData(null);
      })
      .finally(() => setLoading(false));
  }, [q, userId, stage, channel, allScope, kindProgress, kindSource, kindMail, page, pageSize]);

  useEffect(() => {
    load();
  }, [load]);

  function toggle(id: string) {
    const next = openId === id ? '' : id;
    setOpenId(next);
    writeOpenToUrl(next);
  }
  /** 任何筛选变化都要回到第 1 页（否则会停在一个空页上） */
  function resetTo1<T>(setter: (v: T) => void) {
    return (v: T) => {
      setter(v);
      setPage(1);
    };
  }

  const items = data?.items ?? [];
  const userOpts = (data?.users ?? []).map((u) => u.id);
  const userLabels = Object.fromEntries((data?.users ?? []).map((u) => [u.id, u.name]));

  /** 展开区里的一类互动：把该联系人这一类的记录**全部**按时间新→旧列出 */
  const renderKind = (it: MyFollowupItem, kind: Kind, onOpen?: (rowId: string) => void) => {
    const rows: MyFollowupKindRow[] = it.detail[kind] ?? [];
    if (!rows.length) return null;
    return (
      <div key={kind} style={{ marginTop: 6 }}>
        <div style={{ fontSize: 12, color: 'var(--fg-secondary)' }}>
          {t(kindLabelKey(kind))}
          <span style={{ color: 'var(--accent)' }}>{t('countSuffix', { count: it.counts[kind] })}</span>
        </div>
        <div style={{ marginTop: 3, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {rows.map((r) => {
            const inner = (
              <>
                <span style={{ color: 'var(--fg-tertiary)', flexShrink: 0, width: 78 }}>
                  {r.at ? formatDate(r.at) : '—'}
                </span>
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    color: onOpen ? 'var(--accent)' : 'var(--fg)',
                  }}
                >
                  {r.summary}
                </span>
                {r.meta ? (
                  <span
                    style={{
                      color: 'var(--fg-tertiary)',
                      flexShrink: 0,
                      maxWidth: 200,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {r.meta}
                  </span>
                ) : null}
              </>
            );
            return onOpen && r.id ? (
              <button
                key={r.id}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpen(r.id);
                }}
                style={{
                  display: 'flex',
                  gap: 8,
                  alignItems: 'baseline',
                  padding: '2px 4px',
                  border: 'none',
                  background: 'transparent',
                  cursor: 'pointer',
                  textAlign: 'left',
                  fontSize: 12,
                  borderRadius: 4,
                }}
              >
                {inner}
              </button>
            ) : (
              <div key={r.id || r.at} style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '2px 4px', fontSize: 12 }}>
                {inner}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

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

      {/* ── 筛选条：用户 + 关键字 + 阶段 / 渠道 + 三类勾选 + 看全部 ── */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
        <FilterSelect
          label={t('userLabel')}
          options={userOpts}
          optionLabels={userLabels}
          value={userId}
          onChange={resetTo1(setUserId)}
        />
        <input
          className="form-input"
          style={{ width: 190 }}
          placeholder={t('searchPlaceholder')}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
        />
        <FilterSelect label={t('stageLabel')} options={data?.stages ?? []} value={stage} onChange={resetTo1(setStage)} />
        <FilterSelect label={t('channelLabel')} options={data?.channels ?? []} value={channel} onChange={resetTo1(setChannel)} />
        <span style={{ width: 1, height: 20, background: 'var(--border)' }} />
        <label style={checkStyle}>
          <input type="checkbox" checked={kindProgress} onChange={(e) => resetTo1(setKindProgress)(e.target.checked)} />
          {t('kindProgress')}
        </label>
        <label style={checkStyle}>
          <input type="checkbox" checked={kindSource} onChange={(e) => resetTo1(setKindSource)(e.target.checked)} />
          {t('kindSource')}
        </label>
        <label style={checkStyle}>
          <input type="checkbox" checked={kindMail} onChange={(e) => resetTo1(setKindMail)(e.target.checked)} />
          {t('kindMail')}
        </label>
        <span style={{ width: 1, height: 20, background: 'var(--border)' }} />
        <label style={checkStyle}>
          <input type="checkbox" checked={allScope} onChange={(e) => resetTo1(setAllScope)(e.target.checked)} />
          {t('scopeAll')}
        </label>
      </div>

      {data ? (
        <div style={{ fontSize: 12.5, color: 'var(--fg-secondary)', marginBottom: 10 }}>
          {t('statsLine', {
            contacts: data.stats.contacts,
            progress: data.stats.withProgress,
            source: data.stats.withSource,
            mail: data.stats.withMail,
          })}
          {data.owner ? <span style={{ color: 'var(--fg-tertiary)' }}> · {t('ownerValue', { v: data.owner })}</span> : null}
        </div>
      ) : null}

      {/* 按姓名猜出来的归属人要提示去配映射 —— 猜错等于看到别人的联系人 */}
      {data?.ownerSource === 'name' ? (
        <p style={{ fontSize: 12, color: '#c98a00', marginBottom: 10 }}>
          {t('ownerGuessedHint')}{' '}
          <Link href="/owner-mappings" style={{ color: 'var(--accent)' }}>
            {t('goConfigMapping')} →
          </Link>
        </p>
      ) : null}

      {err ? <p className="msg-error">{t('loadFailed', { msg: err })}</p> : null}

      {!loading && !err && items.length === 0 ? (
        data?.ownerUnresolved ? (
          <p style={{ color: 'var(--fg-secondary)' }}>
            {t('ownerUnresolved', { me: data.myName })}{' '}
            <Link href="/owner-mappings" style={{ color: 'var(--accent)' }}>
              {t('goConfigMapping')} →
            </Link>
          </p>
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
                    style={{
                      color: 'var(--accent)',
                      fontWeight: 500,
                      flexShrink: 0,
                      maxWidth: 200,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
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
                {lastText ? (
                  <div
                    style={{
                      marginTop: 3,
                      marginLeft: 20,
                      fontSize: 11.5,
                      color: 'var(--fg-tertiary)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {t('lastPrefix')}
                    {lastText}
                  </div>
                ) : null}
              </div>

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
                        <span
                          style={{
                            flex: 1,
                            minWidth: 0,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            color: 'var(--fg)',
                          }}
                        >
                          {first?.at ? `${formatDate(first.at)} ` : ''}
                          {first?.summary ?? ''}
                        </span>
                      </div>
                    );
                  })}
                  <div style={{ marginTop: 6, fontSize: 11, color: 'var(--fg-tertiary)' }}>{t('hoverHint')}</div>
                </div>
              ) : null}

              {/* 展开：三类**全部**罗列（按时间新→旧）；招生跟进 / 邮件点头即可弹窗看详情 */}
              {open ? (
                <div
                  style={{
                    border: '1px solid var(--border)',
                    borderTop: 'none',
                    borderRadius: '0 0 8px 8px',
                    background: 'var(--bg-elevated)',
                    padding: '6px 12px 10px',
                  }}
                >
                  {renderKind(it, 'progress')}
                  {renderKind(it, 'source', (rid) => setSourceModal(rid))}
                  {renderKind(it, 'mail', (rid) => setMailModal(rid))}
                  {!it.hasAny ? (
                    <div style={{ fontSize: 12, color: 'var(--fg-tertiary)', padding: '4px 0' }}>{t('noneOfKind')}</div>
                  ) : null}
                  <div
                    style={{
                      marginTop: 8,
                      paddingTop: 8,
                      borderTop: '1px solid var(--border)',
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: 10,
                      fontSize: 11.5,
                      color: 'var(--fg-tertiary)',
                    }}
                  >
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {[
                        it.channel ? t('channelInline', { v: it.channel }) : '',
                        it.phone,
                        it.followCount ? t('followTimes', { count: it.followCount }) : '',
                      ]
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

      {/* ── 统一翻页条（全站同一组件） ── */}
      {data && data.total > 0 ? (
        <Pagination
          total={data.total}
          page={page}
          pageSize={pageSize}
          loading={loading}
          onPageChange={setPage}
          onPageSizeChange={(s) => {
            setPageSize(s);
            setPage(1);
          }}
        />
      ) : null}

      {sourceModal ? <SourceFollowupModal id={sourceModal} onClose={() => setSourceModal('')} /> : null}
      {mailModal ? <MailDetailModal id={mailModal} onClose={() => setMailModal('')} /> : null}
    </div>
  );
}
