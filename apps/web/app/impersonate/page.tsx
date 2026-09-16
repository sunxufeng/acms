'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { api, type ImpersonateListResult, type ImpersonateUserRow } from '../../lib/api';
import { resetPermissions } from '../../lib/permissions';

/**
 * 身份模拟（后台管理，2026-09-16）。**仅系统管理员**。
 *
 * 用途：以系统里任意账号的身份浏览 ACMS —— 回答「他为什么看不到这条数据」这类
 * 权限 / 数据范围问题，而不是靠猜配置。
 *
 * 两个阶段（密码没通过之前，页面上不出现任何账号信息）：
 *   ① 未解锁：居中卡片 + 密码框。后端把「解锁凭证」放 Redis（10 分钟），
 *      所以刷新页面不用重输；超时后列表接口回 403，页面自动回到这一屏。
 *   ② 已解锁：账号列表 + 每行一个「进入」。
 *
 * ⚠️ 三条实现约束（改之前先读，都是会真出问题的）：
 *   1. 进入模拟后必须 `resetPermissions()` + **整页跳转**（`window.location.href`，
 *      不是 router.push）—— 前端权限是全局单例缓存，不清的话菜单与按钮仍是管理员权限，
 *      看起来就像"切了没生效"；整页跳转才能让 RSC / SSR 用新身份重跑。
 *   2. 后端对「解锁凭证缺失」返回的是 **403 而不是 401**，因为 `request()` 会把 401
 *      一律当成未登录并跳 /login —— 那会把"解锁超时"表现成"被登出"。
 *   3. 模拟态下打开本页：后端 403（禁止嵌套），这里显示提示 + 一个「退出模拟」按钮。
 */

type Phase = 'locked' | 'unlocked';
type Blocked = '' | 'admin' | 'nested';
type LockInfo =
  | { code: 'BAD_PASSWORD'; remaining: number; fails: number }
  | { code: 'LOCKED'; lockedSeconds: number }
  | null;

/** 把文案里的 `**粗体**` 渲染成 <b>（避免在 json 里塞 HTML） */
function rich(text: string): ReactNode[] {
  return text.split(/\*\*(.+?)\*\*/g).map((part, i) => (i % 2 ? <b key={i}>{part}</b> : part));
}

