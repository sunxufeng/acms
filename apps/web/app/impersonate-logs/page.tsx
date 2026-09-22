'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { api, type ImpersonateLogResult } from '../../lib/api';
// 筛选下拉统一走全站组件（2026-09-22 第二批）
import { FilterSelect } from '../../components/FilterSelect';

/**
 * 模拟记录（后台管理，2026-09-16 Phase 2）。
 *
 * 只读审计页：**谁在什么时候以谁的身份进过系统**。
 *
 * 与 `/impersonate` 的关键区别：**不需要二次密码**。
 * 「以他人身份进入」是高危动作，要密码；「翻看历史留痕」是低风险的只读操作，
 * 越方便查越好 —— 两者风险不同，不该共用一个门禁。
 *
 * 数据来自「身份模拟记录表」（每次进出各一条，解锁失败也记）。
 * 会话只存在 Redis 不可回溯，所以这张表是唯一能回答"上个月谁模拟过哪些账号"的地方。
 */

/** 毫秒时间戳 → 本地 `YYYY-MM-DD HH:mm:ss` */
function fmt(ts: number): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 动作 → 徽标样式（进入 / 退出 / 解锁失败 三类） */
function actionClass(action: string): string {
  if (action === '进入') return 'dept-status dept-status-ok';
  if (action === '解锁失败') return 'dept-status dept-status-resigned';
  return 'dept-status dept-status-inactive';
}

export default function ImpersonateLogsPage() {
  const t = useTranslations('impersonate');

  const [data, setData] = useState<ImpersonateLogResult | null>(null);
  const [action, setAction] = useState('');
  const [actor, setActor] = useState('');
  const [target, setTarget] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setData(await api.impersonateLogs({ action, actor, target, from, to }));
    } catch (e) {
      const m = (e as Error).message || '';
      setError(m.includes('ADMIN_ONLY') ? t('needAdmin') : t('logsLoadFailed'));
    } finally {
      setLoading(false);
    }
  }, [action, actor, target, from, to, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = data?.rows ?? [];

  return (
    <div className="page">
      <div className="page-content">
        <div className="page-header page-header-row">
          <div>
            <div className="page-eyebrow">{t('eyebrow')}</div>
            <h1 className="page-title">{t('logsTitle')}</h1>
            <p className="page-subtitle">{t('logsSubtitle')}</p>
          </div>
          <div className="page-header-actions">
            <span className="imp-stat-badge">{t('logsCount', { n: data?.total ?? 0 })}</span>
            <button type="button" className="btn btn-outline" onClick={load} disabled={loading}>
              {loading ? t('loggingLoading') : t('logsRefresh')}
            </button>
          </div>
        </div>

        <div className="notice notice-info">
          <span>ℹ</span>
          <div>{t('logsNotice')}</div>
        </div>

        {error && (
          <div className="notice notice-error">
            <span>✕</span>
            <div>{error}</div>
          </div>
        )}

        <div className="imp-toolbar">
          <FilterSelect label={t('logsColAction')} value={action} onChange={setAction} options={data?.actions ?? []} />
          <input
            className="form-input imp-search"
            value={actor}
            placeholder={t('logsActorPlaceholder')}
            onChange={(e) => setActor(e.target.value)}
          />
          <input
            className="form-input imp-search"
            value={target}
            placeholder={t('logsTargetPlaceholder')}
            onChange={(e) => setTarget(e.target.value)}
          />
          <input className="form-input imp-date" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <span className="imp-muted">～</span>
          <input className="form-input imp-date" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>

        <div className="card">
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: '170px' }}>{t('logsColTime')}</th>
                  <th style={{ width: '110px' }}>{t('logsColAction')}</th>
                  <th>{t('logsColActor')}</th>
                  <th>{t('logsColTarget')}</th>
                  <th style={{ width: '150px' }}>{t('logsColIp')}</th>
                  <th>{t('logsColDetail')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="imp-mono">{fmt(r.at)}</td>
                    <td>
                      <span className={actionClass(r.action)}>{r.action}</span>
                    </td>
                    <td>{r.actor || <span className="imp-muted">—</span>}</td>
                    <td>{r.target || <span className="imp-muted">—</span>}</td>
                    <td className="imp-mono imp-muted">{r.ip || '—'}</td>
                    <td className="imp-muted" style={{ wordBreak: 'break-all' }}>
                      {r.detail || '—'}
                    </td>
                  </tr>
                ))}
                {!rows.length && !loading && (
                  <tr>
                    <td colSpan={6}>
                      <div className="empty-state">
                        <div className="empty-state-icon">🗂</div>
                        <div className="empty-state-text">{t('logsEmpty')}</div>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <p className="imp-lock-rest" style={{ marginTop: 12 }}>
          {t('logsFooter')}
        </p>
      </div>
    </div>
  );
}
