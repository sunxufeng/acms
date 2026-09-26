'use client';

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useTranslations } from 'next-intl';
import { api, type MyIdpGroup, type MyIdpResp, type IdpStudentRow } from '../../lib/api';
import { idpStudentLabel } from '@acms/contracts';
import IdpCommDrawer, { type IdpCommTarget } from '../../components/IdpCommDrawer';

/**
 * 我的 IDP（老师端，2026-09-26 新增）。
 *
 * 显示范围：`IDP老师 = 我` 的行（服务端按登录人的 open_id 过滤，前端不参与判定）。
 * 分组：按「学年 · 学期」的 IDP 配置。
 *
 * ## 权限口径（与「学生记录」同源，不是 idpPlans）
 *
 * 🔴 `idpPlans` 生产实测只有 系统管理员 / 院级管理 / student / parent 持有，
 *    **Phase1~9（老师们的实际角色）一个都没有** ⇒ 若复用它，这个菜单上线后除管理员
 *    谁都看不到（本项目反复踩过的坑）。所以可见性走 `myIdpMenuVisible`
 *    （= 任一记录类型的 read），后端守卫用同一个函数。
 *
 * ## 沟通次数怎么算（界面必须写清楚）
 *
 * = 该学生在**本配置的学年学期区间内**、`记录类型=IDP沟通` 的记录数，**不区分沟通人**。
 * 服务端**实时算**（只读一次学生记录表内存分组），所以刚记完立刻可见、不用等刷新缓存。
 */
