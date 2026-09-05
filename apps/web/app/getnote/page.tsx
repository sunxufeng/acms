'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api, type GetnoteCredential, type GetnoteOAuthStart, type ApiRequestError } from '../../lib/api';
import { useTl } from '../../lib/useTl';
import { useTranslations } from 'next-intl';

/** 开放平台（用户去这里创建应用、拿 Client ID 与 API Key） */
const OPENAPI_URL = 'https://www.biji.com/openapi';
/** 官方给出的会员开通页（错误码 10201 时引导到这里） */
const CHECKOUT_URL = 'https://www.biji.com/checkout?product_alias=9Ab36BB3ZD';

/**
 * 笔记来源的候选项 = 字典「笔记类型」。
 *
 * ⚠️ 存储位置：Get笔记 的 note 对象没有自定义字段，所以「来源」复用 **tags** 承载 ——
 *    命中这份字典的那个标签就是来源，其余标签才是普通标签。这样来源随笔记走、
 *    换浏览器也在，且不需要在 ACMS 侧再建映射表。
 *    toRow() 负责拆（来源 / 标签），toPayload() 负责合（提交时拼回 tags）。
 */
const NOTE_TYPES = ['得到大脑', '飞书秒记', '钉钉助记', '元宝录音', '腾讯会议'];

function tagNames(n: Record<string, unknown>): string[] {
  const tags = Array.isArray(n.tags) ? (n.tags as { name?: string }[]) : [];
  return tags.map((t) => String(t?.name ?? '')).filter(Boolean);
}

/**
 * 把 Get笔记 的 note 对象适配成 CrudPage 的行数据。
 *
 * ⚠️ 两条硬约束：
 * 1. **CrudPage 用 `row.id` 作行键**（取值、编辑、删除全走它），而 Get笔记 的 ID 字段叫
 *    `note_id`，且是 int64 的字符串形态 —— 映射过去，**绝不能转 Number**（会丢精度，
 *    末几位变 0，导致编辑/删除命中错误的笔记）。
 * 2. `tags` 是对象数组 `[{id,name,type}]`，列表里渲染成可点击的标签；其中命中
 *    NOTE_TYPES 的那一个单独提成「来源」列，不再重复出现在标签列。
 */
function toRow(n: Record<string, unknown>): Record<string, unknown> {
  const names = tagNames(n);
  // 历史笔记没有来源标签（标签功能后加的），默认全部来自「得到大脑」
  const src = names.find((x) => NOTE_TYPES.includes(x)) || '得到大脑';
  return {
    ...n,
    id: String(n.note_id ?? n.id ?? ''),
    来源: src,
    标签: names.filter((x) => !NOTE_TYPES.includes(x)).join('、'),
  };
}

/** 提交前把「来源 + 标签」合并回 tags（Get笔记 的 tags 是替换语义，必须整体传） */
function toPayload(d: Record<string, unknown>): Record<string, unknown> {
  const { 标签, 来源, ...rest } = d;
  const list =
    typeof 标签 === 'string'
      ? 标签.split(/[,，、]/).map((s) => s.trim()).filter(Boolean)
      : Array.isArray(标签)
        ? (标签 as string[]).map((s) => String(s).trim()).filter(Boolean)
        : [];
  const src = typeof 来源 === 'string' ? 来源.trim() : '';
  return { ...rest, tags: src ? [...list, src] : list };
}

/**
 * 列定义做成工厂函数：标签列要渲染成可点击的 chip，点击后把标签名作为语义检索词
 * 传回列表（点击回调需要闭包捕获，模块级常量做不到，所以用 useMemo 包一层）。
 */
