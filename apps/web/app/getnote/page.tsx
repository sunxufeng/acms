'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import CrudPage, { type CrudColumn } from '../../components/CrudPage';
import { api, type GetnoteCredential, type GetnoteOAuthStart, type ApiRequestError } from '../../lib/api';
import { useTl } from '../../lib/useTl';
import { useTranslations } from 'next-intl';

/** 开放平台（用户去这里创建应用、拿 Client ID 与 API Key） */
const OPENAPI_URL = 'https://www.biji.com/openapi';
/** 官方给出的会员开通页（错误码 10201 时引导到这里） */
const CHECKOUT_URL = 'https://www.biji.com/checkout?product_alias=9Ab36BB3ZD';

/**
 * 把 Get笔记 的 note 对象适配成 CrudPage 的行数据。
 *
 * ⚠️ 两条硬约束：
 * 1. **CrudPage 用 `row.id` 作行键**（取值、编辑、删除全走它），而 Get笔记 的 ID 字段叫
 *    `note_id`，且是 int64 的字符串形态 —— 映射过去，**绝不能转 Number**（会丢精度，
 *    末几位变 0，导致编辑/删除命中错误的笔记）。
 * 2. `tags` 是对象数组 `[{id,name,type}]`，列表里渲染成「、」连接的名称串。
 */
function toRow(n: Record<string, unknown>): Record<string, unknown> {
  const tags = Array.isArray(n.tags) ? (n.tags as { name?: string }[]) : [];
  return {
    ...n,
    id: String(n.note_id ?? n.id ?? ''),
    标签: tags.map((t) => t?.name).filter(Boolean).join('、'),
  };
}

/**
 * 表单提交前的转换：把「标签」文本拆成数组。
 * Get笔记 的 tags 是**替换语义**（传了就整体覆盖原标签），所以要显式拆成数组再提交。
 */
function withTags(d: Record<string, unknown>): Record<string, unknown> {
  const raw = d.标签;
  const list =
    typeof raw === 'string'
      ? raw.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
      : Array.isArray(raw)
        ? (raw as string[])
        : undefined;
  const { 标签, ...rest } = d;
  return { ...rest, ...(list ? { tags: list } : {}) };
}

const COLUMNS: CrudColumn[] = [
  { key: 'title', label: '标题', form: true, type: 'text', required: true, width: '280px', listOrder: 1 },
  { key: 'note_type', label: '类型', width: '100px', listOrder: 2 },
  {
    key: '标签',
    label: '标签',
    form: true,
    type: 'text',
    width: '180px',
    listOrder: 3,
    hint: '多个标签用逗号分隔；保存后会整体替换原有标签',
  },
  { key: 'updated_at', label: '更新时间', width: '170px', listOrder: 4 },
  { key: 'content', label: '正文', form: true, type: 'textarea', list: false, listOrder: 5 },
];

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
      <div className="card" style={{ padding: '10px 16px', margin: '24px 24px 0' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <span className="muted" style={{ fontSize: 13 }}>
            <span
              style={{
                display: 'inline-block',
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: 'var(--success)',
                marginRight: 6,
                verticalAlign: 'middle',
              }}
            />
            {t('connected')}
            {'　'}
            {cred.masked}
            {'　'}
            {cred.clientIdMasked && (
              <span style={{ color: 'var(--fg-tertiary)' }}>{cred.clientIdMasked}</span>
            )}
            {cred.verifiedAt && (
              <span style={{ color: 'var(--fg-tertiary)', marginLeft: 8 }}>
                {t('lastVerified', { time: new Date(cred.verifiedAt).toLocaleString() })}
              </span>
            )}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              setOpen((v) => !v);
              setErr('');
              setOk('');
            }}
          >
            {open ? t('cancel') : t('setKey')}
          </button>
        </div>
        {open && (
          <>
            {cred.oauthEnabled && (
              <div style={{ marginTop: 10 }}>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={busy}
                  onClick={() => void startOauth()}
                >
                  {busy && !oauth ? t('oauthStarting') : t('oauthTitle')}
                </button>
              </div>
            )}
            {oauthPanel}
            {!oauth && manualForm}
            {err && (
              <p style={{ color: 'var(--fg-error)', fontSize: 12, marginTop: 8, marginBottom: 0 }}>{err}</p>
            )}
            {ok && (
              <p className="muted" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
                {ok}
              </p>
            )}
          </>
        )}
      </div>

      <CrudPage
        title="知识库"
        subtitle="得到大脑笔记"
        columns={COLUMNS}
        pageSize={PAGE_SIZE}
        inlineEdit
        standaloneForm
        search={{ placeholder: t('searchPlaceholder') }}
        api={{
          list: async (p) => {
            const res = await api.listGetnote(p);
            return { ...res, items: res.items.map(toRow) };
          },
          create: (d) => api.createGetnote(withTags(d)),
          update: (id, d) => api.updateGetnote(id, withTags(d)),
          // 删除 = 移入回收站，可恢复
          archive: (id) => api.deleteGetnote(id),
        }}
      />
    </>
  );
}