export default function MyIdpPage() {
  const t = useTranslations('myIdp');
  const [data, setData] = useState<MyIdpResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  /** 展开的配置（默认展开第一个：绝大多数老师只有一个） */
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [onlyPending, setOnlyPending] = useState(false);
  const [q, setQ] = useState('');
  const [target, setTarget] = useState<IdpCommTarget | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const r = await api.myIdp();
      setData(r);
      setOpen((cur) => {
        if (cur.size) return cur;
        const first = r.groups[0]?.configId;
        return first ? new Set([first]) : cur;
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const groups = useMemo(() => {
    const gs = data?.groups ?? [];
    const keyword = q.trim();
    return gs.map((g) => ({
      ...g,
      students: g.students.filter((s) => {
        if (onlyPending && s.commCount > 0) return false;
        if (keyword && !s.studentName.includes(keyword) && !s.nameEn.includes(keyword) && !s.cls.includes(keyword))
          return false;
        return true;
      }),
    }));
  }, [data, onlyPending, q]);

  const totalMine = (data?.groups ?? []).reduce((n, g) => n + g.total, 0);
  const totalTalked = (data?.groups ?? []).reduce((n, g) => n + g.talked, 0);

  const openDrawer = (g: MyIdpGroup, s: IdpStudentRow) => {
    setTarget({
      configId: g.configId,
      configName: `${g.yearName} ${g.term}`.trim() || g.configName,
      studentId: s.studentId,
      studentName: s.studentName,
      cls: s.cls,
      archived: g.archived,
      meName: data?.me.name ?? '',
    });
  };

  return (
    <div>
      <div className="page-header">
        <div className="page-header-row">
          <div>
            <div className="page-eyebrow">IDP</div>
            <h1 className="page-title">{t('title')}</h1>
            <p className="page-subtitle">{t('subtitle')}</p>
          </div>
        </div>
      </div>

      {(data?.groups.length ?? 0) > 0 ? (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
          <span className="muted" style={{ fontSize: 12.5 }}>
            {t('statsLine', { total: totalMine, talked: totalTalked })}
          </span>
          <input
            className="form-input"
            style={{ width: 180 }}
            placeholder={t('searchPlaceholder')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <label style={checkStyle}>
            <input type="checkbox" checked={onlyPending} onChange={(e) => setOnlyPending(e.target.checked)} />
            {t('onlyPending')}
          </label>
        </div>
      ) : null}

      {loading ? (
        <div className="dept-loading">{t('loading')}</div>
      ) : err ? (
        <div className="notice notice-error">{err}</div>
      ) : (data?.groups.length ?? 0) === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">🧭</div>
          <div className="empty-state-text">{t('empty')}</div>
        </div>
      ) : (
        groups.map((g) => {
          const expanded = open.has(g.configId);
          const pct = g.total ? Math.round((g.talked / g.total) * 100) : 0;
          return (
            <div key={g.configId} className="card" style={{ marginBottom: 12, padding: 0 }}>
              <button
                type="button"
                onClick={() =>
                  setOpen((cur) => {
                    const next = new Set(cur);
                    if (next.has(g.configId)) next.delete(g.configId);
                    else next.add(g.configId);
                    return next;
                  })
                }
                style={headBtnStyle}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  <span style={{ fontSize: 12, color: 'var(--fg-tertiary)' }}>{expanded ? '▾' : '▸'}</span>
                  <span style={{ fontWeight: 700 }}>{`${g.yearName} ${g.term}`.trim() || g.configName}</span>
                  {g.archived ? <span className="tag">{t('archived')}</span> : null}
                </span>
                <span className="muted" style={{ fontSize: 12.5 }}>
                  {t('groupStats', { total: g.total, talked: g.talked })}
                  {` · ${pct}%`}
                </span>
              </button>

              {/* 进度条：一眼看出还有几个学生没沟通 */}
              <div style={{ height: 4, background: 'var(--bg-subtle)' }}>
                <div style={{ height: 4, width: `${pct}%`, background: 'var(--accent)' }} />
              </div>

              {expanded ? (
                <div style={{ padding: '4px 14px 14px' }}>
                  <div className="muted" style={{ fontSize: 12, margin: '6px 0 8px' }}>
                    {g.rangeOk ? t('rangeIs', { range: g.rangeText }) : t('rangeBad')}
                  </div>
                  {g.students.length === 0 ? (
                    <div className="muted" style={{ fontSize: 13 }}>{t('noMatch')}</div>
                  ) : (
                    <div className="data-table-wrap">
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th style={{ minWidth: 110 }}>{t('colStudent')}</th>
                            <th style={{ minWidth: 100 }}>{t('colClass')}</th>
                            <th style={{ minWidth: 80 }}>{t('colCommCount')}</th>
                            <th style={{ minWidth: 130 }}>{t('colLast')}</th>
                            <th style={{ minWidth: 200 }}>{t('colLastSummary')}</th>
                            <th style={{ minWidth: 100 }}>{t('colOps')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {g.students.map((s) => (
                            <tr key={s.id}>
                              <td>
                                <div className="dept-emp-name">{idpStudentLabel(s.studentName, s.nameEn)}</div>
                              </td>
                              <td className="muted">{s.cls || '—'}</td>
                              <td>
                                {s.commCount > 0 ? (
                                  <span style={{ fontWeight: 600 }}>{s.commCount}</span>
                                ) : (
                                  <span className="muted">{t('notYet')}</span>
                                )}
                                {s.noTime > 0 ? (
                                  <span className="muted" style={{ fontSize: 11 }} title={t('noTimeHint')}>
                                    {` +${s.noTime}?`}
                                  </span>
                                ) : null}
                              </td>
                              <td className="muted">{s.lastAt ? fmtDate(s.lastAt) : '—'}</td>
                              <td className="muted" style={{ fontSize: 12.5 }}>
                                {s.lastSummary || '—'}
                              </td>
                              <td>
                                <button type="button" className="btn btn-primary btn-sm" onClick={() => openDrawer(g, s)}>
                                  {s.commCount > 0 ? t('continueComm') : t('startComm')}
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          );
        })
      )}

      {target ? (
        <IdpCommDrawer
          target={target}
          onClose={() => setTarget(null)}
          onSaved={() => void load()}
        />
      ) : null}
    </div>
  );
}

const checkStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  fontSize: 12.5,
  color: 'var(--fg-secondary)',
  cursor: 'pointer',
};

const headBtnStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
  width: '100%',
  padding: '12px 14px',
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  textAlign: 'left',
  color: 'var(--fg)',
};

function fmtDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