function makeColumns(onTagClick: (tag: string) => void): CrudColumn[] {
  return [
    { key: 'title', label: '标题', form: true, type: 'text', required: true, width: '280px', listOrder: 1 },
    { key: 'note_type', label: '类型', width: '100px', listOrder: 2 },
    {
      key: '来源',
      label: '来源',
      form: true,
      type: 'select',
      dictKey: '笔记类型',
      options: NOTE_TYPES,
      width: '120px',
      listOrder: 3,
      filter: true,
      filterType: 'select',
      hint: '这条笔记来自哪个渠道；存在 Get笔记 的标签里，随笔记走',
    },
    {
      key: '标签',
      label: '标签',
      form: true,
      type: 'text',
      width: '200px',
      listOrder: 4,
      hint: '多个标签用逗号分隔；保存后会整体替换原有标签',
      render: (v) => {
        const parts = String(v ?? '').split('、').map((s) => s.trim()).filter(Boolean);
        if (parts.length === 0) return <span style={{ color: 'var(--fg-tertiary)' }}>—</span>;
        return (
          <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4 }}>
            {parts.map((p) => (
              <button
                key={p}
                type="button"
                className="btn btn-sm"
                title={`按「${p}」检索`}
                style={{ padding: '2px 10px', fontSize: 12, borderRadius: 999, lineHeight: 1.6 }}
                onClick={(e) => {
                  e.stopPropagation(); // 行上还有「点击编辑」，别一起触发
                  onTagClick(p);
                }}
              >
                {p}
              </button>
            ))}
          </span>
        );
      },
    },
    { key: 'updated_at', label: '更新时间', width: '170px', listOrder: 5 },
    // 正文用 markdown 编辑器：带「MD / 浏览」切换，高度 420（原来 3 行 textarea 太矮）
    { key: 'content', label: '正文', form: true, type: 'markdown', fieldHeight: 420, list: false, listOrder: 6 },
  ];
}

/** 来源筛选时最多翻多少页（防止笔记极多时把请求打满） */
const SOURCE_FILTER_MAX_PAGES = 10;

/**
 * ⚠️ 每页条数必须与 Get笔记 服务端返回的单页条数一致。
 * Get笔记 的列表接口**不支持自定义 pageSize**，而 CrudPage 用 `total / pageSize` 推算总页数，
 * 两边不一致会让分页条显示的页数不对。拿到真实凭证后校准这个常量。
 */
const PAGE_SIZE = 20;

/** 把后端的结构化错误码翻成人话。光看 message 区分不了「非会员」和「Key 无效」。 */
function errorText(e: unknown, t: ReturnType<typeof useTranslations>): string {
  const code = (e as ApiRequestError)?.apiCode;
  if (code === 'GETNOTE_NOT_MEMBER') return t('errNotMember');
  if (code === 'GETNOTE_AUTH_FAILED') return t('errAuthFailed');
  if (code === 'GETNOTE_RATE_LIMITED') return t('errRateLimited');
  if (code === 'GETNOTE_BAD_INPUT') return (e as Error).message || t('errAuthFailed');
  return (e as Error)?.message || t('errGeneric');
}

