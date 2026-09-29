'use client';

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useTranslations } from 'next-intl';
import {
  SUPPORT_DEFAULT_DUE_DAYS,
  SUPPORT_LEVELS,
  SUPPORT_SEVERITY_DEFAULT,
  fmtDate,
  fmtDay,
  parseDayToMs,
  supportDefaultDueMs,
  supportProblemTypeOptions,
  supportSeverityOptions,
  type SupportBoardRow,
  type SupportBoardResult,
  type SupportDetailResult,
  type SupportOwnerOption,
  type SupportSaveBody,
} from '@acms/contracts';
import { api } from '../../lib/api';

/**
 * 学生支持（2026-09-29 峰哥需求）—— `/student-support`。
 *
 * ## 这页回答三件事
 *
 * 「每天早上打开就能回答：**今天该找谁 · 为什么要找他 · 谁在管、管到哪了**。」
 * 它不是第二个学生列表 —— 学生档案解决"查某个学生"，本页解决"系统告诉我该看谁"：
 * 按优先级分组 + 每张卡给出**证据**（命中原文）+ 自动带出的负责人 + 学生级状态。
 *
 * ## 🔴🔴 判据全在 contracts / 后端，**前端一句都不重算**
 *
 * 信号（`supportSignalsOf`）、分组（`supportPriorityOf`）、排序（`supportCompareRows`）、
 * 负责人（`supportAutoOwner`）、超期（`supportOverdueDays`）都在后端算好随 `board` 返回。
 * 前端只做：展示 + 筛选 + 表单。
 * ⚠️ 尤其别在前端自己算"到期没到期 / 该不该显示"—— 一旦两处各算一份，会出现
 *    "卡片说超期 2 天、详情说没超期"这类**不报错**的矛盾。
 *
 * ## 权限（两段，别混）
 *
 * - **能不能进这页** = `module:studentSupport:read`（菜单可见性由 AppShell 按
 *   `supportMenuVisible` 判定；**写动作也走这个点**，见 contracts/module-permissions.ts 文件头 v9）。
 * - **能看多少** = 后端按 `module:studentSupportAll:read` 收敛行级范围，
 *   返回 `hiddenByScope`（被挡掉几个人）。前端**不额外过滤**，只在有挡掉时给一句提示，
 *   否则老师会以为"看板是空的 = 没问题"。
 *
 * ## 问题类型 / 严重程度读字典
 *
 * 峰哥 2026-09-29：「问题类型和严重程度读取字典表数据」。
 * ⇒ 候选一律走 `api.dictionaries()` 的 `支持问题类型` / `支持严重程度`；
 *   `supportProblemTypeOptions()` / `supportSeverityOptions()` 只在字典读不到时兜底
 *   （字典是可运营增删的，硬编码会让新加的类型在界面上选不到）。
 */
