'use client';

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useTranslations } from 'next-intl';
import {
  api,
  type IdpConfigOverview,
  type IdpConfigStudents,
  type IdpOptions,
  type IdpScopePayload,
  type IdpStudentRow,
  type IdpTeacher,
} from '../../lib/api';
import { idpStudentLabel } from '@acms/contracts';
import IdpCommDrawer, { type IdpCommTarget } from '../../components/IdpCommDrawer';

/**
 * IDP 配置（管理端，2026-09-26 重构）。
 *
 * ## 一行 = 一个「学年 × 学期」批次
 *
 * 建批次 → 按范围把学生拉进明细 → 给每个学生分配 IDP 老师。
 * 老师那边在「我的 IDP」里只看得到 `IDP老师 = 我` 的学生。
 *
 * ## 权限
 *
 * 复用原「IDP 管理」的权限点（`module:idpPlans:*`，由 `idpPlans` 这个模块 key 派生）⇒
 * 生产上的 系统管理员 / 院级管理 **零配置改动** 就能用。
 * 「我的 IDP」用的是另一套判据（`studentRecords` 系），原因见那页的注释。
 *
 * ## 沟通次数
 *
 * 表里显示的是**实时值**（服务端每次列表都按「本配置学年学期区间内、类型=IDP沟通」重算），
 * 所以老师和学生刚记完立刻能看到。工具栏的「重算」是把实时值**固化进表**——
 * 作用是让 CSV 导出与按沟通次数排序也能用（`GenericCrudModule` 的导出读的是表字段）。
 */