/** 时间戳 → HH:MM（页面只需表达"几点前有效"） */
function hhmm(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export default function ImpersonatePage() {
  const t = useTranslations('impersonate');

  const [phase, setPhase] = useState<Phase>('locked');
  const [blocked, setBlocked] = useState<Blocked>('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [lockInfo, setLockInfo] = useState<LockInfo>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [data, setData] = useState<ImpersonateListResult | null>(null);
  /** 解锁到期时间戳（仅用于显示"HH:MM 前有效"） */
  const [expiresAt, setExpiresAt] = useState(0);
  const [entering, setEntering] = useState('');
  const [exiting, setExiting] = useState(false);
  // 进入前的选项（Phase 2）：只读 / 模块白名单
  const [enterTarget, setEnterTarget] = useState<ImpersonateUserRow | null>(null);
  const [enterReadOnly, setEnterReadOnly] = useState(false);
  const [enterModules, setEnterModules] = useState<string[]>([]);
  const [moduleOptions, setModuleOptions] = useState<{ key: string; label: string }[]>([]);

  // 筛选
  const [q, setQ] = useState('');
  const [campus, setCampus] = useState('');
  const [role, setRole] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await api.impersonateUsers();
      setData(r);
      setPhase('unlocked');
      setBlocked('');
      setError('');
    } catch (e) {
      const m = (e as Error).message || '';
      if (m.includes('IMPERSONATE_UNLOCK_REQUIRED')) {
        // 凭证过期：回到密码屏（不白屏、不弹错）
        setPhase('locked');
        setData(null);
        setNotice(t('unlockExpired'));
      } else if (m.includes('IMPERSONATE_NESTED_DENIED')) {
        setBlocked('nested');
      } else if (m.includes('ADMIN_ONLY')) {
        setBlocked('admin');
      } else {
        setError(t('loadFailed'));
      }
    }
  }, [t]);

  // 进页面先探一次：10 分钟内解锁过就直接出列表，否则是密码屏
  useEffect(() => {
    void load();
  }, [load]);

  // 模块清单：点「进入」时才拉（省一次请求）；清单来自后端 MODULE_RESOURCES，不在前端硬编码
  useEffect(() => {
    if (!enterTarget || moduleOptions.length) return;
    api
      .impersonateModules()
      .then(setModuleOptions)
      .catch(() => setModuleOptions([]));
  }, [enterTarget, moduleOptions.length]);

  async function doUnlock() {
    if (!password || busy) return;
    setBusy(true);
    setLockInfo(null);
    setNotice('');
    setError('');
    try {
      const r = await api.impersonateUnlock(password);
      if (r.ok) {
        setExpiresAt(Date.now() + r.expiresIn * 1000);
        setPassword('');
        await load();
      } else if (r.code === 'LOCKED') {
        setLockInfo({ code: 'LOCKED', lockedSeconds: r.lockedSeconds });
      } else {
        setLockInfo({ code: 'BAD_PASSWORD', remaining: r.remaining, fails: r.fails });
      }
    } catch {
      setError(t('unlockFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function doLock() {
    try {
      await api.impersonateLock();
    } catch {
      /* 锁定失败也当作已锁定：下面强制回密码屏 */
    }
    setData(null);
    setPhase('locked');
    setNotice(t('lockedBack'));
  }

  async function doEnter(openId: string, opts?: { readOnly?: boolean; modules?: string[] }) {
    if (entering) return;
    setEntering(openId);
    setError('');
    try {
      await api.impersonateEnter(openId, opts);
      // 清前端权限单例缓存，然后整页跳转 —— 让 RSC / SSR 用新身份全部重跑
      resetPermissions();
      window.location.href = '/';
    } catch (e) {
      setError(`${t('enterFailed')}：${(e as Error).message || ''}`);
      setEntering('');
      setEnterTarget(null);
    }
  }

  /** 打开「进入」确认框：默认不加限制（管理员需要时才勾只读 / 限模块） */
  function openEnterDialog(row: ImpersonateUserRow) {
    setEnterTarget(row);
    setEnterReadOnly(false);
    setEnterModules([]);
  }

  async function doExit() {
    if (exiting) return;
    setExiting(true);
    setError('');
    try {
      const r = await api.impersonateExit();
      resetPermissions();
      if (r.restored) window.location.href = '/';
      else {
        // 管理员原会话已过期：后端已清 Cookie，回登录页而不是留在悬空状态
        window.location.href = '/login';
      }
    } catch {
      setError(t('exitFailed'));
      setExiting(false);
    }
  }

  const campuses = useMemo(
    () => Array.from(new Set((data?.users ?? []).map((u) => u.campus).filter(Boolean))).sort(),
    [data],
  );
  const allRoles = useMemo(() => {
    const s = new Set<string>();
    for (const u of data?.users ?? []) for (const r of u.roles) if (r) s.add(r);
    return Array.from(s).sort();
  }, [data]);

  const rows = useMemo(() => {
    const kw = q.trim().toLowerCase();
    return (data?.users ?? []).filter((u) => {
      if (campus && u.campus !== campus) return false;
      if (role && !u.roles.includes(role)) return false;
      if (kw && !`${u.name} ${u.teacherType} ${u.roles.join(' ')}`.toLowerCase().includes(kw)) return false;
      return true;
    });
  }, [data, campus, role, q]);

  // ── 渲染 ──────────────────────────────────────────────────────────

  return (
    <div className="page">
      <div className="page-content">
        <div className="page-header page-header-row">
          <div>
            <div className="page-eyebrow">{t('eyebrow')}</div>
            <h1 className="page-title">{t('title')}</h1>
            <p className="page-subtitle">{t('subtitle')}</p>
          </div>
          {phase === 'unlocked' && !blocked && (
            <div className="page-header-actions">
              <span className="imp-unlocked-pill">
                🔓 {t('unlocked', { time: hhmm(expiresAt) })}
              </span>
              <button type="button" className="btn btn-outline" onClick={doLock}>
                {t('lockNow')}
              </button>
            </div>
          )}
        </div>

        {!blocked && (
          <div className="notice notice-warn imp-warn">
            <span>⚠️</span>
            <div>{rich(t('warnHighRisk'))}</div>
          </div>
        )}

        {error && (
          <div className="notice notice-error">
            <span>✕</span>
            <div>{error}</div>
          </div>
        )}

        {blocked === 'admin' ? (
          <div className="empty-state">
            <div className="empty-state-icon">🔒</div>
            <div className="empty-state-text">{t('needAdmin')}</div>
          </div>
        ) : blocked === 'nested' ? (
          <div className="card" style={{ padding: 20 }}>
            <div className="notice notice-warn" style={{ marginBottom: 14 }}>
              <span>⚠️</span>
              <div>{t('nestedDenied')}</div>
            </div>
            <button type="button" className="btn btn-primary" onClick={doExit} disabled={exiting}>
              {exiting ? t('exiting') : t('exit')}
            </button>
          </div>
        ) : phase === 'locked' ? (
          /* ── ① 未解锁：整屏只有密码框，不泄露任何账号信息 ── */
          <div className="imp-lock-wrap">
            <div className="card imp-lock-card">
              <div className="imp-lock-ic">🔒</div>
              <h2 className="imp-lock-title">{lockInfo?.code === 'LOCKED' ? t('lockedTitle') : t('unlockTitle')}</h2>

              {lockInfo?.code === 'LOCKED' ? (
                <p className="imp-lock-desc">
                  {t('lockedDesc', { min: Math.max(1, Math.ceil(lockInfo.lockedSeconds / 60)) })}
                </p>
              ) : (
                <p className="imp-lock-desc">
                  {t('unlockDesc')}
                  <br />
                  {t('unlockValid', { min: 10 })}
                </p>
              )}

              <input
                className={`form-input imp-lockin${lockInfo?.code === 'BAD_PASSWORD' ? ' imp-lockin-bad' : ''}`}
                type="password"
                value={password}
                placeholder={t('passwordPlaceholder')}
                autoComplete="off"
                disabled={lockInfo?.code === 'LOCKED'}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void doUnlock();
                }}
              />

              {lockInfo?.code === 'BAD_PASSWORD' && (
                <div className="imp-lock-fail">
                  <span>✕</span>
                  <span>{t('badPasswordTimes', { n: lockInfo.fails, max: 5 })}</span>
                </div>
              )}
              {lockInfo?.code === 'BAD_PASSWORD' && (
                <p className="imp-lock-rest">{t('badPasswordRest', { n: lockInfo.remaining })}</p>
              )}
              {notice && !lockInfo && <p className="imp-lock-rest">{notice}</p>}

              <div className="imp-lock-act">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={doUnlock}
                  disabled={busy || !password || lockInfo?.code === 'LOCKED'}
                >
                  {busy ? t('unlocking') : t('unlock')}
                </button>
                <button
                  type="button"
                  className="btn btn-outline"
                  onClick={() => {
                    window.location.href = '/';
                  }}
                >
                  {t('backHome')}
                </button>
              </div>

              <div className="imp-lock-tip">
                <b>{t('tipTitle')}</b>
                <ul>
                  <li>{t('tipPassword')}</li>
                  <li>{t('tipLock')}</li>
                  <li>{t('tipLog')}</li>
                </ul>
              </div>
            </div>
          </div>
        ) : (
          /* ── ② 已解锁：账号列表 ── */
          <>
            <div className="imp-toolbar">
              <select className="form-input imp-select imp-select-w" value={campus} onChange={(e) => setCampus(e.target.value)}>
                <option value="">{t('filterCampus')}</option>
                {campuses.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <select className="form-input imp-select" value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="">{t('filterRole')}</option>
                {allRoles.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              <input
                className="form-input imp-search"
                value={q}
                placeholder={t('searchPlaceholder')}
                onChange={(e) => setQ(e.target.value)}
              />
              <span className="imp-stat">
                {data && data.disabled > 0
                  ? t('stat', { total: data.total, ok: data.enterable, bad: data.disabled })
                  : t('statAll', { total: data?.total ?? 0 })}
              </span>
            </div>

            <div className="card">
              <div className="dept-card-head">
                <span className="dept-card-title">{t('listTitle')}</span>
                <span className="dept-card-meta">{t('listMeta')}</span>
              </div>
              <div className="data-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>{t('colName')}</th>
                      <th>{t('colCampus')}</th>
                      <th>{t('colRoles')}</th>
                      <th>{t('colTeacherType')}</th>
                      <th>{t('colStatus')}</th>
                      <th style={{ textAlign: 'right' }}>{t('colOps')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((u) => (
                      <tr key={u.openId || u.name} style={u.canEnter ? undefined : { opacity: 0.55 }}>
                        <td>
                          <div className="dept-emp-name">
                            {u.name}
                            {u.openId === data?.currentOpenId && (
                              <span className="imp-self"> {t('selfTag')}</span>
                            )}
                          </div>
                          <div className="dept-emp-sub">{u.openId || '—'}</div>
                        </td>
                        <td>{u.campus || <span className="imp-muted">—</span>}</td>
                        <td>
                          {u.roles.length ? (
                            u.roles.map((r) => (
                              <span key={r} className="imp-role">
                                {r}
                              </span>
                            ))
                          ) : (
                            <span className="imp-muted">—</span>
                          )}
                        </td>
                        <td>{u.teacherType || <span className="imp-muted">—</span>}</td>
                        <td>
                          <span className={`dept-status ${u.canEnter ? 'dept-status-ok' : 'dept-status-inactive'}`}>
                            {u.canEnter ? t('statusEnabled') : t('statusDisabled')}
                          </span>
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {u.canEnter ? (
                            <button
                              type="button"
                              className="btn btn-primary btn-sm"
                              disabled={!!entering}
                              title={u.roles.includes('系统管理员') ? u.name : undefined}
                              onClick={() => openEnterDialog(u)}
                            >
                              {entering === u.openId ? t('entering') : `${t('enter')} →`}
                            </button>
                          ) : (
                            <button type="button" className="btn btn-outline btn-sm" disabled title={u.reason}>
                              {u.openId ? t('btnDisabled') : t('btnNoOpenId')}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                    {rows.length === 0 && (
                      <tr>
                        <td colSpan={6}>
                          <div className="empty-state">
                            <div className="empty-state-text">{t('noUsers')}</div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}

        {/* ── 进入前的选项（Phase 2）──────────────────────────────
            限制项由**服务端**在 SessionGuard 里统一拦截（业务接口零改动），
            这里只是收集参数。默认都不勾 —— 排查权限问题九成只需要读，
            但「他能不能提交这条考勤」这类验证需要写，所以不强制只读。 */}
        {enterTarget && (
          <div className="modal-overlay" onClick={() => (entering ? null : setEnterTarget(null))}>
            <div className="imp-enter-modal" onClick={(e) => e.stopPropagation()}>
              <div className="imp-enter-head">
                <h3>{t('enterTitle', { name: enterTarget.name })}</h3>
                <p>{t('enterDesc')}</p>
              </div>

              <label className="imp-enter-row">
                <input
                  type="checkbox"
                  checked={enterReadOnly}
                  onChange={(e) => setEnterReadOnly(e.target.checked)}
                />
                <span>
                  <b>{t('enterReadOnly')}</b>
                  <span className="imp-muted">　{t('enterReadOnlyHint')}</span>
                </span>
              </label>

              <div className="imp-enter-row" style={{ alignItems: 'flex-start' }}>
                <span style={{ flex: 1 }}>
                  <b>{t('enterModules')}</b>
                  <div className="imp-muted" style={{ marginTop: 2, fontSize: 'var(--font-xs)' }}>
                    {t('enterModulesHint')}
                  </div>
                  <select
                    className="form-input"
                    multiple
                    size={6}
                    style={{ width: '100%', marginTop: 6 }}
                    value={enterModules}
                    onChange={(e) =>
                      setEnterModules(Array.from(e.target.selectedOptions).map((o) => o.value))
                    }
                  >
                    {moduleOptions.map((m) => (
                      <option key={m.key} value={m.key}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                  <div className="imp-muted" style={{ marginTop: 4, fontSize: 'var(--font-xs)' }}>
                    {enterModules.length
                      ? t('modulesPicked', { n: enterModules.length })
                      : t('modulesAll')}
                  </div>
                </span>
              </div>

              <div className="imp-enter-foot">
                <button
                  type="button"
                  className="btn btn-outline"
                  disabled={!!entering}
                  onClick={() => setEnterTarget(null)}
                >
                  {t('enterCancel')}
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!!entering}
                  onClick={() =>
                    void doEnter(enterTarget.openId, {
                      readOnly: enterReadOnly,
                      modules: enterModules,
                    })
                  }
                >
                  {entering ? t('entering') : t('enterConfirm')}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