export default function StudentSupportPage() {
  const t = useTranslations('studentSupport');

  const [data, setData] = useState<SupportBoardResult | null>(null);
  const [dict, setDict] = useState<Record<string, string[]>>({});
  const [owners, setOwners] = useState<SupportOwnerOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  // 视图状态
  const [view, setView] = useState<'card' | 'list'>('card');
  const [flat, setFlat] = useState(false);
  const [closed, setClosed] = useState<Set<string>>(new Set(['P2', 'done']));
  const [q, setQ] = useState('');
  const [fCampus, setFCampus] = useState('');
  const [fOwner, setFOwner] = useState('');
  const [fSignal, setFSignal] = useState('');
  const [fMine, setFMine] = useState(false);

  // 抽屉
  const [cur, setCur] = useState<SupportBoardRow | null>(null);
  const [detail, setDetail] = useState<SupportDetailResult | null>(null);
  const [dLoading, setDLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState('');

  // 登记表单草稿（打开抽屉时按当前行初始化）
  const [dType, setDType] = useState('');
  const [dSeverity, setDSeverity] = useState<string>(SUPPORT_SEVERITY_DEFAULT);
  const [dText, setDText] = useState('');
  const [dOwner, setDOwner] = useState('');
  const [dDue, setDDue] = useState('');
  const [dNote, setDNote] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const r = await api.studentSupportBoard({
        ...(fCampus ? { campus: fCampus } : {}),
        ...(fOwner ? { owner: fOwner } : {}),
        ...(fSignal ? { signal: fSignal } : {}),
        ...(fMine ? { mine: '1' } : {}),
      });
      setData(r);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [fCampus, fOwner, fSignal, fMine]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    // 字典 + 负责人候选：都失败也不该把页面卡死（下拉退化成兜底候选）
    void (async () => {
      try {
        setDict(await api.dictionaries());
      } catch {
        /* 字典读不到时用 contracts 里的兜底候选 */
      }
      try {
        setOwners(await api.studentSupportOwners());
      } catch {
        /* 负责人候选读不到不影响查看，只是不能改负责人 */
      }
    })();
  }, []);

  const problemTypes = useMemo(
    () => supportProblemTypeOptions(dict['支持问题类型']),
    [dict],
  );
  const severities = useMemo(() => supportSeverityOptions(dict['支持严重程度']), [dict]);

  /** 关键字筛选（只按姓名/年级/班级/证据文本，纯前端，数据量小） */
  const rows = useMemo(() => {
    const list = (data?.rows ?? []).slice();
    const kw = q.trim();
    if (!kw) return list;
    return list.filter(
      (r) =>
        r.name.includes(kw) ||
        r.nameEn.toLowerCase().includes(kw.toLowerCase()) ||
        r.grade.includes(kw) ||
        r.cls.includes(kw) ||
        r.signals.some((s) => s.evidence.includes(kw)) ||
        r.problemText.includes(kw),
    );
  }, [data, q]);

  const campuses = useMemo(
    () => [...new Set((data?.rows ?? []).map((r) => r.campus).filter(Boolean))].sort(),
    [data],
  );
  const ownerNames = useMemo(
    () => [...new Set((data?.rows ?? []).map((r) => r.owner).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN')),
    [data],
  );

  const groupsOf = (level: string) => rows.filter((r) => r.level === level);

  /** 打开支持卡抽屉：同时拉详情（时间线 + 动作记录） */
  const openCard = useCallback(
    async (row: SupportBoardRow) => {
      setCur(row);
      setDetail(null);
      setSaveErr('');
      // 表单按当前行预填 —— 登记成本压到「改一项就能存」
      setDType(row.problemType || '');
      setDSeverity(row.severity || SUPPORT_SEVERITY_DEFAULT);
      setDText(row.problemText || '');
      setDOwner(row.owner || '');
      setDDue(fmtDay(row.dueMs || supportDefaultDueMs(Date.now())));
      setDNote(row.note || '');
      setDLoading(true);
      try {
        setDetail(await api.studentSupportDetail(row.studentId));
      } catch (e) {
        setSaveErr(e instanceof Error ? e.message : String(e));
      } finally {
        setDLoading(false);
      }
    },
    [],
  );

  /** 写动作统一入口：保存 → 刷新看板与抽屉（避免两处数字不一致） */
  const submit = useCallback(
    async (body: SupportSaveBody, kind: 'save' | 'claim' | 'resolve') => {
      if (!cur) return;
      setSaving(true);
      setSaveErr('');
      try {
        const dueMs = parseDayToMs(dDue);
        const payload: SupportSaveBody = {
          problemType: dType,
          severity: dSeverity,
          problemText: dText,
          owner: dOwner,
          note: dNote,
          ...(dueMs ? { dueMs } : {}),
          ...body,
        };
        if (kind === 'claim') await api.studentSupportClaim(cur.studentId, payload);
        else if (kind === 'resolve') {
          await api.studentSupportResolve(cur.studentId, {
            status: String(body.status ?? '已缓解'),
            note: dNote,
          });
        } else await api.studentSupportSave(cur.studentId, payload);

        const [fresh] = await Promise.all([api.studentSupportBoard({
          ...(fCampus ? { campus: fCampus } : {}),
          ...(fOwner ? { owner: fOwner } : {}),
          ...(fSignal ? { signal: fSignal } : {}),
          ...(fMine ? { mine: '1' } : {}),
        })]);
        setData(fresh);
        const moved = fresh.rows.find((r) => r.studentId === cur.studentId) ?? null;
        setCur(moved);
        if (moved) setDetail(await api.studentSupportDetail(moved.studentId));
        else setDetail(null);
      } catch (e) {
        setSaveErr(e instanceof Error ? e.message : String(e));
      } finally {
        setSaving(false);
      }
    },
    [cur, dType, dSeverity, dText, dOwner, dDue, dNote, fCampus, fOwner, fSignal, fMine],
  );

  const toggleGroup = (level: string) => {
    setClosed((prev) => {
      const next = new Set(prev);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });
  };

  return (
    <div>
      <div className="page-header">
        <div className="page-header-row">
          <div>
            <div className="page-eyebrow">{t('eyebrow')}</div>
            <h1 className="page-title">{t('title')}</h1>
            <p className="page-subtitle">{t('subtitle')}</p>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {data?.hiddenByScope ? (
              <span className="muted" style={{ fontSize: 12 }}>
                {t('hiddenByScope', { n: data.hiddenByScope })}
              </span>
            ) : null}
            <button className="btn btn-outline btn-sm" onClick={() => void load()} disabled={loading}>
              {t('refresh')}
            </button>
          </div>
        </div>
      </div>

      {/* 筛选 */}
      <div style={filtersStyle}>
        <select className="form-input" style={inputStyle} value={fCampus} onChange={(e) => setFCampus(e.target.value)}>
          <option value="">{t('allCampus')}</option>
          {campuses.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select className="form-input" style={inputStyle} value={fOwner} onChange={(e) => setFOwner(e.target.value)}>
          <option value="">{t('allOwner')}</option>
          {ownerNames.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select className="form-input" style={inputStyle} value={fSignal} onChange={(e) => setFSignal(e.target.value)}>
          <option value="">{t('allSignal')}</option>
          <option value="neverContacted">{t('sigNeverContacted')}</option>
          <option value="longSilence">{t('sigLongSilence')}</option>
          <option value="problemClue">{t('sigProblemClue')}</option>
          <option value="unresolved">{t('sigUnresolved')}</option>
          <option value="recentSilence">{t('sigRecentSilence')}</option>
          <option value="thinRelation">{t('sigThinRelation')}</option>
          <option value="noOwner">{t('sigNoOwner')}</option>
        </select>
        <label style={chkStyle}>
          <input type="checkbox" checked={fMine} onChange={(e) => setFMine(e.target.checked)} />
          {t('onlyMine')}
        </label>
        <input
          className="form-input"
          style={{ ...inputStyle, width: 200, marginLeft: 'auto' }}
          placeholder={t('search')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {/* KPI */}
      <div style={kpiGridStyle}>
        <Kpi label={t('kpiNeedSupport')} value={data?.kpis.needSupport ?? 0} tone="plain" />
        <Kpi label={t('kpiUnclaimed')} value={data?.kpis.unclaimed ?? 0} tone="danger" hint={t('kpiUnclaimedHint')} />
        <Kpi label={t('kpiNeverContacted')} value={data?.kpis.neverContacted ?? 0} tone="danger" />
        <Kpi label={t('kpiLongSilence')} value={data?.kpis.longSilence ?? 0} tone="warn" />
        <Kpi label={t('kpiProblemClue')} value={data?.kpis.problemClue ?? 0} tone="info" />
        <Kpi label={t('kpiUnresolved')} value={data?.kpis.unresolved ?? 0} tone="info" />
        <Kpi label={t('kpiOverdue')} value={data?.kpis.overdue ?? 0} tone={data?.kpis.overdue ? 'danger' : 'plain'} />
      </div>

      {/* 视图切换 */}
      <div style={vbarStyle}>
        <div style={segStyle}>
          <button className={flat ? 'chip' : 'chip chip-active'} onClick={() => setFlat(false)} type="button">
            {t('viewGrouped')}
          </button>
          <button className={flat ? 'chip chip-active' : 'chip'} onClick={() => setFlat(true)} type="button">
            {t('viewFlat')}
          </button>
        </div>
        <div style={{ ...segStyle, marginLeft: 'auto' }}>
          <button className={view === 'card' ? 'chip chip-active' : 'chip'} onClick={() => setView('card')} type="button">
            {t('viewCard')}
          </button>
          <button className={view === 'list' ? 'chip chip-active' : 'chip'} onClick={() => setView('list')} type="button">
            {t('viewList')}
          </button>
        </div>
      </div>

      {err ? (
        <div style={{ ...panelStyle, borderColor: 'var(--danger)', color: 'var(--danger)' }}>
          {err}
        </div>
      ) : null}

      {loading && !data ? (
        <div className="muted" style={{ padding: 24 }}>
          {t('loading')}
        </div>
      ) : null}

      {/* 空态：把"没有需要支持的学生"写成**结论**，不留空白表格 */}
      {!loading && data && rows.length === 0 ? (
        <div style={emptyStyle}>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>{t('emptyTitle')}</div>
          <div className="muted" style={{ fontSize: 12.5 }}>
            {t('emptyHint')}
          </div>
        </div>
      ) : null}

      {/* 卡片视图 */}
      {view === 'card' && rows.length > 0 ? (
        <div>
          {(flat ? [{ level: 'ALL', title: '', desc: '' }] : SUPPORT_LEVELS).map((g) => {
            const list = g.level === 'ALL' ? rows : groupsOf(g.level);
            if (!list.length) return null;
            const isClosed = !flat && closed.has(g.level);
            return (
              <div key={g.level} style={{ marginBottom: 14 }}>
                {!flat ? (
                  <div style={gheadStyle} onClick={() => toggleGroup(g.level)}>
                    <span style={{ fontSize: 10, color: 'var(--fg-tertiary)' }}>{isClosed ? '▶' : '▼'}</span>
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: levelColor(g.level),
                        display: 'inline-block',
                      }}
                    />
                    <span style={{ fontWeight: 700, fontSize: 13.5 }}>{g.title}</span>
                    <span className="muted" style={{ fontSize: 12 }}>
                      {list.length}
                    </span>
                    <span className="muted" style={{ fontSize: 12, marginLeft: 4 }}>
                      {g.desc}
                    </span>
                  </div>
                ) : null}
                {!isClosed ? (
                  <div style={cardGridStyle}>
                    {list.map((r) => (
                      <SupportCard key={r.studentId} row={r} onOpen={() => void openCard(r)} />
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {/* 列表视图 */}
      {view === 'list' && rows.length > 0 ? (
        <div style={{ ...panelStyle, padding: 0, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr>
                <th style={thStyle} />
                <th style={thStyle}>{t('colStudent')}</th>
                <th style={thStyle}>{t('colGrade')}</th>
                <th style={thStyle}>{t('colWhy')}</th>
                <th style={thStyle}>{t('colEvidence')}</th>
                <th style={thStyle}>{t('colOwner')}</th>
                <th style={thStyle}>{t('colStatus')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.studentId} style={{ cursor: 'pointer' }} onClick={() => void openCard(r)}>
                  <td style={tdStyle}>
                    <span
                      style={{
                        display: 'inline-block',
                        width: 7,
                        height: 7,
                        borderRadius: '50%',
                        background: levelColor(r.level),
                      }}
                    />
                  </td>
                  <td style={{ ...tdStyle, fontWeight: 600 }}>{r.name}</td>
                  <td style={tdStyle}>
                    {[r.grade, r.campus].filter(Boolean).join(' · ')}
                  </td>
                  <td style={tdStyle}>{r.signals.map((s) => s.label).join(' · ')}</td>
                  <td style={{ ...tdStyle, color: 'var(--fg-secondary)' }}>{r.signals[0]?.evidence ?? ''}</td>
                  <td style={tdStyle}>
                    {r.owner || '—'}
                    {r.ownerSource ? (
                      <span className="muted" style={{ fontSize: 11 }}>
                        {' '}
                        · {r.ownerSource}
                      </span>
                    ) : null}
                  </td>
                  <td style={tdStyle}>
                    <StatusBadge status={r.supportStatus} overdueDays={r.overdueDays} t={t} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {/* ── 支持卡抽屉 ── */}
      {cur ? (
        <>
          <div style={scrimStyle} onClick={() => setCur(null)} />
          <div style={drawerStyle}>
            <div style={dheadStyle}>
              <div style={avatarStyle}>{cur.name.slice(0, 1)}</div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 17, fontWeight: 700 }}>
                  {cur.name}
                  {cur.nameEn ? (
                    <span className="muted" style={{ fontSize: 12, fontWeight: 400, marginLeft: 6 }}>
                      {cur.nameEn}
                    </span>
                  ) : null}
                </div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {[cur.grade, cur.cls, cur.campus].filter(Boolean).join(' · ') || '—'}
                  {' · '}
                  {t('commCount', { n: cur.commCount })}
                  {cur.lastMs ? ` · ${t('lastComm', { d: fmtDate(cur.lastMs) })}` : ''}
                </div>
              </div>
              <button style={dcloseStyle} onClick={() => setCur(null)} type="button">
                ✕
              </button>
            </div>

            <div style={dbodyStyle}>
              {/* 为什么在这里 */}
              <div style={{ marginBottom: 18 }}>
                <div style={dsecTitleStyle}>{t('whyHere')}</div>
                {cur.signals.map((s) => (
                  <div key={s.key} style={sigStyle(s.level)}>
                    <span style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>
                      {s.icon} {s.label}
                    </span>
                    <span style={{ color: 'var(--fg-secondary)', fontSize: 12 }}>{s.evidence}</span>
                  </div>
                ))}
                {detail?.timeline?.find((x) => x.hits.length) ? (
                  <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>
                    {t('hitWords')}
                    {detail.timeline
                      .filter((x) => x.hits.length)
                      .slice(0, 3)
                      .map((x) => `${x.hits.join('、')}（${fmtDate(x.ms)}）`)
                      .join('；')}
                  </div>
                ) : null}
              </div>

              {/* 问题登记 */}
              <div style={{ marginBottom: 18 }}>
                <div style={dsecTitleStyle}>{t('register')}</div>
                <div style={fieldStyle}>
                  <label style={flabelStyle}>{t('problemType')}</label>
                  <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', flex: 1 }}>
                    {problemTypes.map((p) => (
                      <button
                        key={p}
                        type="button"
                        className={dType === p ? 'chip chip-active' : 'chip'}
                        onClick={() => setDType(dType === p ? '' : p)}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                </div>
                <div style={fieldStyle}>
                  <label style={flabelStyle}>{t('severity')}</label>
                  <div style={{ display: 'flex', gap: 5, flex: 1 }}>
                    {severities.map((s) => (
                      <button
                        key={s}
                        type="button"
                        style={sevChipStyle(dSeverity === s, s)}
                        onClick={() => setDSeverity(s)}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
                <div style={fieldStyle}>
                  <label style={flabelStyle}>{t('problemText')}</label>
                  <input
                    className="form-input"
                    style={{ ...inputStyle, flex: 1 }}
                    placeholder={t('problemTextHint')}
                    value={dText}
                    onChange={(e) => setDText(e.target.value)}
                  />
                </div>
                <div style={fieldStyle}>
                  <label style={flabelStyle}>{t('owner')}</label>
                  <select
                    className="form-input"
                    style={{ ...inputStyle, flex: 1 }}
                    value={dOwner}
                    onChange={(e) => setDOwner(e.target.value)}
                  >
                    <option value="">—</option>
                    {(owners.length ? owners.map((o) => o.name) : ownerNames.map((n) => n)).map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </div>
                <div style={fieldStyle}>
                  <label style={flabelStyle}>{t('dueDate')}</label>
                  <input
                    className="form-input"
                    type="date"
                    style={{ ...inputStyle, width: 160 }}
                    value={dDue}
                    onChange={(e) => setDDue(e.target.value)}
                  />
                  <span className="muted" style={{ fontSize: 11.5 }}>
                    {t('dueHint', { n: SUPPORT_DEFAULT_DUE_DAYS })}
                  </span>
                </div>
                <div style={fieldStyle}>
                  <label style={flabelStyle}>{t('note')}</label>
                  <input
                    className="form-input"
                    style={{ ...inputStyle, flex: 1 }}
                    value={dNote}
                    onChange={(e) => setDNote(e.target.value)}
                  />
                </div>
                {saveErr ? (
                  <div style={{ color: 'var(--danger)', fontSize: 12, marginTop: 6 }}>{saveErr}</div>
                ) : null}
                <div style={{ display: 'flex', gap: 7, justifyContent: 'flex-end', marginTop: 10 }}>
                  {!cur.supportId || cur.supportStatus === '待认领' || !cur.supportStatus ? (
                    <button
                      className="btn btn-primary btn-sm"
                      disabled={saving}
                      onClick={() => void submit({ status: '跟进中' }, 'claim')}
                      type="button"
                    >
                      {saving ? t('saving') : t('claimAndSave')}
                    </button>
                  ) : (
                    <button
                      className="btn btn-primary btn-sm"
                      disabled={saving}
                      onClick={() => void submit({}, 'save')}
                      type="button"
                    >
                      {saving ? t('saving') : t('save')}
                    </button>
                  )}
                  <button
                    className="btn btn-outline btn-sm"
                    disabled={saving}
                    onClick={() => void submit({ status: '已缓解' }, 'resolve')}
                    type="button"
                  >
                    {t('resolved')}
                  </button>
                  <button
                    className="btn btn-outline btn-sm"
                    disabled={saving}
                    onClick={() => void submit({ status: '已升级' }, 'resolve')}
                    type="button"
                  >
                    {t('escalate')}
                  </button>
                  <button
                    className="btn btn-ghost btn-sm"
                    disabled={saving}
                    onClick={() => void submit({ status: '已关闭' }, 'resolve')}
                    type="button"
                  >
                    {t('close')}
                  </button>
                </div>
              </div>

              {/* 沟通时间线 */}
              <div style={{ marginBottom: 18 }}>
                <div style={dsecTitleStyle}>
                  {t('timeline')}
                  {detail ? `（${detail.timeline.length}）` : ''}
                </div>
                {dLoading ? (
                  <div className="muted" style={{ fontSize: 12 }}>
                    {t('loading')}
                  </div>
                ) : null}
                {!dLoading && detail && detail.timeline.length === 0 ? (
                  <div style={emptyInlineStyle}>{t('noComm')}</div>
                ) : null}
                {detail?.timeline.map((x) => (
                  <div key={x.id} style={{ paddingBottom: 12 }}>
                    <div className="muted" style={{ fontSize: 11 }}>
                      {fmtDate(x.ms)} · {x.kind || '—'} · {x.owner || t('noOwner')}
                    </div>
                    <div style={{ fontSize: 12.5, fontWeight: 600 }}>{x.subject || '—'}</div>
                    {x.excerpt ? (
                      <div style={excerptStyle}>{x.excerpt}</div>
                    ) : null}
                    {x.hits.length ? (
                      <div style={{ fontSize: 11.5, color: '#1D4ED8', marginTop: 3 }}>
                        {t('hitWords')}
                        {x.hits.join('、')}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>

              {/* 支持动作 */}
              <div>
                <div style={dsecTitleStyle}>{t('actions')}</div>
                {!detail?.actions.length ? (
                  <div style={emptyInlineStyle}>{t('noAction')}</div>
                ) : null}
                {detail?.actions.map((a, i) => (
                  <div key={i} style={{ fontSize: 12.5, paddingBottom: 7 }}>
                    <span className="muted" style={{ fontSize: 11 }}>
                      {fmtDate(a.ms)} ·{' '}
                    </span>
                    {a.who} — {a.what}
                  </div>
                ))}
              </div>
            </div>

            <div style={dfootStyle}>
              <button
                className="btn btn-outline btn-sm"
                onClick={() => window.open(`/student-360?student=${encodeURIComponent(cur.studentId)}`, '_blank')}
                type="button"
              >
                {t('openProfile')}
              </button>
              <button
                className="btn btn-outline btn-sm"
                onClick={() => window.open('/student-records', '_blank')}
                type="button"
              >
                {t('addComm')}
              </button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

// ───────────────────────── 子组件 ─────────────────────────

function Kpi(props: { label: string; value: number; tone: 'plain' | 'danger' | 'warn' | 'info'; hint?: string }) {
  const color =
    props.tone === 'danger'
      ? 'var(--danger)'
      : props.tone === 'warn'
        ? '#B8860B'
        : props.tone === 'info'
          ? '#1D4ED8'
          : 'var(--fg)';
  return (
    <div style={{ ...panelStyle, padding: '11px 13px', marginBottom: 0 }}>
      <div className="muted" style={{ fontSize: 11.5 }}>
        {props.label}
        {props.hint ? <span style={{ marginLeft: 4, opacity: 0.7 }}>({props.hint})</span> : null}
      </div>
      <div style={{ fontSize: 23, fontWeight: 700, color, letterSpacing: '-0.5px' }}>{props.value}</div>
    </div>
  );
}

function StatusBadge(props: {
  status: string;
  overdueDays: number | null;
  t: ReturnType<typeof useTranslations>;
}) {
  const s = props.status || '待认领';
  const bg =
    s === '待认领'
      ? 'rgba(229,72,77,.12)'
      : s === '跟进中'
        ? 'rgba(37,99,235,.10)'
        : s === '已升级'
          ? 'rgba(124,58,237,.10)'
          : 'var(--bg-subtle)';
  const fg = s === '待认领' ? '#9B2B2E' : s === '跟进中' ? '#1D4ED8' : s === '已升级' ? '#6D28D9' : 'var(--fg-tertiary)';
  return (
    <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
      <span style={{ background: bg, color: fg, borderRadius: 999, padding: '1px 8px', fontSize: 11.5, fontWeight: 600 }}>
        ● {s}
      </span>
      {props.overdueDays ? (
        <span style={{ color: 'var(--danger)', fontSize: 11, fontWeight: 600 }}>
          ⚠ {props.t('overdue', { n: props.overdueDays })}
        </span>
      ) : null}
    </span>
  );
}

/** 一张支持卡（列表/卡片两种视图共用一个组件，样式略有差异） */
function SupportCard(props: { row: SupportBoardRow; onOpen: () => void }) {
  const t = useTranslations('studentSupport');
  const r = props.row;
  return (
    <div style={cardStyle(r.level)} onClick={props.onOpen}>
      <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start', marginBottom: 8 }}>
        <div style={avatarStyle}>{r.name.slice(0, 1)}</div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 14.5, display: 'flex', gap: 6, alignItems: 'baseline' }}>
            {r.name}
            {r.nameEn ? (
              <span className="muted" style={{ fontSize: 11.5, fontWeight: 400 }}>
                {r.nameEn}
              </span>
            ) : null}
          </div>
          <div className="muted" style={{ fontSize: 11.5 }}>
            {[r.grade, r.cls, r.campus].filter(Boolean).join(' · ') || '—'}
          </div>
        </div>
        {r.overdueDays ? (
          <span style={{ color: 'var(--danger)', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }}>
            {t('overdue', { n: r.overdueDays })}
          </span>
        ) : null}
      </div>

      {r.signals.map((s) => (
        <div key={s.key} style={sigStyle(s.level)}>
          <span style={{ fontWeight: 700, whiteSpace: 'nowrap', fontSize: 12 }}>
            {s.icon} {s.label}
          </span>
          <span style={{ color: 'var(--fg-secondary)', fontSize: 11.5 }}>{s.evidence}</span>
        </div>
      ))}

      <div style={metaRowStyle}>
        <span className="muted" style={{ fontSize: 11.5, width: 58, flexShrink: 0 }}>
          {t('owner')}
        </span>
        <span style={{ fontWeight: 600, fontSize: 12.5, color: r.owner ? 'var(--fg-secondary)' : 'var(--danger)' }}>
          {r.owner || t('unassigned')}
        </span>
        {r.ownerSource ? (
          <span style={srcPillStyle}>
            {t('auto')} · {r.ownerSource}
          </span>
        ) : null}
      </div>
      <div style={metaRowStyle}>
        <span className="muted" style={{ fontSize: 11.5, width: 58, flexShrink: 0 }}>
          {t('colStatus')}
        </span>
        <StatusBadge status={r.supportStatus} overdueDays={null} t={t} />
        {r.problemType ? <span style={srcPillStyle}>{r.problemType}</span> : null}
        {r.severity ? (
          <span style={{ ...srcPillStyle, color: sevColor(r.severity), borderColor: sevColor(r.severity) }}>
            {r.severity}
          </span>
        ) : null}
      </div>
    </div>
  );
}

// ───────────────────────── 样式 ─────────────────────────

const panelStyle: CSSProperties = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 10,
  padding: '17px 19px',
  boxShadow: '0 1px 2px rgba(23,74,69,.08)',
};
const segStyle: CSSProperties = {
  display: 'flex',
  gap: 3,
  background: 'var(--bg-subtle)',
  padding: 3,
  borderRadius: 10,
  border: '1px solid var(--border)',
};
const filtersStyle: CSSProperties = { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 };
const inputStyle: CSSProperties = { padding: '6px 10px', fontSize: 12.5 };
const chkStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12.5 };
const kpiGridStyle: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 9, marginBottom: 14 };
const vbarStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 };
const cardGridStyle: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 10 };
const gheadStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 9, padding: '7px 2px', cursor: 'pointer', userSelect: 'none' };
const thStyle: CSSProperties = {
  textAlign: 'left',
  padding: '8px 11px',
  fontSize: 11.5,
  fontWeight: 600,
  color: 'var(--fg-secondary)',
  borderBottom: '1px solid var(--border)',
  background: 'var(--table-head-bg)',
  whiteSpace: 'nowrap',
};
const tdStyle: CSSProperties = { padding: '8px 11px', borderBottom: '1px solid var(--border)', verticalAlign: 'middle' };
const metaRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, paddingTop: 5 };
const srcPillStyle: CSSProperties = {
  fontSize: 10.5,
  color: 'var(--fg-tertiary)',
  background: 'var(--bg-subtle)',
  border: '1px solid var(--border)',
  borderRadius: 999,
  padding: '0 6px',
};
const excerptStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--fg-secondary)',
  background: 'var(--bg-subtle)',
  borderLeft: '2px solid var(--border-strong)',
  padding: '5px 9px',
  borderRadius: '0 6px 6px 0',
  marginTop: 4,
  lineHeight: 1.6,
};
const emptyStyle: CSSProperties = {
  textAlign: 'center',
  padding: '26px 10px',
  color: 'var(--fg-tertiary)',
  border: '1px dashed var(--border-strong)',
  borderRadius: 10,
  lineHeight: 1.8,
};
const emptyInlineStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--fg-tertiary)',
  border: '1px dashed var(--border)',
  borderRadius: 8,
  padding: '10px 12px',
};
const scrimStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(15,56,51,.30)',
  zIndex: 40,
};
const drawerStyle: CSSProperties = {
  position: 'fixed',
  top: 0,
  right: 0,
  bottom: 0,
  width: 470,
  maxWidth: '94vw',
  background: 'var(--surface)',
  boxShadow: '0 12px 40px rgba(23,74,69,.22)',
  zIndex: 50,
  display: 'flex',
  flexDirection: 'column',
};
const dheadStyle: CSSProperties = {
  padding: '16px 18px 13px',
  borderBottom: '1px solid var(--border)',
  display: 'flex',
  gap: 12,
  alignItems: 'flex-start',
};
const avatarStyle: CSSProperties = {
  width: 34,
  height: 34,
  borderRadius: '50%',
  background: 'var(--bg-subtle)',
  border: '1px solid var(--border)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontWeight: 600,
  flexShrink: 0,
};
const dcloseStyle: CSSProperties = {
  marginLeft: 'auto',
  background: 'none',
  border: 'none',
  fontSize: 18,
  lineHeight: 1,
  color: 'var(--fg-tertiary)',
  cursor: 'pointer',
  padding: '2px 4px',
};
const dbodyStyle: CSSProperties = { flex: 1, overflowY: 'auto', padding: '15px 18px 24px' };
const dsecTitleStyle: CSSProperties = {
  fontSize: 11.5,
  letterSpacing: '.1em',
  textTransform: 'uppercase',
  color: 'var(--fg-tertiary)',
  fontWeight: 700,
  marginBottom: 8,
};
const dfootStyle: CSSProperties = {
  padding: '12px 18px',
  borderTop: '1px solid var(--border)',
  display: 'flex',
  gap: 7,
  background: 'var(--bg-subtle)',
};
const fieldStyle: CSSProperties = { display: 'flex', gap: 9, alignItems: 'center', marginBottom: 8 };
const flabelStyle: CSSProperties = { fontSize: 12.5, color: 'var(--fg-secondary)', width: 66, textAlign: 'right', flexShrink: 0 };

function levelColor(level: string): string {
  return level === 'P0' ? 'var(--danger)' : level === 'P1' ? '#B8860B' : 'var(--accent)';
}

function cardStyle(level: string): CSSProperties {
  return {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderLeft: `3px solid ${levelColor(level)}`,
    borderRadius: 12,
    padding: '12px 13px 11px',
    cursor: 'pointer',
    boxShadow: '0 1px 2px rgba(23,74,69,.08)',
  };
}

function sigStyle(level: string): CSSProperties {
  return {
    display: 'flex',
    gap: 7,
    alignItems: 'flex-start',
    fontSize: 12.5,
    padding: '5px 8px',
    borderRadius: 6,
    marginBottom: 4,
    lineHeight: 1.5,
    background:
      level === 'P0' ? 'rgba(229,72,77,.10)' : level === 'P1' ? 'rgba(184,134,11,.10)' : 'rgba(14,155,142,.10)',
  };
}


function sevChipStyle(on: boolean, sev: string): CSSProperties {
  const c = sevColor(sev);
  return {
    fontSize: 11.5,
    padding: '4px 12px',
    borderRadius: 999,
    border: `1px solid ${on ? c : 'var(--border)'}`,
    background: on ? c : 'var(--surface)',
    color: on ? '#fff' : 'var(--fg-secondary)',
    cursor: 'pointer',
    fontWeight: on ? 600 : 400,
  };
}

function sevColor(sev: string): string {
  return sev === '紧急' ? 'var(--danger)' : sev === '需介入' ? '#B8860B' : 'var(--accent)';
}