export default function GetnotePage() {
  const tl = useTl();
  const t = useTranslations('getnote');

  const [cred, setCred] = useState<GetnoteCredential | null>(null); // null = 加载中
  const [open, setOpen] = useState(false); // 设置区展开
  const [cid, setCid] = useState('');
  const [key, setKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');

  /**
   * 点击标签 → 用标签名做语义检索。与搜索框共用后端同一个 `q` 通道，
   * 二者互斥（点标签会覆盖搜索框）。这里单独存一份是为了在列表上方显示
   * 「按标签 X 检索」的提示条 —— 否则用户看到结果变了却不知道为什么。
   */
  const [tagQuery, setTagQuery] = useState('');
  const columns = useMemo(() => makeColumns(setTagQuery), []);

  // OAuth 设备授权
  const [oauth, setOauth] = useState<GetnoteOAuthStart | null>(null);
  const [oauthFailed, setOauthFailed] = useState<'' | 'expired' | 'rejected'>('');
  const [left, setLeft] = useState(0);
  const [copied, setCopied] = useState(false);
  const pollRef = useRef<number | null>(null);
  const intervalRef = useRef(5);

  const load = useCallback(() => {
    api
      .getGetnoteCredential()
      .then(setCred)
      .catch(() => setCred(null));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /** 组件卸载或弹窗关闭时停掉轮询与倒计时，避免 setState on unmounted */
  useEffect(
    () => () => {
      if (pollRef.current) window.clearTimeout(pollRef.current);
    },
    [],
  );

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      window.clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const closeOauth = useCallback(() => {
    stopPolling();
    setOauth(null);
    setOauthFailed('');
    setCopied(false);
    void api.cancelGetnoteOAuth().catch(() => undefined);
  }, [stopPolling]);

  /** 单次轮询。用 setTimeout 链而非 setInterval —— 避免上一轮没回来就叠上下一轮。 */
  const pollOnce = useCallback(async () => {
    try {
      const r = await api.pollGetnoteOAuth();
      if (r.status === 'success') {
        stopPolling();
        setOauth(null);
        setOauthFailed('');
        setOk(t('oauthSuccess'));
        load();
        return;
      }
      if (r.status === 'expired') {
        stopPolling();
        setOauthFailed('expired');
        return;
      }
      if (r.status === 'rejected') {
        stopPolling();
        setOauthFailed('rejected');
        return;
      }
      pollRef.current = window.setTimeout(() => void pollOnce(), intervalRef.current * 1000);
    } catch (e) {
      stopPolling();
      setErr(errorText(e, t));
    }
  }, [load, stopPolling, t]);

  const startOauth = async () => {
    setBusy(true);
    setErr('');
    setOk('');
    try {
      const r = await api.startGetnoteOAuth();
      intervalRef.current = r.interval;
      setOauth(r);
      setOauthFailed('');
      setLeft(r.expiresIn);
      pollRef.current = window.setTimeout(() => void pollOnce(), r.interval * 1000);
    } catch (e) {
      setErr(errorText(e, t));
    } finally {
      setBusy(false);
    }
  };

  /** 倒计时只做展示，过期判定以后端为准（避免前后端时钟不一致导致误判） */
  useEffect(() => {
    if (!oauth || oauthFailed) return;
    const timer = window.setInterval(() => setLeft((v) => (v > 0 ? v - 1 : 0)), 1000);
    return () => window.clearInterval(timer);
  }, [oauth, oauthFailed]);

  const save = async () => {
    setBusy(true);
    setErr('');
    setOk('');
    try {
      await api.saveGetnoteCredential(key.trim(), cid.trim());
      setKey('');
      setCid('');
      setOk(t('keySaved'));
      setOpen(false);
      load();
    } catch (e) {
      setErr(errorText(e, t));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(t('confirmRemoveKey'))) return;
    setBusy(true);
    setErr('');
    setOk('');
    try {
      await api.clearGetnoteCredential();
      setOk('');
      setOpen(false);
      load();
    } catch (e) {
      setErr(errorText(e, t));
    } finally {
      setBusy(false);
    }
  };

  const copyCode = async () => {
    if (!oauth) return;
    try {
      await navigator.clipboard.writeText(oauth.userCode);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setErr(t('copyFailed'));
    }
  };

  /** 手动填入表单。未配置引导页与已配置展开区共用。 */
  const manualForm = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
      <div>
        <p style={{ fontSize: 12, color: 'var(--fg-tertiary)', margin: '0 0 4px' }}>
          {t('clientIdLabel')}　<span style={{ color: 'var(--fg-tertiary)' }}>{t('clientIdHint')}</span>
        </p>
        <input
          value={cid}
          placeholder="cli_xxx"
          onChange={(e) => setCid(e.target.value)}
          style={{
            width: '100%',
            padding: '6px 8px',
            borderRadius: 6,
            border: '1px solid var(--border)',
            fontSize: 13,
          }}
        />
      </div>
      <div>
        <p style={{ fontSize: 12, color: 'var(--fg-tertiary)', margin: '0 0 4px' }}>
          {t('apiKeyLabel')}　<span style={{ color: 'var(--fg-tertiary)' }}>{t('apiKeyHint')}</span>
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type={showKey ? 'text' : 'password'}
            value={key}
            placeholder="gk_live_xxx"
            onChange={(e) => setKey(e.target.value)}
            style={{
              flex: 1,
              padding: '6px 8px',
              borderRadius: 6,
              border: '1px solid var(--border)',
              fontSize: 13,
            }}
          />
          <button type="button" className="btn btn-sm" onClick={() => setShowKey((v) => !v)}>
            {showKey ? t('hide') : t('show')}
          </button>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={busy || !key.trim() || !cid.trim()}
          onClick={save}
        >
          {busy ? t('keySaving') : t('testAndSave')}
        </button>
        {cred?.configured && (
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy}
            onClick={remove}
            style={{ color: 'var(--fg-error)' }}
          >
            {t('removeKey')}
          </button>
        )}
        <span style={{ fontSize: 12, color: 'var(--fg-tertiary)' }}>{t('saveHint')}</span>
      </div>
    </div>
  );

  /** OAuth 授权区。内联展开而非模态框 —— 扫码要切到手机，遮罩挡着反而碍事。 */
  const oauthPanel = oauth && (
    <div
      style={{
        marginTop: 12,
        padding: 16,
        border: '1px solid var(--border)',
        borderRadius: 10,
        background: 'var(--bg-elevated)',
      }}
    >
      {oauthFailed ? (
        <>
          <p style={{ fontSize: 13, fontWeight: 500, margin: '0 0 4px', color: 'var(--fg-error)' }}>
            {oauthFailed === 'expired' ? t('oauthExpired') : t('oauthRejected')}
          </p>
          <p style={{ fontSize: 12, color: 'var(--fg-tertiary)', margin: '0 0 12px', lineHeight: 1.6 }}>
            {oauthFailed === 'expired' ? t('oauthExpiredDesc') : t('oauthRejectedDesc')}
          </p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy}
              onClick={() => void startOauth()}
            >
              {t('retryAuth')}
            </button>
            {oauthFailed === 'rejected' && (
              <button type="button" className="btn btn-sm" onClick={closeOauth}>
                {t('useManual')}
              </button>
            )}
            <button type="button" className="btn btn-sm" onClick={closeOauth}>
              {t('cancel')}
            </button>
          </div>
        </>
      ) : (
        <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          {oauth.qrcode && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={oauth.qrcode}
              alt={t('scanTip')}
              width={148}
              height={148}
              style={{ borderRadius: 8, border: '1px solid var(--border)', background: '#fff' }}
            />
          )}
          <div style={{ flex: 1, minWidth: 220 }}>
            <p style={{ fontSize: 13, margin: '0 0 12px', color: 'var(--fg-tertiary)', lineHeight: 1.6 }}>
              {t('scanTip')}
            </p>
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 10px',
                border: '1px dashed var(--border)',
                borderRadius: 8,
                marginBottom: 12,
              }}
            >
              <span style={{ fontFamily: 'monospace', fontSize: 14, letterSpacing: 1 }}>
                {oauth.userCode}
              </span>
              <button type="button" className="btn btn-sm" onClick={() => void copyCode()}>
                {copied ? t('copied') : t('copy')}
              </button>
            </div>
            <div style={{ marginBottom: 12 }}>
              <a
                href={oauth.verificationUri || OPENAPI_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-sm"
              >
                {t('openAuthPage')}
              </a>
            </div>
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 10px',
                borderRadius: 8,
                background: 'var(--bg-subtle)',
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: 'var(--accent)',
                  display: 'inline-block',
                }}
              />
              <span style={{ fontSize: 12, color: 'var(--fg-tertiary)' }}>{t('scanning')}</span>
              <span style={{ fontSize: 12, color: 'var(--fg-tertiary)', fontFamily: 'monospace' }}>
                {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
              </span>
            </div>
            <div style={{ marginTop: 12 }}>
              <button type="button" className="btn btn-sm" onClick={closeOauth}>
                {t('cancel')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  if (cred === null) {
    return (
      <div className="card" style={{ padding: 24, margin: 24 }}>
        <h1 className="page-title">{tl('知识库')}</h1>
        <p className="muted" style={{ marginTop: 12 }}>
          {t('loading')}
        </p>
      </div>
    );
  }

  // 还没连接：整页引导，不进列表（空列表配一堆报错更让人困惑）
  if (!cred.configured) {
    return (
      <div className="card" style={{ padding: 24, margin: 24 }}>
        <h1 className="page-title">{tl('知识库')}</h1>
        <p className="muted" style={{ marginTop: 12, marginBottom: 20 }}>{t('connectIntro')}</p>

        <p style={{ fontSize: 12, color: 'var(--fg-tertiary)', margin: '0 0 12px' }}>{t('selfService')}</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 20 }}>
          {[
            { n: 1, title: t('step1'), desc: t('step1Desc') },
            { n: 2, title: t('step2'), desc: t('step2Desc') },
            { n: 3, title: t('step3'), desc: t('step3Desc') },
          ].map((s) => (
            <div key={s.n} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <span
                style={{
                  flex: '0 0 20px',
                  height: 20,
                  borderRadius: '50%',
                  background: 'var(--bg-subtle)',
                  color: 'var(--fg-tertiary)',
                  fontSize: 11,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginTop: 1,
                }}
              >
                {s.n}
              </span>
              <div>
                <p style={{ fontSize: 13, margin: 0 }}>{s.title}</p>
                <p style={{ fontSize: 12, color: 'var(--fg-tertiary)', margin: '2px 0 0' }}>{s.desc}</p>
              </div>
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
          <a href={OPENAPI_URL} target="_blank" rel="noopener noreferrer" className="btn btn-sm">
            {t('openOpenApi')}
          </a>
          {cred.oauthEnabled && (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy}
              onClick={() => void startOauth()}
            >
              {busy ? t('oauthStarting') : t('oauthTitle')}
            </button>
          )}
        </div>

        {oauthPanel}

        {!oauth && (
          <>
            <p style={{ fontSize: 13, fontWeight: 500, margin: '18px 0 0' }}>{t('manualTitle')}</p>
            {manualForm}
          </>
        )}

        {err && (
          <p style={{ color: 'var(--fg-error)', fontSize: 12, marginTop: 12, marginBottom: 0 }}>{err}</p>
        )}
        {ok && (
          <p className="muted" style={{ fontSize: 12, marginTop: 12, marginBottom: 0 }}>
            {ok}
          </p>
        )}

        <div
          style={{
            marginTop: 18,
            padding: '10px 12px',
            borderRadius: 8,
            background: 'var(--bg-subtle)',
            border: '1px solid var(--border)',
          }}
        >
          <p style={{ fontSize: 12, color: 'var(--fg-tertiary)', margin: 0, lineHeight: 1.6 }}>
            {t('memberNote')}{' '}
            <a href={CHECKOUT_URL} target="_blank" rel="noopener noreferrer">
              {t('memberLink')}
            </a>
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      {tagQuery && (
        <div
          className="card"
          style={{ padding: '8px 16px', margin: '16px 24px 0', display: 'flex', alignItems: 'center', gap: 10 }}
        >
          <span className="muted" style={{ fontSize: 13 }}>
            {t('tagFiltered', { tag: tagQuery })}
          </span>
          <button type="button" className="btn btn-sm" onClick={() => setTagQuery('')}>
            {t('clearTagFilter')}
          </button>
        </div>
      )}

      <CrudPage
        // 检索词变化时整体重挂：强制回到第 1 页重新拉取（否则翻页游标还停在第 N 页）
        key={tagQuery || 'all'}
        title="我的笔记"
        columns={columns}
        pageSize={PAGE_SIZE}
        inlineEdit
        standaloneForm
        search={{ placeholder: t('searchPlaceholder') }}
        api={{
          list: async (p) => {
            const src = String(p['来源'] ?? '').trim();
            const q = tagQuery || p.q;
            /**
             * 来源筛选：上游接口没有「按来源过滤」的参数，只能翻页收集后在内存里筛。
             * 所以筛选后一次性返回全部命中项（hasMore=false），不再走游标分页 ——
             * 与语义搜索（q）的返回形态一致，CrudPage 都能正常渲染。
             */
            if (src) {
              let cursor = '';
              const all: Record<string, unknown>[] = [];
              for (let i = 0; i < SOURCE_FILTER_MAX_PAGES; i++) {
                const r = await api.listGetnote(cursor ? { pageToken: cursor } : {});
                all.push(...(r.items ?? []));
                if (!r.hasMore || !r.pageToken) break;
                cursor = r.pageToken;
              }
              const items = all.map(toRow).filter((r) => r['来源'] === src);
              return { items, total: items.length, hasMore: false };
            }
            const res = await api.listGetnote({ ...p, ...(q ? { q } : {}) });
            // ?? [] 是防御：上游偶发不返回数组时，CrudPage 内部 res.items.length 也会崩
            return { ...res, items: (res.items ?? []).map(toRow) };
          },
          create: (d) => api.createGetnote(toPayload(d)),
          update: (id, d) => api.updateGetnote(id, toPayload(d)),
          // 删除 = 移入回收站，可恢复
          archive: (id) => api.deleteGetnote(id),
        }}
      />
    </>
  );
}
