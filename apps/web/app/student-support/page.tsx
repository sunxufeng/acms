'use client';

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useTranslations } from 'next-intl';
import {
  STUDENT_RECORD_TYPE_FIELD,
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
  type SupportStudentOption,
} from '@acms/contracts';
import CrudPage from '../../components/CrudPage';
import { buildStudentRecordColumns } from '../student-records/columns';
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
  // 默认折叠「持续观察」与「已认领 · 无信号」—— 这两组不紧急，但要在页面上一眼看到**有这一组**
  const [closed, setClosed] = useState<Set<string>>(new Set(['P2', 'claimed', 'done']));
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

  /**
   * 登记表单草稿 —— **抽屉与登记弹窗共用这一份**（字段在 `<RegisterFields>` 里，
   * 只写一遍；两处各写一份必然出现"抽屉里填了、弹窗里没带上"这类静默不一致）。
   */
  const [dType, setDType] = useState('');
  const [dSeverity, setDSeverity] = useState<string>(SUPPORT_SEVERITY_DEFAULT);
  const [dText, setDText] = useState('');
  const [dOwner, setDOwner] = useState('');
  const [dDue, setDDue] = useState('');
  const [dNote, setDNote] = useState('');

  /**
   * 登记弹窗（2026-09-30 峰哥要的「＋ 登记支持」）。
   *
   * 🔴 它存在的理由：看板只显示**有信号**的学生。一个没命中信号的学生在看板上不存在，
   *    老师想主动给他登记一条支持**原本没有任何入口**。
   * - 从页头进 ⇒ `regPick` 为空，先搜学生
   * - 从卡片「认领并登记」进 ⇒ `regPick` 直接预填该生（少一步）
   */
  const [regOpen, setRegOpen] = useState(false);
  const [regPick, setRegPick] = useState<SupportStudentOption | null>(null);
  const [stuOpts, setStuOpts] = useState<SupportStudentOption[]>([]);
  const [stuQ, setStuQ] = useState('');

  /**
   * 「记录一次沟通」（2026-09-30 峰哥：**不要开新 tab**）。
   *
   * 做法：在看板页内用 `CrudPage` 的 `formOnly`（「我的笔记 → 转换」同款模式）
   * 弹出**学生记录自己的新建表单**，字段与联动都复用同一份 `columns`。
   * 好处：不跳页、不开新 tab、默认值都填好，而且**表单只有一份定义**（不会与记录页漂移）。
   */
  const [commOpen, setCommOpen] = useState(false);

  /** 「移除卡片」（v10）：确认弹窗（要填原因）+ 已移除名单弹窗 */
  const [rmTarget, setRmTarget] = useState<SupportBoardRow | null>(null);
  const [rmReason, setRmReason] = useState('');
  const [rmBusy, setRmBusy] = useState(false);
  const [rmListOpen, setRmListOpen] = useState(false);

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

  /**
   * 登记表单预填 —— 「改一项就能存」，**抽屉与弹窗共用**。
   * 传 `RowValues` 进来即可（`SupportBoardRow` 与 `SupportStudentOption` 都是这个形状的子集）。
   */
  const fillReg = useCallback(
    (src: {
      problemType?: string;
      severity?: string;
      problemText?: string;
      owner?: string;
      dueMs?: number;
      note?: string;
    }) => {
      setDType(src.problemType || '');
      setDSeverity(src.severity || SUPPORT_SEVERITY_DEFAULT);
      setDText(src.problemText || '');
      setDOwner(src.owner || '');
      setDDue(fmtDay(src.dueMs || supportDefaultDueMs(Date.now())));
      setDNote(src.note || '');
    },
    [],
  );

  /** 表单值（传给共用的 `<RegisterFields>`；一处 state，两处渲染） */
  const regValues = useMemo(
    () => ({ type: dType, severity: dSeverity, text: dText, owner: dOwner, due: dDue, note: dNote }),
    [dType, dSeverity, dText, dOwner, dDue, dNote],
  );

  /** 负责人下拉候选：优先用户表（有 openId 的那批），读不到才退化成看板里出现过的名字 */
  const ownerChoices = useMemo(
    () => (owners.length ? owners.map((o) => o.name) : ownerNames),
    [owners, ownerNames],
  );

  const patchReg = useCallback((p: Partial<typeof regValues>) => {
    if (p.type !== undefined) setDType(p.type);
    if (p.severity !== undefined) setDSeverity(p.severity);
    if (p.text !== undefined) setDText(p.text);
    if (p.owner !== undefined) setDOwner(p.owner);
    if (p.due !== undefined) setDDue(p.due);
    if (p.note !== undefined) setDNote(p.note);
  }, []);

  /** 打开支持卡抽屉：同时拉详情（时间线 + 动作记录） */
  const openCard = useCallback(
    async (row: SupportBoardRow) => {
      setCur(row);
      setDetail(null);
      setSaveErr('');
      fillReg(row);
      setDLoading(true);
      try {
        setDetail(await api.studentSupportDetail(row.studentId));
      } catch (e) {
        setSaveErr(e instanceof Error ? e.message : String(e));
      } finally {
        setDLoading(false);
      }
    },
    [fillReg],
  );

  /**
   * 弹窗里的学生搜索结果。
   *
   * ⚠️ **没上板的排在后面**而不是隐藏 —— 老师从页头进来，多半正是一时想不起
   *    "看板上没有的那个人"（那才是需要主动登记的）。隐藏掉等于把入口又堵上。
   */
  const stuHits = useMemo(() => {
    const kw = stuQ.trim().toLowerCase();
    const list = kw
      ? stuOpts.filter((o) =>
          `${o.name}${o.nameEn}${o.grade}${o.cls}${o.campus}${o.owner}`.toLowerCase().includes(kw),
        )
      : stuOpts;
    return list
      .slice()
      .sort((a, b) =>
        Number(a.onBoard) - Number(b.onBoard) || a.name.localeCompare(b.name, 'zh-CN'),
      )
      .slice(0, 80);
  }, [stuOpts, stuQ]);

  /**
   * 「记录一次沟通」用的**学生记录表单**（列定义与接口都与学生记录页同一份）。
   *
   * 🔴 两者必须 `useMemo` 稳定住：CrudPage 把它们放进了拉数据/渲染的依赖里，
   *    每次 render 新建数组或对象字面量会导致**渲染死循环**（页面闪烁 + 每圈打接口）。
   *    项目里在 student-records 的 `extraParams` 上踩过同一个坑。
   */
  const commColumns = useMemo(() => buildStudentRecordColumns('日常跟进'), []);
  const commApi = useMemo(
    () => ({ create: (d: Record<string, unknown>) => api.createStudentRecord(d) }),
    [],
  );

  /**
   * 打开登记弹窗。`pick` 为空 = 先搜学生（页头入口）；给了学生 = 直接进登记（卡片入口）。
   * 学生候选是**懒加载**的（只在第一次打开弹窗时拉），避免每次进页面都多读 5 张表。
   */
  const openRegister = useCallback(
    async (pick: SupportBoardRow | SupportStudentOption | null) => {
      setSaveErr('');
      setStuQ('');
      if (pick) {
        setRegPick({
          studentId: pick.studentId,
          name: pick.name,
          nameEn: pick.nameEn,
          grade: pick.grade,
          cls: pick.cls,
          campus: pick.campus,
          owner: pick.owner,
          ownerSource: pick.ownerSource,
          // 从看板卡片进来时，卡片本来就在板上
          onBoard: true,
          supportStatus: 'supportStatus' in pick ? String(pick.supportStatus ?? '') : '',
        });
        // 预填已有的支持信息（有就带上，没有就是空表单）
        fillReg('problemType' in pick ? (pick as SupportBoardRow) : { owner: pick.owner });
        setRegOpen(true);
        return;
      }
      setRegPick(null);
      fillReg({});
      setRegOpen(true);
      if (!stuOpts.length) {
        try {
          setStuOpts(await api.studentSupportStudentOptions());
        } catch (e) {
          setSaveErr(e instanceof Error ? e.message : String(e));
        }
      }
    },
    [fillReg, stuOpts.length],
  );

  /**
   * 写动作唯一入口（抽屉 + 登记弹窗共用）。
   *
   * 🔴 提交后**重新拉看板**，不本地改一行：分组 / 负责人 / 超期都是后端算的，
   *    本地改必然漂移（卡片还留在「立即处理」，服务端已经不算它了）。
   * 🔴 两处各写一份提交逻辑 ⇒ 会出现"弹窗能存、抽屉报错"这种只在一条路径暴露的问题。
   */
  const doSubmit = useCallback(
    async (studentId: string, kind: 'save' | 'claim' | 'resolve', body: SupportSaveBody) => {
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
        if (kind === 'claim') await api.studentSupportClaim(studentId, payload);
        else if (kind === 'resolve') {
          await api.studentSupportResolve(studentId, {
            status: String(body.status ?? '已缓解'),
            note: dNote,
          });
        } else await api.studentSupportSave(studentId, payload);

        const fresh = await api.studentSupportBoard({
          ...(fCampus ? { campus: fCampus } : {}),
          ...(fOwner ? { owner: fOwner } : {}),
          ...(fSignal ? { signal: fSignal } : {}),
          ...(fMine ? { mine: '1' } : {}),
        });
        setData(fresh);
        return fresh;
      } catch (e) {
        setSaveErr(e instanceof Error ? e.message : String(e));
        return null;
      } finally {
        setSaving(false);
      }
    },
    [dType, dSeverity, dText, dOwner, dDue, dNote, fCampus, fOwner, fSignal, fMine],
  );

  /** 抽屉里的保存（提交后把抽屉切到刷新后的那一行） */
  const submit = useCallback(
    async (body: SupportSaveBody, kind: 'save' | 'claim' | 'resolve') => {
      if (!cur) return;
      const fresh = await doSubmit(cur.studentId, kind, body);
      if (!fresh) return;
      const moved = fresh.rows.find((r) => r.studentId === cur.studentId) ?? null;
      setCur(moved);
      if (moved) setDetail(await api.studentSupportDetail(moved.studentId));
      else setDetail(null);
    },
    [cur, doSubmit],
  );

  /** 登记弹窗里的保存：成功后关掉弹窗，学生候选的「已在看板 / 状态」也跟着更新 */
  const submitRegister = useCallback(async () => {
    if (!regPick) return;
    const fresh = await doSubmit(
      regPick.studentId,
      regPick.supportStatus && regPick.supportStatus !== '待认领' ? 'save' : 'claim',
      { status: '跟进中' },
    );
    if (!fresh) return;
    setRegOpen(false);
    setStuOpts((prev) =>
      prev.map((o) =>
        o.studentId === regPick.studentId ? { ...o, onBoard: true, supportStatus: '跟进中' } : o,
      ),
    );
  }, [regPick, doSubmit]);

  /**
   * 移除 / 恢复卡片（v10）。
   *
   * 🔴 成功后**重新拉看板**（与登记同理：分组与计数都在后端算，本地改必然与后端漂移）。
   * 🔴 没权限时后端返 403 ⇒ 走 `saveErr` 显示出来（不要静默失败：
   *    否则老师会以为"点了没反应"，其实是权限没开）。
   */
  const doDismiss = useCallback(
    async (studentId: string, reason: string, on: boolean) => {
      setRmBusy(true);
      setSaveErr('');
      try {
        await api.studentSupportDismiss(studentId, { reason, on });
        const fresh = await api.studentSupportBoard({
          ...(fCampus ? { campus: fCampus } : {}),
          ...(fOwner ? { owner: fOwner } : {}),
          ...(fSignal ? { signal: fSignal } : {}),
          ...(fMine ? { mine: '1' } : {}),
        });
        setData(fresh);
        setRmTarget(null);
        setRmReason('');
        return true;
      } catch (e) {
        setSaveErr(e instanceof Error ? e.message : String(e));
        return false;
      } finally {
        setRmBusy(false);
      }
    },
    [fCampus, fOwner, fSignal, fMine],
  );

  /**
   * 导出当前**筛选后**的名单（CSV，带 BOM 让 Excel 正确识别中文）。
   * 口径与看板一致：行是后端算好的 `rows`，前端只做筛选、不重算任何判据。
   */
  const exportCsv = useCallback(() => {
    const head = [
      t('colStudent'),
      t('colGrade'),
      t('colWhy'),
      t('colEvidence'),
      t('colOwner'),
      t('colStatus'),
      t('colProblemType'),
      t('colSeverity'),
      t('colDue'),
      t('colCommCount'),
      t('colOverdue'),
    ];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [head.map(esc).join(',')];
    for (const r of rows) {
      lines.push(
        [
          r.nameEn ? `${r.name}${r.nameEn}` : r.name,
          [r.grade, r.cls, r.campus].filter(Boolean).join(' / '),
          r.signals.map((s) => s.label).join(' / '),
          r.signals.map((s) => s.evidence).join(' / '),
          r.owner ? `${r.owner}${r.ownerSource ? `（${t('auto')}·${r.ownerSource}）` : ''}` : t('unassigned'),
          r.supportStatus || '待认领',
          r.problemType,
          r.severity,
          r.dueMs ? fmtDay(r.dueMs) : '',
          r.commCount,
          r.overdueDays ?? '',
        ]
          .map(esc)
          .join(','),
      );
    }
    const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `学生支持看板-${fmtDay(Date.now())}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, [rows, t]);

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
            <button className="btn btn-outline btn-sm" onClick={exportCsv} disabled={!rows.length}>
              {t('exportCsv')}
            </button>
            <button
              className="btn btn-primary btn-sm"
              onClick={() => void openRegister(null)}
              type="button"
            >
              ＋ {t('addSupport')}
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
        <Kpi
          label={t('kpiClaimedOnly')}
          value={data?.kpis.claimedOnly ?? 0}
          tone="plain"
          hint={t('kpiClaimedOnlyHint')}
        />
      </div>

      {/* 被移除的卡片（v10）：**这个数字必须看得见** ——
          否则"移除"就成了无声的数据消失（下次有人问"某某怎么不见了"，无从查起） */}
      {data && data.dismissedCount > 0 ? (
        <div style={{ marginBottom: 12, fontSize: 12.5, color: 'var(--fg-secondary)' }}>
          {t('dismissedHint', { n: data.dismissedCount })}
          {data.canRemove ? (
            <button
              className="btn btn-ghost btn-sm"
              style={{ marginLeft: 4 }}
              type="button"
              onClick={() => setRmListOpen(true)}
            >
              {t('dismissedView')}
            </button>
          ) : null}
        </div>
      ) : null}

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
                      <SupportCard
                        key={r.studentId}
                        row={r}
                        canRemove={data?.canRemove ?? false}
                        onOpen={() => void openCard(r)}
                        onClaim={() => void openRegister(r)}
                        onRemove={() => {
                          setRmReason('');
                          setRmTarget(r);
                        }}
                      />
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
                  <td style={tdStyle}>
                    {r.signals.length ? r.signals.map((s) => s.label).join(' · ') : t('noSignalNow')}
                  </td>
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
                {cur.signals.length === 0 ? <div style={noSignalStyle}>{t('noSignalNow')}</div> : null}
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
                <RegisterFields
                  problemTypes={problemTypes}
                  severities={severities}
                  ownerNames={ownerChoices}
                  values={regValues}
                  onChange={patchReg}
                />
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
                // 2026-09-30 峰哥：不要开新 tab —— 就在本页弹出「记录一次沟通」表单
                //（字段与学生记录页同一份 columns，默认值预填；见下面的 formOnly）
                onClick={() => setCommOpen(true)}
                type="button"
              >
                {t('addComm')}
              </button>
            </div>
          </div>
        </>
      ) : null}

      {/* ── 登记弹窗（2026-09-30 峰哥：「登记支持按钮在哪里」）──
          页头「＋ 登记支持」与卡片「认领并登记」都进这里；
          表单与抽屉共用 `<RegisterFields>`，只有一份字段定义。 */}
      {regOpen ? (
        <>
          <div style={scrimStyle} onClick={() => setRegOpen(false)} />
          <div style={modalStyle} role="dialog" aria-modal="true">
            <div style={dheadStyle}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 700 }}>
                  {t('addSupport')}
                  {regPick ? <span className="muted"> · {regPick.name}</span> : null}
                </div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {regPick ? t('registerHint') : t('pickHint')}
                </div>
              </div>
              <button style={dcloseStyle} onClick={() => setRegOpen(false)} type="button">
                ✕
              </button>
            </div>

            <div style={modalBodyStyle}>
              {!regPick ? (
                <>
                  <input
                    className="form-input"
                    style={{ ...inputStyle, width: '100%' }}
                    placeholder={t('searchStudent')}
                    value={stuQ}
                    autoFocus
                    onChange={(e) => setStuQ(e.target.value)}
                  />
                  <div style={{ marginTop: 8, maxHeight: 360, overflowY: 'auto' }}>
                    {stuHits.map((o) => (
                      <button
                        key={o.studentId}
                        type="button"
                        style={stuRowStyle}
                        onClick={() => {
                          setRegPick(o);
                          fillReg({ owner: o.owner });
                        }}
                      >
                        <span style={{ fontWeight: 600 }}>{o.name}</span>
                        {o.nameEn ? (
                          <span className="muted" style={{ fontSize: 11.5 }}>
                            {o.nameEn}
                          </span>
                        ) : null}
                        <span className="muted" style={{ fontSize: 11.5 }}>
                          {[o.grade, o.cls, o.campus].filter(Boolean).join(' · ')}
                        </span>
                        <span style={{ marginLeft: 'auto', flexShrink: 0, fontSize: 11 }}>
                          {o.onBoard ? (
                            <span style={boardPillStyle}>{t('onBoard')}</span>
                          ) : (
                            <span className="muted">{t('offBoard')}</span>
                          )}
                        </span>
                      </button>
                    ))}
                    {!stuHits.length ? (
                      <div style={emptyInlineStyle}>
                        {stuOpts.length ? t('noStudentHit') : t('loading')}
                      </div>
                    ) : null}
                  </div>
                </>
              ) : (
                <>
                  <div style={pickBoxStyle}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13.5 }}>
                        {regPick.name}
                        {regPick.nameEn ? (
                          <span className="muted" style={{ fontSize: 11.5, fontWeight: 400 }}>
                            {' '}
                            {regPick.nameEn}
                          </span>
                        ) : null}
                      </div>
                      <div className="muted" style={{ fontSize: 11.5 }}>
                        {[regPick.grade, regPick.cls, regPick.campus].filter(Boolean).join(' · ')}
                        {regPick.owner ? ` · ${t('owner')} ${regPick.owner}` : ''}
                      </div>
                    </div>
                    <button
                      className="btn btn-ghost btn-sm"
                      style={{ marginLeft: 'auto', flexShrink: 0 }}
                      type="button"
                      onClick={() => {
                        setRegPick(null);
                        setSaveErr('');
                      }}
                    >
                      {t('changeStudent')}
                    </button>
                  </div>

                  <RegisterFields
                    problemTypes={problemTypes}
                    severities={severities}
                    ownerNames={ownerChoices}
                    values={regValues}
                    onChange={patchReg}
                  />

                  {saveErr ? (
                    <div style={{ color: 'var(--danger)', fontSize: 12, marginTop: 6 }}>{saveErr}</div>
                  ) : null}
                  <div style={{ display: 'flex', gap: 7, justifyContent: 'flex-end', marginTop: 12 }}>
                    <button
                      className="btn btn-ghost btn-sm"
                      type="button"
                      onClick={() => setRegOpen(false)}
                    >
                      {t('cancel')}
                    </button>
                    <button
                      className="btn btn-primary btn-sm"
                      type="button"
                      disabled={saving}
                      onClick={() => void submitRegister()}
                    >
                      {saving
                        ? t('saving')
                        : regPick.supportStatus && regPick.supportStatus !== '待认领'
                          ? t('save')
                          : t('claimAndSave')}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </>
      ) : null}

      {/* ── 记录一次沟通（页内新建；2026-09-30 峰哥：不要开新 tab）──
          复用学生记录的 `columns` 与 `create` ⇒ 字段 / 联动 / 字典 与记录页**完全一致**；
          默认值把「记录类型 / 学生 / 沟通时间 / 责任人」都填好，改一项就能存。 */}
      {commOpen && cur ? (
        <>
          <div style={scrimStyle} onClick={() => setCommOpen(false)} />
          <div style={{ ...modalStyle, width: 760, maxHeight: '88vh' }}>
            <div style={modalBodyStyle}>
              <CrudPage
                key={`comm-${cur.studentId}`}
                moduleKey="studentRecords"
                title={t('commTitle')}
                columns={commColumns}
                api={commApi}
                formOnly={{
                  initial: {
                    [STUDENT_RECORD_TYPE_FIELD]: '日常跟进',
                    关联学生: cur.name,
                    沟通时间: nowMinuteText(),
                    ...(cur.owner ? { 责任人: cur.owner } : {}),
                  },
                  onSaved: () => {
                    setCommOpen(false);
                    void load();
                  },
                  onCancel: () => setCommOpen(false),
                }}
              />
            </div>
          </div>
        </>
      ) : null}

      {/* ── 移除卡片（v10）：必须填原因，可恢复 ── */}
      {rmTarget ? (
        <>
          <div style={scrimStyle} onClick={() => setRmTarget(null)} />
          <div style={{ ...modalStyle, width: 470 }}>
            <div style={dheadStyle}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 700 }}>
                  {t('removeCard')} · {rmTarget.name}
                </div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {t('removeHint')}
                </div>
              </div>
              <button style={dcloseStyle} onClick={() => setRmTarget(null)} type="button">
                ✕
              </button>
            </div>
            <div style={modalBodyStyle}>
              <div style={fieldStyle}>
                <label style={flabelStyle}>{t('removeReason')}</label>
                <input
                  className="form-input"
                  style={{ ...inputStyle, flex: 1 }}
                  placeholder={t('removeReasonHint')}
                  value={rmReason}
                  autoFocus
                  onChange={(e) => setRmReason(e.target.value)}
                />
              </div>
              {saveErr ? (
                <div style={{ color: 'var(--danger)', fontSize: 12, marginTop: 6 }}>{saveErr}</div>
              ) : null}
              <div style={{ display: 'flex', gap: 7, justifyContent: 'flex-end', marginTop: 12 }}>
                <button className="btn btn-ghost btn-sm" type="button" onClick={() => setRmTarget(null)}>
                  {t('cancel')}
                </button>
                <button
                  className="btn btn-primary btn-sm"
                  type="button"
                  disabled={rmBusy || !rmReason.trim()}
                  onClick={() => void doDismiss(rmTarget.studentId, rmReason, true)}
                >
                  {rmBusy ? t('saving') : t('removeCard')}
                </button>
              </div>
            </div>
          </div>
        </>
      ) : null}

      {/* ── 已移除的卡片：查看 + 恢复 ── */}
      {rmListOpen && data ? (
        <>
          <div style={scrimStyle} onClick={() => setRmListOpen(false)} />
          <div style={{ ...modalStyle, width: 580 }}>
            <div style={dheadStyle}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 700 }}>{t('dismissedTitle')}</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {t('dismissedSub')}
                </div>
              </div>
              <button style={dcloseStyle} onClick={() => setRmListOpen(false)} type="button">
                ✕
              </button>
            </div>
            <div style={modalBodyStyle}>
              {!data.dismissed.length ? <div style={emptyInlineStyle}>{t('dismissedEmpty')}</div> : null}
              {data.dismissed.map((d) => (
                <div key={d.studentId} style={stuRowStyle}>
                  <span style={{ fontWeight: 600 }}>{d.name}</span>
                  <span className="muted" style={{ fontSize: 11.5 }}>
                    {[d.grade, d.cls].filter(Boolean).join(' · ')}
                  </span>
                  <span className="muted" style={{ fontSize: 11.5 }}>
                    {d.reason}
                    {d.who ? ` · ${d.who}` : ''}
                    {d.ms ? ` · ${fmtDate(d.ms)}` : ''}
                  </span>
                  <button
                    className="btn btn-outline btn-sm"
                    style={{ marginLeft: 'auto', flexShrink: 0 }}
                    type="button"
                    disabled={rmBusy}
                    onClick={() => void doDismiss(d.studentId, '', false)}
                  >
                    {t('restore')}
                  </button>
                </div>
              ))}
              {saveErr ? (
                <div style={{ color: 'var(--danger)', fontSize: 12, marginTop: 8 }}>{saveErr}</div>
              ) : null}
            </div>
          </div>
        </>
      ) : null}

    </div>
  );
}

// ───────────────────────── 子组件 ─────────────────────────

/** 登记表单的字段值（抽屉与弹窗共用一份形状） */
type RegValues = {
  type: string;
  severity: string;
  text: string;
  owner: string;
  due: string;
  note: string;
};

/**
 * 登记表单字段 —— **抽屉与登记弹窗共用这一份定义**。
 *
 * 🔴 为什么不各写一份：字段一旦分开，改了一处忘另一处，就会出现"抽屉里选了类型、
 *    弹窗里存下去是空的"这类**只在某条路径上暴露且不报错**的问题。
 *    （本页其余判据同理：都从 contracts / 后端来，前端不重写。）
 */
function RegisterFields(props: {
  problemTypes: readonly string[];
  severities: readonly string[];
  ownerNames: readonly string[];
  values: RegValues;
  onChange: (patch: Partial<RegValues>) => void;
}) {
  const t = useTranslations('studentSupport');
  const v = props.values;
  return (
    <>
      <div style={fieldStyle}>
        <label style={flabelStyle}>{t('problemType')}</label>
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', flex: 1 }}>
          {props.problemTypes.map((p) => (
            <button
              key={p}
              type="button"
              className={v.type === p ? 'chip chip-active' : 'chip'}
              onClick={() => props.onChange({ type: v.type === p ? '' : p })}
            >
              {p}
            </button>
          ))}
        </div>
      </div>
      <div style={fieldStyle}>
        <label style={flabelStyle}>{t('severity')}</label>
        <div style={{ display: 'flex', gap: 5, flex: 1 }}>
          {props.severities.map((s) => (
            <button
              key={s}
              type="button"
              style={sevChipStyle(v.severity === s, s)}
              onClick={() => props.onChange({ severity: s })}
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
          value={v.text}
          onChange={(e) => props.onChange({ text: e.target.value })}
        />
      </div>
      <div style={fieldStyle}>
        <label style={flabelStyle}>{t('owner')}</label>
        <select
          className="form-input"
          style={{ ...inputStyle, flex: 1 }}
          value={v.owner}
          onChange={(e) => props.onChange({ owner: e.target.value })}
        >
          <option value="">—</option>
          {props.ownerNames.map((n) => (
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
          value={v.due}
          onChange={(e) => props.onChange({ due: e.target.value })}
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
          value={v.note}
          onChange={(e) => props.onChange({ note: e.target.value })}
        />
      </div>
    </>
  );
}

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
function SupportCard(props: {
  row: SupportBoardRow;
  /** 是否有「移除卡片」权限（v10）—— 前端只决定显不显示，后端会再判一次 */
  canRemove: boolean;
  onOpen: () => void;
  onClaim: () => void;
  onRemove: () => void;
}) {
  const t = useTranslations('studentSupport');
  const r = props.row;
  /** 还没认领 ⇒ 「认领并登记」；已经在跟进 ⇒ 「更新登记」（同一个按钮，少一次点击） */
  const claimLabel =
    !r.supportId || !r.supportStatus || r.supportStatus === '待认领'
      ? t('claimAndRegister')
      : t('updateRegister');
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

      {/* 无信号但有人认领（`claimed` 组）：说清"为什么他在这里还没有信号" */}
      {r.signals.length === 0 ? <div style={noSignalStyle}>{t('noSignalNow')}</div> : null}
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

      {/* 快捷登记：不用先点开抽屉（2026-09-30 峰哥要求） */}
      <div style={cardActStyle}>
        {/* 「移除卡片」是破坏性操作（能让别人看不到该看的人）⇒ 只在有权限时显示，且放最左边弱化 */}
        {props.canRemove ? (
          <button
            className="btn btn-ghost btn-sm"
            type="button"
            style={{ marginRight: 'auto', color: 'var(--fg-tertiary)' }}
            onClick={(e) => {
              e.stopPropagation();
              props.onRemove();
            }}
          >
            {t('removeCard')}
          </button>
        ) : null}
        <button
          className="btn btn-outline btn-sm"
          type="button"
          onClick={(e) => {
            // 🔴 必须阻止冒泡：整张卡片的 onClick 是打开抽屉，不拦会"点按钮 → 抽屉也弹出来"
            e.stopPropagation();
            props.onClaim();
          }}
        >
          {claimLabel}
        </button>
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
/** 卡片底部那条操作带（快捷登记按钮） */
const cardActStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 6,
  marginTop: 8,
  paddingTop: 8,
  borderTop: '1px solid var(--border)',
};
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
/** 「当前没有信号」的一句说明（`claimed` 组的卡片与抽屉里都用；别留空让人以为渲染坏了） */
const noSignalStyle: CSSProperties = {
  fontSize: 11.5,
  color: 'var(--fg-tertiary)',
  background: 'var(--bg-subtle)',
  border: '1px dashed var(--border)',
  borderRadius: 6,
  padding: '5px 8px',
  marginBottom: 6,
  lineHeight: 1.5,
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

// ── 登记弹窗 ──
const modalStyle: CSSProperties = {
  position: 'fixed',
  top: '8vh',
  left: '50%',
  transform: 'translateX(-50%)',
  width: 560,
  maxWidth: '94vw',
  maxHeight: '84vh',
  background: 'var(--surface)',
  borderRadius: 12,
  boxShadow: '0 12px 40px rgba(23,74,69,.28)',
  zIndex: 50,
  display: 'flex',
  flexDirection: 'column',
};
const modalBodyStyle: CSSProperties = { padding: '14px 18px 18px', overflowY: 'auto' };
/** 学生搜索结果的一行（button 需要显式清掉浏览器默认样式） */
const stuRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  textAlign: 'left',
  padding: '8px 10px',
  background: 'none',
  border: 'none',
  borderBottom: '1px solid var(--border)',
  cursor: 'pointer',
  fontSize: 12.5,
  color: 'inherit',
  font: 'inherit',
};
/** 「已在看板」小标（与之相对的是"当前无信号"的灰字） */
const boardPillStyle: CSSProperties = {
  fontSize: 10.5,
  color: 'var(--fg-tertiary)',
  background: 'var(--bg-subtle)',
  border: '1px solid var(--border)',
  borderRadius: 999,
  padding: '0 6px',
};
/** 弹窗里选定的那个学生 */
const pickBoxStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '9px 11px',
  marginBottom: 12,
  background: 'var(--bg-subtle)',
  border: '1px solid var(--border)',
  borderRadius: 8,
};

function levelColor(level: string): string {
  return level === 'P0'
    ? 'var(--danger)'
    : level === 'P1'
      ? '#B8860B'
      : level === 'claimed'
        ? '#8A8F98' // 中性灰：这一组不代表紧急，只代表"需要被看见"
        : 'var(--accent)';
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

/**
 * 「现在」的 `YYYY-MM-DD HH:mm` 文本（北京时间）—— 给新建学生记录表单预填「沟通时间」用。
 *
 * ⚠️ 学生记录表的日期字段（type=5）在 PG 里读出会**丢时分秒**，
 *    所以这里按存储值的形态直接给字符串（`YYYY-MM-DD HH:mm`），
 *    让 CrudPage 的 `toDateTimeLocal` 能原样吃下（见其注释）。
 */
function nowMinuteText(): string {
  const d = new Date(Date.now() + 8 * 3600000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
