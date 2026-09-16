'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  api,
  type ApiTokenListResult,
  type ApiTokenRow,
  type ApiTokenState,
  type ApiTokenUserOption,
  type IssueTokenDto,
} from '../../lib/api';

/**
 * 令牌管理（后台管理，2026-09-16）。**仅系统管理员**。
 *
 * 用途：给 CLI / MCP / 脚本签发长期访问凭证，让 WorkBuddy、Codex 这类工具
 * 能以「一个有权限的账号」的身份读写 ACMS，而不是让人把浏览器 Cookie 抠出来塞进脚本。
 *
 * 三个阶段：
 *   ① 未解锁：居中卡片 + 密码框（与「身份模拟」同款二次密码，但 scope 独立 ——
 *      解锁了模拟不等于解锁了令牌管理）。
 *   ② 已解锁：令牌列表 + 签发 / 改限制 / 吊销。
 *   ③ 签发完成：**明文只显示一次**的醒目卡片。
 *
 * ⚠️ 四条实现约束（改之前先读，都是会真出问题的）：
 *   1. `只读` 默认开启 —— agent 拿可写令牌在校园系统里跑，风险不对称：
 *      读错了没损失，写错了要改数据 + 通知家长。写要显式打开。
 *   2. 明文**只出现一次**，库里只存 SHA-256。页面必须提示「丢了只能吊销重签」。
 *   3. 后端对「解锁凭证缺失」返回 **403 而不是 401**（`request()` 把 401 一律当未登录跳
 *      /login，用 401 会让「解锁超时」表现成「被登出」）—— 这里据此回到密码屏。
 *   4. `modules` 存的是 **key**（逗号分隔），选项来自后端 `/api-tokens/modules`
 *      （`MODULE_RESOURCES` 单一真源），**不在前端硬编码**：硬编码的话以后新增模块
 *      白名单会静默缺项，用户勾不到自己想要的模块。
 */

type Phase = 'locked' | 'unlocked' | 'blocked';
type LockInfo =
  | { code: 'BAD_PASSWORD'; remaining: number; fails: number }
  | { code: 'LOCKED'; lockedSeconds: number }
  | null;

/** 把文案里的 `**粗体**` 渲染成 <b>（避免在 json 里塞 HTML） */
function rich(text: string) {
  return text.split(/\*\*(.+?)\*\*/g).map((part, i) => (i % 2 ? <b key={i}>{part}</b> : part));
}