export default function IdpConfigsPage() {
  const t = useTranslations('idpConfig');
  const [configs, setConfigs] = useState<IdpConfigOverview[]>([]);
  const [options, setOptions] = useState<IdpOptions | null>(null);
  const [teachers, setTeachers] = useState<IdpTeacher[]>([]);
  const [activeId, setActiveId] = useState('');
  const [detail, setDetail] = useState<IdpConfigStudents | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [bulkTeacher, setBulkTeacher] = useState('');
  const [q, setQ] = useState('');
  const [teacherFilter, setTeacherFilter] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [showPull, setShowPull] = useState(false);
  const [target, setTarget] = useState<IdpCommTarget | null>(null);

  const teacherName = useMemo(() => new Map(teachers.map((x) => [x.openId, x.name])), [teachers]);
  const active = useMemo(() => configs.find((c) => c.id === activeId) ?? null, [configs, activeId]);

  const flash = (tone: 'ok' | 'err', text: string) => {
    setNotice({ tone, text });
    window.setTimeout(() => setNotice(null), 6000);
  };

  const loadConfigs = useCallback(async () => {
    const list = await api.idpOverview();
    setConfigs(list);
    setActiveId((cur) => (cur && list.some((c) => c.id === cur) ? cur : (list[0]?.id ?? '')));
    return list;
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    if (!id) {
      setDetail(null);
      return;
    }
    setDetailLoading(true);
    try {
      setDetail(await api.idpConfigStudents(id));
      setPicked(new Set());
    } catch (e) {
      flash('err', e instanceof Error ? e.message : String(e));
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      try {
        const [, o, tc] = await Promise.all([loadConfigs(), api.idpOptions(), api.idpTeachers()]);
        setOptions(o);
        setTeachers(tc);
      } catch (e) {
        flash('err', e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [loadConfigs]);

  useEffect(() => {
    void loadDetail(activeId);
  }, [activeId, loadDetail]);

  const refreshAll = async () => {
    await loadConfigs();
    await loadDetail(activeId);
  };

  const pull = async (scope: IdpScopePayload) => {
    if (!activeId) return;
    setBusy('pull');
    try {
      const r = await api.idpPullStudents(activeId, scope);
      flash('ok', t('pulled', { added: r.added, refreshed: r.refreshed, total: r.total }));
      setShowPull(false);
      await refreshAll();
    } catch (e) {
      flash('err', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const assign = async () => {
    if (!activeId || !picked.size) return;
    setBusy('assign');
    try {
      const r = await api.idpAssignTeachers(activeId, [...picked], bulkTeacher);
      flash('ok', t('assigned', { n: r.updated }));
      await loadDetail(activeId);
      await loadConfigs();
    } catch (e) {
      flash('err', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const setRowTeacher = async (row: IdpStudentRow, openId: string) => {
    setBusy(row.id);
    try {
      await api.idpPatchStudent(row.id, { teacherOpenId: openId });
      await loadDetail(activeId);
    } catch (e) {
      flash('err', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const recount = async () => {
    setBusy('recount');
    try {
      const r = await api.idpRecount(activeId || undefined);
      flash('ok', t('recounted', { scanned: r.scanned, updated: r.updated, noTime: r.noTime }));
      if (r.badRange.length) flash('err', t('badRange', { list: r.badRange.join(' / ') }));
    } catch (e) {
      flash('err', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const setStatus = async (status: string) => {
    if (!activeId) return;
    setBusy('status');
    try {
      await api.idpUpdateConfig(activeId, { 状态: status });
      flash('ok', t('statusChanged', { s: status }));
      await refreshAll();
    } catch (e) {
      flash('err', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const rows = useMemo(() => {
    const list = detail?.rows ?? [];
    const kw = q.trim();
    return list.filter((r) => {
      if (teacherFilter === '__none__' && r.teacherOpenId) return false;
      if (teacherFilter && teacherFilter !== '__none__' && r.teacherOpenId !== teacherFilter) return false;
      if (kw && !r.studentName.includes(kw) && !r.nameEn.includes(kw) && !r.cls.includes(kw)) return false;
      return true;
    });
  }, [detail, q, teacherFilter]);

  const kpi = useMemo(() => {
    const list = detail?.rows ?? [];
    return {
      total: list.length,
      assigned: list.filter((r) => r.teacherOpenId).length,
      talked: list.filter((r) => r.commCount > 0).length,
    };
  }, [detail]);

  if (loading) return <div className="dept-loading">{t('loading')}</div>;

  return (
    <div>
      <div className="page-header">
        <div className="page-header-row">
          <div>
            <div className="page-eyebrow">IDP</div>
            <h1 className="page-title">{t('title')}</h1>
            <p className="page-subtitle">{t('subtitle')}</p>
          </div>
          <button type="button" className="btn btn-primary" onClick={() => setShowNew(true)}>
            ＋ {t('newConfig')}
          </button>
        </div>
      </div>

      {notice ? (
        <div className={notice.tone === 'ok' ? 'notice' : 'notice notice-error'} style={{ marginBottom: 10 }}>
          {notice.text}
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {/* ── 左栏：批次列表 ── */}
        <div className="card" style={{ width: 268, flexShrink: 0, padding: 0 }}>
          <div className="dept-card-head" style={{ padding: '10px 12px' }}>
            <span className="dept-card-title">{t('configs')}</span>
            <span className="dept-card-meta">{t('configCount', { n: configs.length })}</span>
          </div>
          {configs.length === 0 ? (
            <div className="muted" style={{ padding: 12, fontSize: 12.5 }}>{t('noConfig')}</div>
          ) : (
            configs.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setActiveId(c.id)}
                style={{
                  ...listBtnStyle,
                  background: c.id === activeId ? 'var(--bg-subtle)' : 'transparent',
                }}
              >
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: 'block', fontWeight: 600, fontSize: 13 }}>
                    {`${c.yearName} ${c.term}`.trim() || c.name}
                  </span>
                  <span className="muted" style={{ fontSize: 11.5 }}>
                    {c.scopeText || t('scopeUnset')}
                  </span>
                </span>
                <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                  <span className="dept-count">{c.studentCount}</span>
                  {c.archived ? <span className="tag" style={{ fontSize: 10 }}>{t('archived')}</span> : null}
                </span>
              </button>
            ))
          )}
        </div>

        {/* ── 右栏：KPI + 工具栏 + 明细 ── */}
        <div style={{ flex: '1 1 560px', minWidth: 0 }}>
          {!active ? (
            <div className="empty-state">
              <div className="empty-state-icon">🧭</div>
              <div className="empty-state-text">{t('pickHint')}</div>
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
                <Kpi label={t('kpiTotal')} value={kpi.total} />
                <Kpi label={t('kpiAssigned')} value={kpi.assigned} />
                <Kpi label={t('kpiTalked')} value={kpi.talked} />
                {detail?.rangeOk ? (
                  <span className="muted" style={{ fontSize: 12 }}>
                    {t('rangeIs', { range: detail.rangeText })}
                  </span>
                ) : (
                  <span style={{ fontSize: 12, color: 'var(--fg-error)' }}>{t('rangeBad')}</span>
                )}
              </div>

              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
                <button
                  type="button"
                  className="btn btn-outline btn-sm"
                  disabled={!!busy || active.archived}
                  onClick={() => setShowPull(true)}
                >
                  {busy === 'pull' ? t('working') : t('pull')}
                </button>
                <button type="button" className="btn btn-outline btn-sm" disabled={!!busy} onClick={() => void recount()}>
                  {busy === 'recount' ? t('working') : t('recount')}
                </button>
                {active.archived ? (
                  <button
                    type="button"
                    className="btn btn-outline btn-sm"
                    disabled={!!busy}
                    onClick={() => void setStatus('进行中')}
                  >
                    {t('reopen')}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-outline btn-sm"
                    disabled={!!busy}
                    onClick={() => void setStatus('已归档')}
                  >
                    {t('archive')}
                  </button>
                )}
                <span style={{ width: 1, height: 18, background: 'var(--border)' }} />
                <input
                  className="form-input"
                  style={{ width: 150 }}
                  placeholder={t('searchPlaceholder')}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                />
                <select
                  className="form-input"
                  style={{ width: 160 }}
                  value={teacherFilter}
                  onChange={(e) => setTeacherFilter(e.target.value)}
                >
                  <option value="">{t('filterTeacherAll')}</option>
                  <option value="__none__">{t('filterTeacherNone')}</option>
                  {teachers.map((x) => (
                    <option key={x.openId} value={x.openId}>{x.name}</option>
                  ))}
                </select>
              </div>

              {/* 批量分配：勾了行才出现 */}
              {picked.size > 0 ? (
                <div className="card" style={{ padding: 10, marginBottom: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13 }}>{t('pickedN', { n: picked.size })}</span>
                  <select className="form-input" style={{ width: 170 }} value={bulkTeacher} onChange={(e) => setBulkTeacher(e.target.value)}>
                    <option value="">{t('teacherUnassign')}</option>
                    {teachers.map((x) => (
                      <option key={x.openId} value={x.openId}>{x.name}</option>
                    ))}
                  </select>
                  <button type="button" className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => void assign()}>
                    {busy === 'assign' ? t('working') : t('apply')}
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPicked(new Set())}>
                    {t('clearPick')}
                  </button>
                </div>
              ) : null}

              {detailLoading ? (
                <div className="dept-loading">{t('loading')}</div>
              ) : rows.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-state-icon">👥</div>
                  <div className="empty-state-text">
                    {(detail?.rows.length ?? 0) === 0 ? t('noStudents') : t('noMatch')}
                  </div>
                </div>
              ) : (
                <div className="data-table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th style={{ width: 34 }}>
                          <input
                            type="checkbox"
                            checked={picked.size > 0 && picked.size === rows.length}
                            onChange={(e) => setPicked(e.target.checked ? new Set(rows.map((r) => r.studentId)) : new Set())}
                          />
                        </th>
                        <th style={{ minWidth: 110 }}>{t('colStudent')}</th>
                        {/* 「班级」列刻意不显示：学生档案里「当前班级」是空关联，
                            唯一有值的是「当前年级」⇒ 两列会显示同一个值。见 idp.service 的 studentCls 注释。 */}
                        <th style={{ minWidth: 90 }}>{t('colGrade')}</th>
                        <th style={{ minWidth: 160 }}>{t('colTeacher')}</th>
                        <th style={{ minWidth: 70 }}>{t('colCommCount')}</th>
                        <th style={{ minWidth: 120 }}>{t('colLast')}</th>
                        <th style={{ minWidth: 90 }}>{t('colOps')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.id}>
                          <td>
                            <input
                              type="checkbox"
                              checked={picked.has(r.studentId)}
                              onChange={(e) =>
                                setPicked((cur) => {
                                  const next = new Set(cur);
                                  if (e.target.checked) next.add(r.studentId);
                                  else next.delete(r.studentId);
                                  return next;
                                })
                              }
                            />
                          </td>
                          <td>
                            <div className="dept-emp-name">{idpStudentLabel(r.studentName, r.nameEn)}</div>
                          </td>
                          <td className="muted">{r.grade || '—'}</td>
                          <td>
                            <select
                              className="form-input"
                              style={{ width: '100%' }}
                              value={r.teacherOpenId}
                              disabled={!!busy || active.archived}
                              onChange={(e) => void setRowTeacher(r, e.target.value)}
                            >
                              <option value="">{t('teacherUnassign')}</option>
                              {teachers.map((x) => (
                                <option key={x.openId} value={x.openId}>{x.name}</option>
                              ))}
                              {/* 用户已删除 / open_id 不在候选里时，保留原值以免静默清空 */}
                              {r.teacherOpenId && !teacherName.has(r.teacherOpenId) ? (
                                <option value={r.teacherOpenId}>{r.teacherName}</option>
                              ) : null}
                            </select>
                          </td>
                          <td>
                            {r.commCount > 0 ? <span style={{ fontWeight: 600 }}>{r.commCount}</span> : <span className="muted">0</span>}
                            {r.noTime > 0 ? (
                              <span className="muted" style={{ fontSize: 11 }} title={t('noTimeHint')}>{` +${r.noTime}?`}</span>
                            ) : null}
                          </td>
                          <td className="muted">{r.lastAt ? fmtDate(r.lastAt) : '—'}</td>
                          <td>
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              onClick={() =>
                                setTarget({
                                  configId: active.id,
                                  configName: `${active.yearName} ${active.term}`.trim() || active.name,
                                  studentId: r.studentId,
                                  studentName: r.studentName,
                                  cls: r.cls,
                                  archived: active.archived,
                                  // 「IDP学生」明细行 id —— 抽屉里「导入笔记」的关联目标
                                  detailId: r.id,
                                })
                              }
                            >
                              {t('viewComms')}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {showNew && options ? (
        <NewConfigModal
          options={options}
          onClose={() => setShowNew(false)}
          onCreated={async (id) => {
            setShowNew(false);
            setActiveId(id);
            await loadConfigs();
            await loadDetail(id);
          }}
          onError={(m) => flash('err', m)}
        />
      ) : null}

      {showPull && options ? (
        <PullModal
          options={options}
          defaultScope={active?.scopeText ?? ''}
          busy={busy === 'pull'}
          onClose={() => setShowPull(false)}
          onConfirm={(scope) => void pull(scope)}
        />
      ) : null}

      {target ? <IdpCommDrawer target={target} onClose={() => setTarget(null)} onSaved={() => void loadDetail(activeId)} /> : null}
    </div>
  );
}

// ───────────────────────── 子组件 ─────────────────────────

function Kpi({ label, value }: { label: string; value: number }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6 }}>
      <span style={{ fontSize: 22, fontWeight: 700 }}>{value}</span>
      <span className="muted" style={{ fontSize: 12 }}>{label}</span>
    </span>
  );
}

/**
 * 新建配置：配置名 + 学年（主数据下拉）+ 学期（字典）+ 学生范围 + 说明。
 *
 * 保存后**立刻按范围拉学生**（省一步点击；拉学生本身幂等，重复点也无害）。
 * 幂等键是「学年 + 学期」—— 同一学年学期建两个批次会让"这个学生这学期归谁"说不清，
 * 所以后端在 create 上拦（`DUPLICATE_IDP_CONFIG`），这里把错误原样显示给管理员。
 */
function NewConfigModal({
  options,
  onClose,
  onCreated,
  onError,
}: {
  options: IdpOptions;
  onClose: () => void;
  onCreated: (id: string) => void;
  onError: (msg: string) => void;
}) {
  const t = useTranslations('idpConfig');
  const [yearId, setYearId] = useState(options.years.find((y) => y.current)?.id ?? options.years[0]?.id ?? '');
  const [term, setTerm] = useState(options.terms[0] ?? '');
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [kind, setKind] = useState<'all' | 'grades' | 'classes'>('all');
  const [values, setValues] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const yearName = options.years.find((y) => y.id === yearId)?.name ?? '';
  const autoName = `${yearName} ${term}`.trim();
  const candidates = kind === 'grades' ? options.grades : options.classes;

  const save = async () => {
    if (!yearId || !term) {
      setErr(t('needYearTerm'));
      return;
    }
    setSaving(true);
    setErr('');
    try {
      const created = await api.idpCreateConfig({
        配置名称: name.trim() || autoName,
        学年: [yearId],
        学期: term,
        状态: '进行中',
        学生范围: kind === 'all' ? options.allLabel : `${kind === 'grades' ? t('byGrade') : t('byClass')}：${values.join(' / ')}`,
        说明: note,
        创建时间: Date.now(),
      });
      const id = String((created as { id?: string }).id ?? '');
      if (id) {
        const scope: IdpScopePayload =
          kind === 'all' ? { kind: 'all' } : kind === 'grades' ? { kind: 'grades', values } : { kind: 'classes', values };
        try {
          await api.idpPullStudents(id, scope);
        } catch (e) {
          // 批次已建好、只是拉学生失败：不阻断（管理员可以再点「拉学生」），但要告诉他
          onError(e instanceof Error ? e.message : String(e));
        }
      }
      onCreated(id);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      setErr(m);
      onError(m);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="detail-modal" onClick={(e) => e.stopPropagation()}>
        <div className="detail-modal-head">
          <h3 className="detail-modal-title">{t('newConfig')}</h3>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>{t('close')}</button>
        </div>
        <div className="detail-modal-body" style={{ whiteSpace: 'normal' }}>
          {err ? <div className="notice notice-error" style={{ marginBottom: 10 }}>{err}</div> : null}
          <Field label={t('fName')} hint={t('fNameHint', { auto: autoName })}>
            <input className="form-input" style={{ width: '100%' }} value={name} onChange={(e) => setName(e.target.value)} placeholder={autoName} />
          </Field>
          <Field label={t('fYear')}>
            <select className="form-input" style={{ width: '100%' }} value={yearId} onChange={(e) => setYearId(e.target.value)}>
              {options.years.map((y) => (
                <option key={y.id} value={y.id}>{y.name}{y.current ? `（${t('current')}）` : ''}</option>
              ))}
            </select>
          </Field>
          <Field label={t('fTerm')}>
            <select className="form-input" style={{ width: '100%' }} value={term} onChange={(e) => setTerm(e.target.value)}>
              {options.terms.map((x) => (
                <option key={x} value={x}>{x}</option>
              ))}
            </select>
          </Field>
          <Field label={t('fScope')} hint={t('fScopeHint')}>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
              {(['all', 'grades', 'classes'] as const).map((k) => (
                <label key={k} style={{ fontSize: 13, display: 'inline-flex', gap: 5, alignItems: 'center' }}>
                  <input
                    type="radio"
                    checked={kind === k}
                    onChange={() => {
                      setKind(k);
                      setValues([]);
                    }}
                  />
                  {k === 'all' ? options.allLabel : k === 'grades' ? t('byGrade') : t('byClass')}
                </label>
              ))}
            </div>
            {kind !== 'all' ? (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', maxHeight: 150, overflowY: 'auto' }}>
                {candidates.length === 0 ? (
                  <span className="muted" style={{ fontSize: 12.5 }}>{t('noCandidate')}</span>
                ) : (
                  candidates.map((c) => (
                    <label key={c.value} className="tag" style={{ cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={values.includes(c.value)}
                        onChange={(e) =>
                          setValues((cur) => (e.target.checked ? [...cur, c.value] : cur.filter((v) => v !== c.value)))
                        }
                      />
                      {`${c.value}（${c.count}）`}
                    </label>
                  ))
                )}
              </div>
            ) : null}
          </Field>
          <Field label={t('fNote')}>
            <textarea className="form-input" style={{ width: '100%', minHeight: 56 }} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
        <div className="detail-modal-foot">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>{t('cancel')}</button>
          <button type="button" className="btn btn-primary btn-sm" disabled={saving} onClick={() => void save()}>
            {saving ? t('saving') : t('createAndPull')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 拉学生（重选范围；默认用批次里记录过的范围当提示） */
function PullModal({
  options,
  defaultScope,
  busy,
  onClose,
  onConfirm,
}: {
  options: IdpOptions;
  defaultScope: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: (scope: IdpScopePayload) => void;
}) {
  const t = useTranslations('idpConfig');
  const [kind, setKind] = useState<'all' | 'grades' | 'classes'>('all');
  const [values, setValues] = useState<string[]>([]);
  const candidates = kind === 'grades' ? options.grades : options.classes;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="detail-modal" style={{ width: 'min(520px, 100%)' }} onClick={(e) => e.stopPropagation()}>
        <div className="detail-modal-head">
          <h3 className="detail-modal-title">{t('pull')}</h3>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>{t('close')}</button>
        </div>
        <div className="detail-modal-body" style={{ whiteSpace: 'normal' }}>
          <div className="muted" style={{ fontSize: 12.5, marginBottom: 10 }}>
            {t('pullHint', { scope: defaultScope || '—' })}
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
            {(['all', 'grades', 'classes'] as const).map((k) => (
              <label key={k} style={{ fontSize: 13, display: 'inline-flex', gap: 5, alignItems: 'center' }}>
                <input
                  type="radio"
                  checked={kind === k}
                  onChange={() => {
                    setKind(k);
                    setValues([]);
                  }}
                />
                {k === 'all' ? options.allLabel : k === 'grades' ? t('byGrade') : t('byClass')}
              </label>
            ))}
          </div>
          {kind !== 'all' ? (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', maxHeight: 180, overflowY: 'auto' }}>
              {candidates.map((c) => (
                <label key={c.value} className="tag" style={{ cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={values.includes(c.value)}
                    onChange={(e) =>
                      setValues((cur) => (e.target.checked ? [...cur, c.value] : cur.filter((v) => v !== c.value)))
                    }
                  />
                  {`${c.value}（${c.count}）`}
                </label>
              ))}
            </div>
          ) : null}
        </div>
        <div className="detail-modal-foot">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>{t('cancel')}</button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={busy}
            onClick={() =>
              onConfirm(kind === 'all' ? { kind: 'all' } : kind === 'grades' ? { kind: 'grades', values } : { kind: 'classes', values })
            }
          >
            {busy ? t('working') : t('confirmPull')}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 4 }}>{label}</div>
      {hint ? <div className="muted" style={{ fontSize: 11.5, marginBottom: 4 }}>{hint}</div> : null}
      {children}
    </div>
  );
}

const listBtnStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  width: '100%',
  padding: '10px 12px',
  border: 'none',
  borderTop: '1px solid var(--border)',
  cursor: 'pointer',
  textAlign: 'left',
  color: 'var(--fg)',
};

function fmtDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
