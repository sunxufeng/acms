'use client';

import { Fragment, useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useTranslations } from 'next-intl';
import { api, type MyIdpGroup, type MyIdpResp, type IdpStudentRow } from '../../lib/api';
import { idpStudentLabel } from '@acms/contracts';
import IdpCommDrawer from '../../components/IdpCommDrawer';

/**
 * 我的 IDP（老师端，2026-09-26 新增；当日再改为**行内展开**）。
 *
 * 显示范围：`IDP老师 = 我` 的行（服务端按登录人的 open_id 过滤，前端不参与判定）。
 * 分组：按「学年 · 学期」的 IDP 配置。
 *
 * ## 学生行展开（2026-09-26 峰哥定）
 *
 * 学生名前的箭头展开后，直接把沟通面板铺在表格行里：
 *  · 列出该生在本配置学年学期内的 IDP 沟通记录（时间 · 沟通人 · 方式 · 状态 · 附件）
 *  · 点**标题**看这条记录（有关联笔记 ⇒ 笔记详情；没有 ⇒ 沟通总结 / 明细）
 *  · 附件挂在记录上，可直接下载 / 删除 / 新增
 *  · 可「从我的笔记导入」，也可「记录一次沟通」
 * ⇒ 原来那一列「继续操作 · 继续沟通」弹窗因此**整列去掉**了（同一个东西不摆两处）。
 *
 * 展开区用的是 `IdpCommDrawer` 的 **inline 变体** —— 与「IDP 配置」页的弹窗
 * 共用同一份内容与写入口，不另写一套。
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
  /**
   * 展开了沟通面板的学生行。
   * 🔴 key 必须带 configId：同一个学生在多个批次里都会出现，只用明细行 id 会串。
   */
  const [openStu, setOpenStu] = useState<Set<string>>(new Set());
  const [onlyPending, setOnlyPending] = useState(false);
  const [q, setQ] = useState('');

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

  const stuKey = (configId: string, detailId: string) => `${configId}::${detailId}`;

  /** 切换某个学生行的展开状态；`force` 给「收起」按钮用 */
  const toggleStu = (configId: string, detailId: string, force?: boolean) => {
    setOpenStu((cur) => {
      const k = stuKey(configId, detailId);
      const next = new Set(cur);
      const on = force ?? !next.has(k);
      if (on) next.add(k);
      else next.delete(k);
      return next;
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
                            <th style={{ minWidth: 180 }}>{t('colStudent')}</th>
                            <th style={{ minWidth: 90 }}>{t('colClass')}</th>
                            <th style={{ minWidth: 86 }}>{t('colCommCount')}</th>
                            <th style={{ minWidth: 120 }}>{t('colLast')}</th>
                            <th style={{ minWidth: 200 }}>{t('colLastSummary')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {g.students.map((s) => {
                            const key = stuKey(g.configId, s.id);
                            const rowOpen = openStu.has(key);
                            return (
                              // 一行 + 它的展开区：key 挂在外层 Fragment 上
                              <Fragment key={s.id}>
                                <tr
                                  style={{
                                    cursor: 'pointer',
                                    // 展开中的行给个底色：一眼看出下面这块属于谁
                                    background: rowOpen ? 'var(--accent-muted)' : undefined,
                                  }}
                                  onClick={() => toggleStu(g.configId, s.id)}
                                >
                                  <td>
                                    <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                                      <span style={{ fontSize: 11, color: 'var(--fg-tertiary)', width: 10 }}>
                                        {rowOpen ? '▾' : '▸'}
                                      </span>
                                      <span className="dept-emp-name">{idpStudentLabel(s.studentName, s.nameEn)}</span>
                                    </span>
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
                                </tr>

                                {/* 展开区：沟通面板（inline 变体 —— 与「IDP 配置」页弹窗同一份内容） */}
                                {rowOpen ? (
                                  <tr>
                                    <td colSpan={5} style={expandCellStyle}>
                                      <IdpCommDrawer
                                        variant="inline"
                                        target={{
                                          configId: g.configId,
                                          configName: `${g.yearName} ${g.term}`.trim() || g.configName,
                                          studentId: s.studentId,
                                          studentName: s.studentName,
                                          cls: s.cls,
                                          archived: g.archived,
                                          meName: data?.me.name ?? '',
                                        }}
                                        onClose={() => toggleStu(g.configId, s.id, false)}
                                        onSaved={() => void load()}
                                      />
                                    </td>
                                  </tr>
                                ) : null}
                              </Fragment>
                            );
                          })}
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

/** 展开区所在的整行单元格：左边留出与「学生」列对齐的缩进 */
const expandCellStyle: CSSProperties = {
  padding: '0 12px 14px 30px',
  background: 'var(--surface-hover)',
  borderBottom: '1px solid var(--border)',
};

function fmtDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