/** 毫秒时间戳 → YYYY-MM-DD（用于 input[type=date] 的回填） */
function toDateInput(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** YYYY-MM-DD → 当天 23:59:59 的毫秒时间戳（给「到期日」用，别在当天零点就失效） */
function fromDateInput(v: string): number {
  if (!v) return 0;
  const d = new Date(`${v}T23:59:59`);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

function fmtTime(ms: number): string {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const EMPTY_FORM = {
  name: '',
  userOpenId: '',
  usage: 'CLI',
  readOnly: true,
  modules: [] as string[],
  expire: toDateInput(Date.now() + 365 * 24 * 3600 * 1000),
  ipWhitelist: '',
  rateLimit: 0,
  logAll: false,
  remark: '',
};

export default function ApiTokensPage() {
  const t = useTranslations('apiTokens');
  const ti = useTranslations('impersonate');

  const [phase, setPhase] = useState<Phase>('locked');
  const [password, setPassword] = useState('');
  const [lockInfo, setLockInfo] = useState<LockInfo>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const [data, setData] = useState<ApiTokenListResult | null>(null);
  const [users, setUsers] = useState<ApiTokenUserOption[]>([]);
  const [modules, setModules] = useState<{ key: string; label: string }[]>([]);
  const [state, setState] = useState<ApiTokenState | null>(null);

  /** 签发完成后展示一次性的明文 */
  const [revealed, setRevealed] = useState('');

  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [showIssue, setShowIssue] = useState(false);
  const [editTarget, setEditTarget] = useState<ApiTokenRow | null>(null);
  const [editForm, setEditForm] = useState({ readOnly: true, modules: [] as string[], expire: '', rateLimit: 0, logAll: false, status: '启用', remark: '' });
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  // ── 载入 ──────────────────────────────────────────────────────

  /**
   * 拉列表。后端在「未解锁 / 非管理员」时返回 403，据此切换阶段 ——
   * 不靠前端自己判断解锁状态（那样刷新后容易和真实状态不一致）。
   */
  const loadAll = useCallback(async () => {
    try {
      const [list, us, mods] = await Promise.all([
        api.apiTokenList(),
        api.apiTokenUsers(),
        api.apiTokenModules(),
      ]);
      setData(list);
      setUsers(us);
      setModules(mods);
      setPhase('unlocked');
    } catch (e) {
      const m = (e as Error).message || '';
      if (m.includes('TOKEN_UNLOCK_REQUIRED')) setPhase('locked');
      else if (m.includes('ADMIN_ONLY')) setPhase('blocked');
      else {
        setPhase('locked');
        setNotice(`${t('loadFailed')}：${m}`);
      }
    }
  }, [t]);

  useEffect(() => {
    void api
      .apiTokensState()
      .then((s) => {
        setState(s);
        if (s.unlocked) void loadAll();
        else setPhase('locked');
      })
      .catch((e) => {
        const m = (e as Error).message || '';
        setPhase(m.includes('ADMIN_ONLY') ? 'blocked' : 'locked');
      });
  }, [loadAll]);

  // ── 解锁 / 锁定 ───────────────────────────────────────────────

  async function doUnlock() {
    if (busy) return;
    setBusy(true);
    setNotice('');
    try {
      const r = await api.apiTokensUnlock(password);
      if (r.ok) {
        setPassword('');
        setLockInfo(null);
        await loadAll();
      } else if (r.code === 'LOCKED') {
        setLockInfo({ code: 'LOCKED', lockedSeconds: r.lockedSeconds ?? 900 });
      } else {
        setLockInfo({ code: 'BAD_PASSWORD', fails: r.fails ?? 1, remaining: r.remaining ?? 0 });
      }
    } catch (e) {
      setNotice(`${ti('unlockFailed')}：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function doLock() {
    try {
      await api.apiTokensLock();
      setPhase('locked');
      setData(null);
      setNotice(ti('lockedBack'));
    } catch {
      /* 已锁定 / 会话过期都当成功看待 */
      setPhase('locked');
      setData(null);
    }
  }

  // ── 签发 / 改限制 / 吊销 ──────────────────────────────────────

  async function doIssue() {
    if (busy) return;
    if (!form.userOpenId) {
      setMsg({ tone: 'error', text: t('needUser') });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const dto: IssueTokenDto = {
        name: form.name.trim(),
        userOpenId: form.userOpenId,
        usage: form.usage,
        readOnly: form.readOnly,
        modules: form.modules,
        expiresAt: fromDateInput(form.expire),
        ipWhitelist: form.ipWhitelist.trim(),
        rateLimit: Number(form.rateLimit) || 0,
        logAll: form.logAll,
        remark: form.remark.trim(),
      };
      const r = await api.apiTokenIssue(dto);
      setRevealed(r.token);
      setShowIssue(false);
      setForm({ ...EMPTY_FORM, expire: toDateInput(Date.now() + 365 * 24 * 3600 * 1000) });
      await loadAll();
    } catch (e) {
      setMsg({ tone: 'error', text: `${t('issueFailed')}：${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  }

  function openEdit(row: ApiTokenRow) {
    setEditTarget(row);
    setEditForm({
      readOnly: row.readOnly,
      modules: [...row.modules],
      expire: toDateInput(row.expiresAt || Date.now() + 365 * 24 * 3600 * 1000),
      rateLimit: row.rateLimit,
      logAll: row.logAll,
      status: row.status,
      remark: row.remark,
    });
  }

  async function doUpdate() {
    if (!editTarget || busy) return;
    setBusy(true);
    setMsg(null);
    try {
      await api.apiTokenUpdate(editTarget.id, {
        readOnly: editForm.readOnly,
        modules: editForm.modules,
        expiresAt: fromDateInput(editForm.expire),
        rateLimit: Number(editForm.rateLimit) || 0,
        logAll: editForm.logAll,
        status: editForm.status,
        remark: editForm.remark,
      });
      setMsg({ tone: 'ok', text: t('updated') });
      setEditTarget(null);
      await loadAll();
    } catch (e) {
      setMsg({ tone: 'error', text: `${t('updateFailed')}：${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  }

  async function doRevoke(row: ApiTokenRow) {
    const reason = window.prompt(t('revokePrompt', { name: row.name }), '');
    if (reason === null) return;
    setBusy(true);
    try {
      await api.apiTokenRevoke(row.id, reason);
      setMsg({ tone: 'ok', text: t('revoked', { name: row.name }) });
      await loadAll();
    } catch (e) {
      setMsg({ tone: 'error', text: `${t('revokeFailed')}：${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  }

  const userName = useMemo(() => {
    const m = new Map(users.map((u) => [u.openId, u.name]));
    return (openId: string) => m.get(openId) ?? '';
  }, [users]);

  // ── 渲染 ──────────────────────────────────────────────────────

  if (phase === 'blocked') {
    return (
      <div className="page-content">
        <div className="notice notice-error">
          {t('needAdmin')}
          <div style={{ marginTop: 10 }}>
            <a className="btn btn-outline" href="/">
              {ti('backHome')}
            </a>
          </div>
        </div>
      </div>
    );
  }

  if (phase === 'locked') {
    return (
      <div className="page-content">
        <div className="page-header">
          <div className="page-eyebrow">{t('eyebrow')}</div>
          <h1 className="page-title">{t('title')}</h1>
          <p className="page-subtitle">{t('subtitle')}</p>
        </div>

        <div className="notice notice-warn imp-warn" style={{ marginBottom: 18 }}>
          <span>⚠</span>
          <span>{rich(t('warnHighRisk'))}</span>
        </div>

        <div className="imp-lock-wrap">
          <div className="card imp-lock-card">
            <div className="imp-lock-ic">🔑</div>
            <h2 className="imp-lock-title">
              {lockInfo?.code === 'LOCKED' ? ti('lockedTitle') : ti('unlockTitle')}
            </h2>

            {lockInfo?.code === 'LOCKED' ? (
              <p className="imp-lock-desc">
                {ti('lockedDesc', { min: Math.max(1, Math.ceil(lockInfo.lockedSeconds / 60)) })}
              </p>
            ) : (
              <p className="imp-lock-desc">
                {t('unlockDesc')}
                <br />
                {ti('unlockValid', { min: 10 })}
              </p>
            )}

            <input
              className={`form-input imp-lockin${lockInfo?.code === 'BAD_PASSWORD' ? ' imp-lockin-bad' : ''}`}
              type="password"
              value={password}
              placeholder={ti('passwordPlaceholder')}
              autoComplete="off"
              disabled={lockInfo?.code === 'LOCKED'}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void doUnlock();
              }}
            />

            {lockInfo?.code === 'BAD_PASSWORD' && (
              <>
                <div className="imp-lock-fail">
                  <span>✕</span>
                  <span>{ti('badPasswordTimes', { n: lockInfo.fails, max: 5 })}</span>
                </div>
                <p className="imp-lock-rest">{ti('badPasswordRest', { n: lockInfo.remaining })}</p>
              </>
            )}
            {notice && !lockInfo && <p className="imp-lock-rest">{notice}</p>}

            <div className="imp-lock-act">
              <button className="btn btn-primary" disabled={busy} onClick={() => void doUnlock()}>
                {busy ? ti('unlocking') : ti('unlock')}
              </button>
              <a className="btn btn-outline" href="/">
                {ti('backHome')}
              </a>
            </div>

            <div className="imp-lock-tip">
              <b>{ti('tipTitle')}</b>
              <ul>
                <li>
                  {ti('tipPassword')}
                  {state?.passwordSource === 'default' ? `（${t('pwdDefault')}）` : `（${t('pwdEnv')}）`}
                </li>
                <li>{ti('tipLock')}</li>
                <li>{t('tipIssue')}</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page-content">
      <div className="page-header">
        <div className="page-eyebrow">{t('eyebrow')}</div>
        <h1 className="page-title">{t('title')}</h1>
        <p className="page-subtitle">{t('subtitle')}</p>
        <div className="page-header-actions">
          <button className="btn btn-outline" onClick={() => void doLock()}>
            {ti('lockNow')}
          </button>
          <button className="btn btn-primary" onClick={() => setShowIssue(true)}>
            + {t('issue')}
          </button>
        </div>
      </div>

      {msg && (
        <div className={`notice ${msg.tone === 'ok' ? 'notice-ok' : 'notice-error'}`} style={{ marginBottom: 14 }}>
          {msg.text}
        </div>
      )}

      <div className="notice notice-info" style={{ marginBottom: 14 }}>{rich(t('notice'))}</div>

      {/* 一次性明文 */}
      {revealed && (
        <div className="tok-once">
          <div className="tok-once-t">⚠ {t('onceTitle')}</div>
          <div className="tok-once-key">
            <code>{revealed}</code>
            <button
              className="btn btn-outline"
              onClick={() => {
                void navigator.clipboard?.writeText(revealed);
                setMsg({ tone: 'ok', text: t('copied') });
              }}
            >
              {t('copy')}
            </button>
          </div>
          <div className="tok-once-warn">{t('onceWarn')}</div>
          <div style={{ marginTop: 10 }}>
            <button className="btn btn-primary" onClick={() => setRevealed('')}>
              {t('savedIt')}
            </button>
          </div>
        </div>
      )}

      <div className="card" style={{ padding: 0 }}>
        <div className="dept-card-head" style={{ padding: '14px 18px 10px', marginBottom: 0 }}>
          <span className="dept-card-title">{t('listTitle')}</span>
          <span className="dept-card-meta">
            {data
              ? t('stat', { total: data.total, enabled: data.enabled, writable: data.writable })
              : t('loading')}
          </span>
        </div>

        {!data ? (
          <div className="dept-loading">{t('loading')}</div>
        ) : data.rows.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">🔑</div>
            <div className="empty-state-text">{t('noTokens')}</div>
          </div>
        ) : (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('colName')}</th>
                  <th>{t('colUser')}</th>
                  <th>{t('colUsage')}</th>
                  <th>{t('colPerm')}</th>
                  <th>{t('colStatus')}</th>
                  <th>{t('colExpire')}</th>
                  <th>{t('colLastUsed')}</th>
                  <th>{t('colUsed')}</th>
                  <th>{t('colOps')}</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.id} style={r.expired ? { opacity: 0.55 } : undefined}>
                    <td>
                      <b>{r.name}</b>
                      <div className="tok-prefix">{r.prefix}…</div>
                    </td>
                    <td>
                      {r.userName || userName(r.userOpenId) || '—'}
                      {r.userOpenId === '' && <span className="tok-warn"> · {t('noUser')}</span>}
                    </td>
                    <td>{r.usage || '—'}</td>
                    <td>
                      <span className={`badge ${r.readOnly ? 'badge-ro' : 'badge-rw'}`}>
                        {r.readOnly ? t('readOnly') : t('writable')}
                      </span>{' '}
                      <span className="badge badge-mod">
                        {r.modules.length ? t('modCount', { n: r.modules.length }) : t('modAll')}
                      </span>
                    </td>
                    <td>
                      <span className={`badge ${r.expired ? 'badge-dead' : 'badge-ok'}`}>{r.status}</span>
                    </td>
                    <td className="tok-nowrap">{r.expiresAt ? fmtTime(r.expiresAt) : t('never')}</td>
                    <td className="tok-nowrap">{fmtTime(r.lastUsedAt)}</td>
                    <td>{r.usedCount}</td>
                    <td className="tok-nowrap">
                      {r.expired ? (
                        <span className="tok-muted">{t('dead')}</span>
                      ) : (
                        <>
                          <button className="link-btn" onClick={() => openEdit(r)}>
                            {t('edit')}
                          </button>
                          <button
                            className="link-btn link-btn-danger"
                            disabled={busy}
                            onClick={() => void doRevoke(r)}
                          >
                            {t('revoke')}
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="tok-foot">{t('footer')}</p>

      {/* ── 签发弹窗 ───────────────────────────────────────────── */}
      {showIssue && (
        <div className="modal-overlay" onClick={() => (busy ? null : setShowIssue(false))}>
          <div className="tok-modal" onClick={(e) => e.stopPropagation()}>
            <div className="tok-modal-head">
              <h3>{t('issue')}</h3>
              <p>{t('issueDesc')}</p>
            </div>

            <div className="tok-modal-body">
              <label className="tok-field">
                <span>{t('fName')}</span>
                <input
                  className="form-input"
                  value={form.name}
                  placeholder={t('fNamePh')}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </label>

              <label className="tok-field">
                <span>{t('fUser')}</span>
                <select
                  className="form-input"
                  value={form.userOpenId}
                  onChange={(e) => setForm({ ...form, userOpenId: e.target.value })}
                >
                  <option value="">{t('fUserPh')}</option>
                  {users.map((u) => (
                    <option key={u.openId} value={u.openId} disabled={!u.canUse}>
                      {u.name}
                      {u.campus ? ` · ${u.campus}` : ''}
                      {u.canUse ? '' : `（${u.reason}）`}
                    </option>
                  ))}
                </select>
                <em className="tok-hint">{t('fUserHint')}</em>
              </label>

              <div className="tok-row2">
                <label className="tok-field">
                  <span>{t('fUsage')}</span>
                  <select
                    className="form-input"
                    value={form.usage}
                    onChange={(e) => setForm({ ...form, usage: e.target.value })}
                  >
                    {['CLI', 'MCP', '脚本', 'CI'].map((x) => (
                      <option key={x} value={x}>
                        {x}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="tok-field">
                  <span>{t('fExpire')}</span>
                  <input
                    className="form-input"
                    type="date"
                    value={form.expire}
                    onChange={(e) => setForm({ ...form, expire: e.target.value })}
                  />
                  <em className="tok-hint">{t('fExpireHint')}</em>
                </label>
              </div>

              <label className="tok-check">
                <input
                  type="checkbox"
                  checked={form.readOnly}
                  onChange={(e) => setForm({ ...form, readOnly: e.target.checked })}
                />
                <span>
                  <b>{t('fReadOnly')}</b>
                  <em className="tok-hint">{t('fReadOnlyHint')}</em>
                </span>
              </label>

              <div className="tok-field">
                <span>
                  {t('fModules')}
                  <em className="tok-hint2">
                    {form.modules.length ? t('modCount', { n: form.modules.length }) : t('modAll')}
                  </em>
                </span>
                <div className="tok-mods">
                  {modules.map((m) => (
                    <label key={m.key} className="tok-mod">
                      <input
                        type="checkbox"
                        checked={form.modules.includes(m.key)}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            modules: e.target.checked
                              ? [...form.modules, m.key]
                              : form.modules.filter((k) => k !== m.key),
                          })
                        }
                      />
                      <span>{m.label}</span>
                    </label>
                  ))}
                </div>
                <em className="tok-hint">{t('fModulesHint')}</em>
              </div>

              <div className="tok-row2">
                <label className="tok-field">
                  <span>{t('fIp')}</span>
                  <input
                    className="form-input"
                    value={form.ipWhitelist}
                    placeholder="10.0.0.*, 1.2.3.4"
                    onChange={(e) => setForm({ ...form, ipWhitelist: e.target.value })}
                  />
                  <em className="tok-hint">{t('fIpHint')}</em>
                </label>
                <label className="tok-field">
                  <span>{t('fRate')}</span>
                  <input
                    className="form-input"
                    type="number"
                    min={0}
                    value={form.rateLimit}
                    onChange={(e) => setForm({ ...form, rateLimit: Number(e.target.value) })}
                  />
                  <em className="tok-hint">{t('fRateHint')}</em>
                </label>
              </div>

              <label className="tok-check">
                <input
                  type="checkbox"
                  checked={form.logAll}
                  onChange={(e) => setForm({ ...form, logAll: e.target.checked })}
                />
                <span>
                  <b>{t('fLogAll')}</b>
                  <em className="tok-hint">{t('fLogAllHint')}</em>
                </span>
              </label>

              <label className="tok-field">
                <span>{t('fRemark')}</span>
                <input
                  className="form-input"
                  value={form.remark}
                  onChange={(e) => setForm({ ...form, remark: e.target.value })}
                />
              </label>
            </div>

            <div className="tok-modal-foot">
              <button className="btn btn-outline" disabled={busy} onClick={() => setShowIssue(false)}>
                {t('cancel')}
              </button>
              <button className="btn btn-primary" disabled={busy} onClick={() => void doIssue()}>
                {busy ? t('working') : t('issueConfirm')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── 改限制弹窗 ─────────────────────────────────────────── */}
      {editTarget && (
        <div className="modal-overlay" onClick={() => (busy ? null : setEditTarget(null))}>
          <div className="tok-modal" onClick={(e) => e.stopPropagation()}>
            <div className="tok-modal-head">
              <h3>{t('editTitle', { name: editTarget.name })}</h3>
              <p>{t('editDesc')}</p>
            </div>

            <div className="tok-modal-body">
              <label className="tok-check">
                <input
                  type="checkbox"
                  checked={editForm.readOnly}
                  onChange={(e) => setEditForm({ ...editForm, readOnly: e.target.checked })}
                />
                <span>
                  <b>{t('fReadOnly')}</b>
                  <em className="tok-hint">{t('fReadOnlyHint')}</em>
                </span>
              </label>

              <div className="tok-field">
                <span>{t('fModules')}</span>
                <div className="tok-mods">
                  {modules.map((m) => (
                    <label key={m.key} className="tok-mod">
                      <input
                        type="checkbox"
                        checked={editForm.modules.includes(m.key)}
                        onChange={(e) =>
                          setEditForm({
                            ...editForm,
                            modules: e.target.checked
                              ? [...editForm.modules, m.key]
                              : editForm.modules.filter((k) => k !== m.key),
                          })
                        }
                      />
                      <span>{m.label}</span>
                    </label>
                  ))}
                </div>
                <em className="tok-hint">{t('fModulesHint')}</em>
              </div>

              <div className="tok-row2">
                <label className="tok-field">
                  <span>{t('fExpire')}</span>
                  <input
                    className="form-input"
                    type="date"
                    value={editForm.expire}
                    onChange={(e) => setEditForm({ ...editForm, expire: e.target.value })}
                  />
                </label>
                <label className="tok-field">
                  <span>{t('fRate')}</span>
                  <input
                    className="form-input"
                    type="number"
                    min={0}
                    value={editForm.rateLimit}
                    onChange={(e) => setEditForm({ ...editForm, rateLimit: Number(e.target.value) })}
                  />
                </label>
              </div>

              <div className="tok-row2">
                <label className="tok-field">
                  <span>{t('fStatus')}</span>
                  <select
                    className="form-input"
                    value={editForm.status}
                    onChange={(e) => setEditForm({ ...editForm, status: e.target.value })}
                  >
                    <option value="启用">启用</option>
                    <option value="停用">停用</option>
                  </select>
                  <em className="tok-hint">{t('fStatusHint')}</em>
                </label>
                <label className="tok-field">
                  <span>{t('fRemark')}</span>
                  <input
                    className="form-input"
                    value={editForm.remark}
                    onChange={(e) => setEditForm({ ...editForm, remark: e.target.value })}
                  />
                </label>
              </div>

              <label className="tok-check">
                <input
                  type="checkbox"
                  checked={editForm.logAll}
                  onChange={(e) => setEditForm({ ...editForm, logAll: e.target.checked })}
                />
                <span>
                  <b>{t('fLogAll')}</b>
                  <em className="tok-hint">{t('fLogAllHint')}</em>
                </span>
              </label>
            </div>

            <div className="tok-modal-foot">
              <button className="btn btn-outline" disabled={busy} onClick={() => setEditTarget(null)}>
                {t('cancel')}
              </button>
              <button className="btn btn-primary" disabled={busy} onClick={() => void doUpdate()}>
                {busy ? t('working') : t('save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
