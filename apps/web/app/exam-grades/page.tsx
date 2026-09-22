'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  api,
  type ExamGradeSettings,
  downloadClassReportCardsZip,
  downloadReportCardPdf,
  type ExamAnomalyRow,
  type ExamBatch,
  type ExamReportCard,
  type MarkbookClassOption,
  type TermGradeListItem,
  type TermGradePreview,
  type TermGradeRow,
} from '../../lib/api';
// 筛选下拉统一走全站组件（2026-09-22 第二批：本页原本是原生 select + 手写「全部科目」）
import { FilterSelect } from '../../components/FilterSelect';

/**
 * 考试与成绩（教学管理，2026-09-16 参照 RosarioSIS v13 的 Grades 模块设计）。
 *
 * 与「成绩册」的分工：
 *   成绩册  = 过程录入（一次考核一列，二维网格）
 *   本页    = 结果产出（结转 → 期末总评 → 各科评语 → 成绩单 → PDF）
 *
 * 四个 Tab：
 *   1. 期末总评 —— 结转（预览 → 落库）+ 确认锁定 + 手工调分
 *   2. 成绩单   —— 左学生列表 + 右白纸预览 + 导出 PDF（服务端 pdfkit 生成）
 *   3. 批量评语 —— 各科老师的主战场：一屏写完一个班 × 一科，**失焦即存**
 *   4. 异常审查 —— 5 条规则捞录错的分数（**只提示，绝不自动改分**）
 *
 * 三条铁律（页面上都有明示，别删）：
 *   ① 总评是**结转时的快照**，之后改成绩册不会自动跟着变 —— 要更新得重新结转
 *   ② 已确认的总评与评语**会被锁定**，要改先撤销确认
 *   ③ 已确认的记录**不会被结转覆盖**
 */
type Tab = 'term' | 'card' | 'comments' | 'anomaly' | 'settings';

/** 与后端一致的「未填科目」哨兵值 */
const SUBJECT_NONE = '__none__';

export default function ExamGradesPage() {
  const t = useTranslations('examGrades');

  const [tab, setTab] = useState<Tab>('term');
  const [batches, setBatches] = useState<ExamBatch[]>([]);
  const [batchId, setBatchId] = useState('');
  const [classes, setClasses] = useState<MarkbookClassOption[]>([]);
  const [cls, setCls] = useState('');
  const [subjects, setSubjects] = useState<{ value: string; label: string; columns: number }[]>([]);
  const [subject, setSubject] = useState('');
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // 期末总评
  const [preview, setPreview] = useState<TermGradePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  // 成绩单
  const [cardStudents, setCardStudents] = useState<TermGradeListItem[]>([]);
  const [cardStudentId, setCardStudentId] = useState('');
  const [card, setCard] = useState<ExamReportCard | null>(null);
  const [summaryDraft, setSummaryDraft] = useState('');

  // 批量评语
  const [commentRows, setCommentRows] = useState<TermGradeListItem[]>([]);
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [commentDraft, setCommentDraft] = useState<Record<string, string>>({});
  const [savingComment, setSavingComment] = useState('');

  // 成绩口径设置（Phase 2）
  const [settings, setSettings] = useState<ExamGradeSettings | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  // 常用评语库（Phase 2）：批量评语页一键套用
  const [commentLib, setCommentLib] = useState<{ id: string; text: string; subject: string; tag: string }[]>([]);

  // 异常审查
  const [anomalies, setAnomalies] = useState<ExamAnomalyRow[]>([]);
  const [thresholds, setThresholds] = useState({ highFactor: 1.5, lowFactor: 0.5, swingScore: 30 });

  // ── 载入基础选项 ────────────────────────────────────────────
  useEffect(() => {
    void (async () => {
      try {
        const [bs, cs] = await Promise.all([api.examListBatches(), api.markbookClasses()]);
        setBatches(bs);
        setBatchId((cur) => (cur && bs.some((b) => b.id === cur) ? cur : (bs[0]?.id ?? '')));
        setClasses(cs);
        setCls((cur) => (cur && cs.some((c) => c.cls === cur) ? cur : (cs[0]?.cls ?? '')));
      } catch {
        setBatches([]);
        setClasses([]);
      }
    })();
  }, []);

  /**
   * 科目候选 = **该班在「当前批次学年学期」里有列的科目**（2026-09-20）。
   *
   * 为什么要带批次的学年/学期：成绩册的列现在带学年/学期归属，而结转只取与批次同期的列。
   * 不筛的话下拉里会出现别的学年的科目 —— 选中它 ⇒ 结转挑不到列，
   * 界面只会说「该批次范围内没有可结转的考核列」，很难查。
   */
  useEffect(() => {
    if (!cls) {
      setSubjects([]);
      setSubject('');
      return;
    }
    const b = batches.find((x) => x.id === batchId);
    void api
      .examSubjects(cls, b?.year, b?.term)
      .then((s) => {
        setSubjects(s);
        setSubject((cur) => (cur && s.some((x) => x.value === cur) ? cur : ''));
      })
      .catch(() => setSubjects([]));
    // batches/batchId 变化时也要重取：批次换了 ⇒ 同期范围变了
  }, [cls, batchId, batches]);

  /**
   * 从 URL 初始化筛选（报表下钻进来时带上 `?tab=term&batchId=..&cls=..&subject=..`）。
   *
   * 时序是安全的：URL effect 先写入，随后「载入批次/班级」的 effect 只在
   * **当前值不在候选列表里**时才覆盖（见上面 `setBatchId((cur) => (cur && bs.some(...) ? cur : ...))`），
   * 所以从 URL 带进来的值会被保留，而科目也有同样的保护。
   */
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const q = new URLSearchParams(window.location.search);
    const t0 = q.get('tab');
    if (t0 && ['term', 'card', 'comments', 'anomaly', 'settings'].includes(t0)) setTab(t0 as Tab);
    const b = q.get('batchId');
    if (b) setBatchId(b);
    const c0 = q.get('cls');
    if (c0) setCls(c0);
    const s0 = q.get('subject');
    if (s0) setSubject(s0);
  }, []);

  const batch = useMemo(() => batches.find((b) => b.id === batchId) ?? null, [batches, batchId]);

  /** 载入期末总评（预览口径，不落库）—— 期末总评 Tab 用它展示现有记录 */
  const loadPreview = useCallback(async () => {
    if (!batchId || !cls) {
      setPreview(null);
      return;
    }
    setLoading(true);
    try {
      setPreview(await api.examPreview(batchId, cls, subject));
    } catch (e) {
      setPreview(null);
      setMsg({ tone: 'error', text: `${t('loadFailed')}：${(e as Error).message}` });
    } finally {
      setLoading(false);
    }
  }, [batchId, cls, subject, t]);

  useEffect(() => {
    if (tab === 'term') void loadPreview();
  }, [tab, loadPreview]);

  /** 载入已落库的总评（成绩单 / 评语页用） */
  const loadTermList = useCallback(
    async (onlyMissing: boolean) => {
      if (!batchId || !cls) {
        setCardStudents([]);
        setCommentRows([]);
        return;
      }
      try {
        const r = await api.examTermGradeList({ batchId, cls, subject, onlyMissingComment: onlyMissing });
        setCardStudents(r.rows);
        setCommentRows(r.rows);
        setCommentDraft({});
        setCardStudentId((cur) => (cur && r.rows.some((x) => x.studentId === cur) ? cur : (r.rows[0]?.studentId ?? '')));
      } catch {
        setCardStudents([]);
        setCommentRows([]);
      }
    },
    [batchId, cls, subject],
  );

  useEffect(() => {
    if (tab === 'card' || tab === 'comments') void loadTermList(tab === 'comments' ? onlyMissing : false);
  }, [tab, onlyMissing, loadTermList]);

  useEffect(() => {
    if (tab !== 'card' || !cardStudentId || !batchId) {
      setCard(null);
      return;
    }
    void api
      .examReportCard(cardStudentId, batchId)
      .then((c) => {
        setCard(c);
        setSummaryDraft(c?.summaryComment ?? '');
      })
      .catch(() => setCard(null));
  }, [tab, cardStudentId, batchId]);

  useEffect(() => {
    if (tab !== 'anomaly' || !batchId || !cls) return;
    void api
      .examAnomalies(batchId, cls)
      .then((r) => {
        setAnomalies(r.rows);
        setThresholds(r.thresholds);
      })
      .catch(() => setAnomalies([]));
  }, [tab, batchId, cls]);

  // ── 动作 ────────────────────────────────────────────────────

  const doRoll = async () => {
    if (!batchId || !cls) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.examRoll(batchId, cls, subject);
      setMsg({ tone: 'ok', text: t('rollDone', { saved: r.saved, skipped: r.skipped }) });
      setShowPreview(false);
      await loadPreview();
    } catch (e) {
      setMsg({ tone: 'error', text: `${t('rollFailed')}：${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  };

  const doConfirmAll = async () => {
    if (!batchId || !cls) return;
    setBusy(true);
    try {
      const r = await api.examConfirmAll(batchId, cls, subject);
      setMsg({ tone: 'ok', text: t('confirmAllDone', { n: r.confirmed }) });
      await loadPreview();
    } catch (e) {
      setMsg({ tone: 'error', text: `${t('opFailed')}：${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  };

  const doConfirm = async (row: TermGradeRow) => {
    if (!row.recordId) return;
    setBusy(true);
    try {
      await api.examConfirm(row.recordId);
      await loadPreview();
    } catch (e) {
      setMsg({ tone: 'error', text: `${t('opFailed')}：${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  };

  const doUndo = async (row: TermGradeRow) => {
    if (!row.recordId) return;
    if (!window.confirm(t('confirmUndo', { name: row.studentName }))) return;
    setBusy(true);
    try {
      await api.examUndo(row.recordId);
      await loadPreview();
    } catch (e) {
      setMsg({ tone: 'error', text: `${t('opFailed')}：${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  };

  const doAdjust = async (row: TermGradeRow) => {
    const input = window.prompt(t('adjustPrompt', { name: row.studentName, cur: row.total ?? '—' }), String(row.total ?? ''));
    if (input == null) return;
    const v = Number(input);
    if (!Number.isFinite(v)) {
      setMsg({ tone: 'error', text: t('adjustInvalid') });
      return;
    }
    const reason = window.prompt(t('adjustReason'), '') ?? '';
    setBusy(true);
    try {
      if (!row.recordId) {
        // 还没结转：先结转再调
        await api.examRoll(batchId, cls, subject);
        await loadPreview();
        setMsg({ tone: 'ok', text: t('adjustNeedRollFirst') });
        return;
      }
      await api.examAdjust(row.recordId, v, reason);
      await loadPreview();
    } catch (e) {
      setMsg({ tone: 'error', text: `${t('opFailed')}：${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  };

  const doRestore = async (row: TermGradeRow) => {
    if (!row.recordId) return;
    setBusy(true);
    try {
      await api.examRestore(row.recordId);
      await loadPreview();
    } catch (e) {
      setMsg({ tone: 'error', text: `${t('opFailed')}：${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  };

  /** 评语失焦即存 —— 33 个学生写完才保存，中途刷新全丢，老师一定会骂 */
  const saveComment = async (row: TermGradeListItem) => {
    const text = commentDraft[row.id];
    if (text === undefined) return;
    if (text === row.comment) return;
    setSavingComment(row.id);
    try {
      const r = await api.examSaveComments([{ id: row.id, comment: text }]);
      if (r.locked) {
        setMsg({ tone: 'error', text: t('commentLocked') });
      } else {
        setCommentRows((prev) =>
          prev.map((x) =>
            x.id === row.id ? { ...x, comment: text, commentStatus: text ? '已写' : '未写' } : x,
          ),
        );
        setMsg({ tone: 'ok', text: t('autoSaved') });
      }
    } catch (e) {
      setMsg({ tone: 'error', text: `${t('commentFailed')}：${(e as Error).message}` });
    } finally {
      setSavingComment('');
    }
  };

  /** 套用上一条评语（老师写的评语大量重复，一键复制再改几个字比从空白开始快得多） */
  // 口径设置：进 Tab 才拉（省一次请求）
  useEffect(() => {
    if (tab !== 'settings' || settings) return;
    api
      .examSettings()
      .then(setSettings)
      .catch(() => setMsg({ tone: 'error', text: t('loadFailed') }));
  }, [tab, settings, t]);

  // 常用评语库：进「批量评语」才拉；按科目过滤（空科目 = 通用）
  useEffect(() => {
    if (tab !== 'comments' || commentLib.length) return;
    api
      .examComments
      .list({ pageSize: '200' })
      .then((r) => {
        const items = (r as unknown as { items?: Record<string, unknown>[] }).items ?? [];
        setCommentLib(
          items.map((x) => ({
            id: String(x['id'] ?? ''),
            text: String(x['评语内容'] ?? ''),
            subject: String(x['科目'] ?? ''),
            tag: String(x['标签'] ?? ''),
          })),
        );
      })
      .catch(() => null);
  }, [tab, commentLib.length]);

  const saveSettings = async () => {
    if (!settings) return;
    setSavingSettings(true);
    try {
      const next = await api.saveExamSettings(settings);
      setSettings(next);
      setMsg({ tone: 'ok', text: t('settingsSaved') });
    } catch (e) {
      setMsg({ tone: 'error', text: `${t('settingsFailed')}：${(e as Error).message}` });
    } finally {
      setSavingSettings(false);
    }
  };

  /** 整班导出：把一个班的成绩单打成 zip（服务端零依赖打包） */
  const exportZip = async (cls: string, batchId: string, batchName: string) => {
    setBusy(true);
    try {
      await downloadClassReportCardsZip(batchId, cls, subject, `成绩单_${cls}_${batchName}`);
    } catch (e) {
      setMsg({ tone: 'error', text: `${t('zipFailed')}：${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  };

  const copyPrevComment = (idx: number) => {
    if (idx <= 0) return;
    const prev = commentRows[idx - 1];
    const cur = commentRows[idx];
    if (!prev || !cur) return;
    const text = commentDraft[prev.id] ?? prev.comment;
    setCommentDraft((d) => ({ ...d, [cur.id]: text }));
  };

  const saveSummary = async () => {
    if (!card) return;
    setBusy(true);
    try {
      await api.examSaveSummary({
        batchId: card.batchId,
        studentId: card.studentId,
        comment: summaryDraft,
        studentName: card.studentName,
        cls: card.cls,
      });
      setMsg({ tone: 'ok', text: t('autoSaved') });
      setCard({ ...card, summaryComment: summaryDraft, summaryStatus: summaryDraft ? '已写' : '未写' });
    } catch (e) {
      setMsg({ tone: 'error', text: `${t('commentFailed')}：${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  };

  const exportPdf = async () => {
    if (!card) return;
    setBusy(true);
    try {
      await downloadReportCardPdf(card.studentId, card.batchId, card.studentName);
    } catch (e) {
      setMsg({ tone: 'error', text: `${t('pdfFailed')}：${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  };

  // ── 渲染 ────────────────────────────────────────────────────

  const writeCount = commentRows.filter((r) => (commentDraft[r.id] ?? r.comment).trim()).length;
  const totalCount = commentRows.length;

  const levelClass = (lv: string, total: number | null): string => {
    if (!lv) return 'dept-status';
    if (total != null && total < 60) return 'dept-status dept-status-resigned';
    if (total != null && total < 70) return 'dept-status dept-status-inactive';
    return 'dept-status dept-status-ok';
  };

  const actionClass = (a: string): string => {
    if (a === '新建') return 'dept-status dept-status-ok';
    if (a === '更新') return 'dept-status dept-status-inactive';
    if (a === '跳过（已确认）') return 'dept-status dept-status-resigned';
    return 'dept-status';
  };

  return (
    <div className="page">
      <div className="page-content">
        <div className="page-header page-header-row">
          <div>
            <div className="page-eyebrow">{t('eyebrow')}</div>
            <h1 className="page-title">{t('title')}</h1>
            <p className="page-subtitle">{t('subtitle')}</p>
          </div>
          <div className="page-header-actions">
            <a className="btn btn-outline" href="/markbook">
              {t('goMarkbook')}
            </a>
          </div>
        </div>

        {msg && <div className={msg.tone === 'ok' ? 'notice notice-ok' : 'notice notice-error'}>{msg.text}</div>}

        {/* Tab 切换 */}
        <div className="mb-toolbar" style={{ marginBottom: 12 }}>
          {(
            [
              ['term', t('tabTerm')],
              ['card', t('tabCard')],
              ['comments', t('tabComments')],
              ['anomaly', t('tabAnomaly')],
              ['settings', t('tabSettings')],
            ] as [Tab, string][]
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              className={tab === k ? 'btn btn-primary' : 'btn btn-outline'}
              onClick={() => setTab(k)}
            >
              {label}
            </button>
          ))}
        </div>

        {/* 公共筛选条 */}
        <div className="mb-toolbar">
          {/* 批次 / 班级是**必选参数**（值恒非空，下面整页按它取数）⇒ `clearable={false}`；
              科目可选，所以保留「全部」。
              原先「暂无批次 / 暂无班级」是下拉里的一个 option —— 换掉后会丢，所以空列表时
              改成旁边一行文字提示，保住「为什么这里是空的」这条信息。 */}
          {batches.length === 0 ? (
            <span className="muted" style={{ fontSize: 'var(--font-xs)' }}>{t('noBatch')}</span>
          ) : (
            <FilterSelect
              label={t('fBatch')}
              value={batchId}
              onChange={setBatchId}
              options={batches.map((b) => b.id)}
              optionLabels={Object.fromEntries(batches.map((b) => [b.id, `${b.name}（${b.status}）`]))}
              clearable={false}
            />
          )}
          {classes.length === 0 ? (
            <span className="muted" style={{ fontSize: 'var(--font-xs)' }}>{t('noClass')}</span>
          ) : (
            <FilterSelect
              label={t('fClass')}
              value={cls}
              onChange={setCls}
              options={classes.map((c) => c.cls)}
              optionLabels={Object.fromEntries(
                classes.map((c) => [c.cls, t('classOption', { cls: c.cls, n: c.students })]),
              )}
              clearable={false}
            />
          )}
          <FilterSelect
            label={t('fSubject')}
            value={subject}
            onChange={setSubject}
            options={subjects.map((s) => s.value)}
            optionLabels={Object.fromEntries(subjects.map((s) => [s.value, `${s.label}（${s.columns}）`]))}
          />
          {batch && (
            <span className="mb-meta">
              {batch.year} · {batch.term}
              {batch.from || batch.to ? ` · ${batch.from || '—'} ~ ${batch.to || '—'}` : ''}
            </span>
          )}
        </div>

        {/* ── Tab 1：期末总评 ─────────────────────────────── */}
        {tab === 'term' && (
          <>
            <div className="mb-toolbar">
              <span className="mb-meta">
                {preview?.reason
                  ? preview.reason
                  : t('termMeta', {
                      rows: preview?.rows.length ?? 0,
                      cols: preview?.columns.length ?? 0,
                    })}
              </span>
              <button className="btn btn-outline" disabled={!batchId || !cls || loading} onClick={() => setShowPreview(true)}>
                {t('previewRoll')}
              </button>
              <button className="btn btn-outline" disabled={!batchId || !cls || busy} onClick={() => void doConfirmAll()}>
                {t('confirmAll')}
              </button>
              <button className="btn btn-primary" disabled={!batchId || !cls || busy} onClick={() => void doRoll()}>
                {busy ? t('working') : t('roll')}
              </button>
            </div>

            <div className="notice notice-info" style={{ marginBottom: 12 }}>
              {t('snapshotNotice')}
            </div>

            {loading ? (
              <div className="dept-loading">{t('loading')}</div>
            ) : !preview || preview.rows.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-icon">📊</div>
                <div className="empty-state-text">{preview?.reason ?? t('noTermGrades')}</div>
              </div>
            ) : (
              <div className="card">
                <div className="dept-card-head">
                  <span className="dept-card-title">
                    {preview.batchName} · {cls} · {subject ? subjects.find((s) => s.value === subject)?.label : t('subjectAll')}
                  </span>
                  <span className="dept-card-meta">
                    {t('gpaNote')}
                    {preview.gpaConfigured ? '' : ` · ${t('gpaNotConfigured')}`}
                  </span>
                </div>
                <div className="data-table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>{t('colStudent')}</th>
                        <th>{t('colSubject')}</th>
                        <th>{t('colTotal')}</th>
                        <th>{t('colLevel')}</th>
                        <th>{t('colItems')}</th>
                        <th>{t('colRank')}</th>
                        <th>{t('colStatus')}</th>
                        <th>{t('colOps')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows.map((r) => (
                        <tr key={`${r.studentId}-${r.subject}`}>
                          <td>
                            <div className="dept-emp-name">{r.studentName}</div>
                          </td>
                          <td>{r.subject === SUBJECT_NONE ? <span className="muted">{t('subjectNone')}</span> : r.subject}</td>
                          <td>
                            <strong>{r.total == null ? '—' : r.total}</strong>
                            {r.oldTotal != null && r.total != null && Math.abs(r.oldTotal - r.total) > 0.001 ? (
                              <div className="dept-emp-sub">
                                {t('wasTotal', { v: r.oldTotal })}
                              </div>
                            ) : null}
                          </td>
                          <td>
                            {r.level ? <span className={levelClass(r.level, r.total)}>{r.level}</span> : '—'}
                          </td>
                          <td>
                            <span className="muted" title={t('itemsHint')}>
                              {t('itemsValue', { n: r.count, w: r.weightSum })}
                            </span>
                            {r.excusedCount > 0 && (
                              <span className="dept-status dept-status-inactive" style={{ marginLeft: 6 }}>
                                {t('hasExcused', { n: r.excusedCount })}
                              </span>
                            )}
                            {r.absentCount > 0 && (
                              <span className="dept-status dept-status-resigned" style={{ marginLeft: 6 }}>
                                {t('hasAbsent', { n: r.absentCount })}
                              </span>
                            )}
                          </td>
                          <td>{r.rank == null ? '—' : `${r.rank} / ${r.rankTotal}`}</td>
                          <td>
                            <span className={actionClass(r.action)}>{r.action}</span>
                            {r.source === '手工调整' && (
                              <span className="dept-status dept-status-inactive" style={{ marginLeft: 6 }}>
                                {t('manual')}
                              </span>
                            )}
                          </td>
                          <td>
                            {r.recordId ? (
                              r.status === '已确认' ? (
                                <button type="button" className="link-btn" onClick={() => void doUndo(r)}>
                                  {t('undo')}
                                </button>
                              ) : (
                                <button type="button" className="link-btn" onClick={() => void doConfirm(r)}>
                                  {t('confirm')}
                                </button>
                              )
                            ) : (
                              <span className="muted">{t('notRolled')}</span>
                            )}
                            <button type="button" className="link-btn" onClick={() => void doAdjust(r)}>
                              {t('adjust')}
                            </button>
                            {r.source === '手工调整' && (
                              <button type="button" className="link-btn" onClick={() => void doRestore(r)}>
                                {t('restore')}
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="mb-foot">
                  {t('columnsUsed', { list: preview.columns.map((c) => `${c.name}(${c.weight})`).join('、') || '—' })}
                </div>
              </div>
            )}
          </>
        )}

        {/* ── Tab 2：成绩单 ───────────────────────────────── */}
        {tab === 'card' && (
          <div className="split-layout">
            <div className="split-side">
              <div className="card dept-tree-card">
                <div className="dept-card-head">
                  <span className="dept-card-title">{t('studentsWithTerm')}</span>
                  <span className="dept-card-meta">{cardStudents.length}</span>
                </div>
                <div style={{ maxHeight: 520, overflow: 'auto' }}>
                  {cardStudents.length === 0 && <div className="dept-loading">{t('noTermGradesShort')}</div>}
                  {cardStudents.map((s) => (
                    <div key={s.id} className={`dept-row${s.studentId === cardStudentId ? ' dept-row-active' : ''}`}>
                      <button type="button" className="dept-name" onClick={() => setCardStudentId(s.studentId)}>
                        <span className="dept-name-text">{s.studentName}</span>
                      </button>
                      <span className="dept-count">{s.rank == null ? '—' : `#${s.rank}`}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="split-main">
              {!card ? (
                <div className="empty-state">
                  <div className="empty-state-icon">📄</div>
                  <div className="empty-state-text">{t('noReportCard')}</div>
                </div>
              ) : (
                <>
                  <div className="mb-toolbar">
                    <span className="mb-meta">
                      {card.studentName} · {card.cls} · {card.batchName}
                      {card.batchStatus !== '已发布' ? ` · ${t('batchDraft')}` : ''}
                    </span>
                    <button className="btn btn-outline" onClick={() => window.print()}>
                      {t('print')}
                    </button>
                    <button className="btn btn-primary" disabled={busy} onClick={() => void exportPdf()}>
                      {t('exportPdf')}
                    </button>
                    {/* 整班打包：一个班 30 份 PDF 逐个点太慢，一次拿走 */}
                    <button
                      className="btn btn-outline"
                      disabled={busy || !card.cls}
                      onClick={() => void exportZip(card.cls, card.batchId, card.batchName)}
                    >
                      {t('exportZip')}
                    </button>
                  </div>

                  <div className="exam-paper-wrap">
                    <div className="exam-paper">
                      <div className="exam-paper-head">
                        <div>
                          <div className="exam-paper-school">致极学院 · Arete College</div>
                          <div className="exam-paper-sub">ARETE AI LAB · STUDENT INFORMATION SYSTEM</div>
                        </div>
                        <div>
                          <h3>{t('reportCardTitle')}</h3>
                          <div className="exam-paper-en">REPORT CARD</div>
                        </div>
                      </div>
                      <div className="exam-paper-kv">
                        <div>
                          <b>{t('kStudent')}</b>
                          {card.studentName}
                        </div>
                        <div>
                          <b>{t('kNo')}</b>
                          {card.studentNo || '—'}
                        </div>
                        <div>
                          <b>{t('kClass')}</b>
                          {card.cls || '—'}
                        </div>
                        <div>
                          <b>{t('kBatch')}</b>
                          {card.batchName}
                        </div>
                        <div>
                          <b>{t('kYearTerm')}</b>
                          {[card.year, card.term].filter(Boolean).join(' · ') || '—'}
                        </div>
                        <div>
                          <b>{t('kStatus')}</b>
                          {card.batchStatus === '已发布' ? t('published') : t('draftNotPublished')}
                        </div>
                      </div>

                      <div className="exam-paper-sec">{t('subjectSection')}</div>
                      <table className="exam-paper-table">
                        <thead>
                          <tr>
                            <th style={{ width: '18%' }}>{t('colSubject')}</th>
                            <th style={{ width: '12%' }}>{t('colTotal')}</th>
                            <th style={{ width: '10%' }}>{t('colLevel')}</th>
                            <th style={{ width: '14%' }}>{t('colRank')}</th>
                            <th>{t('colTeacherComment')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {card.subjects.map((s) => (
                            <tr key={s.subject}>
                              <td>{s.subject}</td>
                              <td>
                                <b>{s.total == null ? '—' : s.total}</b>
                              </td>
                              <td className="exam-paper-level">{s.level || '—'}</td>
                              <td>{s.rank == null ? '—' : `${s.rank} / ${s.rankTotal || '—'}`}</td>
                              <td className="exam-paper-comment">
                                {s.comment || <span className="muted">{t('noCommentYet')}</span>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>

                      <div className="exam-paper-sec">{t('summarySection')}</div>
                      <div className="exam-paper-sum">
                        {card.gpa.weighted != null && (
                          <div>
                            <span>{t('gpaWeighted')}</span>
                            <b>{card.gpa.weighted}</b>
                          </div>
                        )}
                        {card.gpa.unweighted != null && (
                          <div>
                            <span>{t('gpaUnweighted')}</span>
                            <b>{card.gpa.unweighted}</b>
                          </div>
                        )}
                        <div>
                          <span>{t('colRank')}</span>
                          <b>{card.rank == null ? '—' : `${card.rank} / ${card.rankTotal || '—'}`}</b>
                        </div>
                        <div>
                          <span>{t('attainedSubjects')}</span>
                          <b>
                            {card.attainedCount} / {card.subjects.length}
                          </b>
                        </div>
                      </div>
                      {card.gpa.weighted == null && (
                        <div className="dept-card-meta" style={{ marginTop: 6 }}>
                          {t('gpaNotConfiguredHint')}
                        </div>
                      )}

                      <div className="exam-paper-sec">{t('summaryCommentSection')}</div>
                      <textarea
                        className="form-input"
                        style={{ width: '100%', minHeight: 74 }}
                        rows={3}
                        value={summaryDraft}
                        placeholder={t('summaryCommentPlaceholder')}
                        onChange={(e) => setSummaryDraft(e.target.value)}
                        onBlur={() => void saveSummary()}
                      />
                      <div className="dept-card-meta" style={{ marginTop: 4 }}>
                        {t('summaryCommentHint')}
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* ── Tab 3：批量评语 ─────────────────────────────── */}
        {tab === 'comments' && (
          <>
            <div className="mb-toolbar">
              <span className="mb-meta">
                {t('commentProgress', { done: writeCount, total: totalCount })}
              </span>
              <label className="mb-field" style={{ marginLeft: 'auto' }}>
                <span>{t('onlyMissing')}</span>
                <input type="checkbox" checked={onlyMissing} onChange={(e) => setOnlyMissing(e.target.checked)} />
              </label>
            </div>
            <div className="notice notice-info" style={{ marginBottom: 12 }}>
              {t('commentNotice')}
            </div>

            {commentRows.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-icon">✍️</div>
                <div className="empty-state-text">{t('noTermGradesForComment')}</div>
              </div>
            ) : (
              <div className="card">
                <div className="dept-card-head">
                  <span className="dept-card-title">
                    {cls} · {subject ? subjects.find((s) => s.value === subject)?.label : t('subjectAll')} · {t('teacherComment')}
                  </span>
                  <span className="dept-card-meta">{t('commentAutoSaveHint')}</span>
                </div>
                <div className="data-table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th style={{ minWidth: 110 }}>{t('colStudent')}</th>
                        <th style={{ minWidth: 62 }}>{t('colTotal')}</th>
                        <th style={{ minWidth: 62 }}>{t('colLevel')}</th>
                        <th style={{ minWidth: 360 }}>{t('colTeacherComment')}</th>
                        <th style={{ minWidth: 80 }}>{t('colChars')}</th>
                        <th style={{ minWidth: 86 }}>{t('colStatus')}</th>
                        <th style={{ minWidth: 96 }}>{t('colOps')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {commentRows.map((r, idx) => {
                        const v = commentDraft[r.id] ?? r.comment;
                        return (
                          <tr key={r.id}>
                            <td>
                              <div className="dept-emp-name">{r.studentName}</div>
                            </td>
                            <td>{r.total == null ? '—' : r.total}</td>
                            <td>{r.level ? <span className={levelClass(r.level, r.total)}>{r.level}</span> : '—'}</td>
                            <td>
                              {commentLib.length > 0 && (
                                <select
                                  className="form-input"
                                  style={{ width: '100%', marginBottom: 4, fontSize: 'var(--font-xs)' }}
                                  value=""
                                  onChange={(e) => {
                                    const hit = commentLib.find((x) => x.id === e.target.value);
                                    if (!hit) return;
                                    setCommentDraft((d) => {
                                      const cur = d[r.id] ?? '';
                                      // 追加而不是覆盖：老师常把两句拼起来
                                      const next = cur ? `${cur} ${hit.text}` : hit.text;
                                      return { ...d, [r.id]: next.slice(0, 200) };
                                    });
                                  }}
                                >
                                  <option value="">{t('applyFromLibrary')}</option>
                                  {commentLib
                                    .filter((x) => !x.subject || x.subject === subject)
                                    .map((x) => (
                                      <option key={x.id} value={x.id}>
                                        {x.tag ? `[${x.tag}] ` : ''}
                                        {x.text.slice(0, 34)}
                                      </option>
                                    ))}
                                </select>
                              )}
                              <textarea
                                className="form-input"
                                style={{ width: '100%', minHeight: 40 }}
                                rows={2}
                                maxLength={200}
                                value={v}
                                placeholder={t('commentPlaceholder')}
                                onChange={(e) => setCommentDraft((d) => ({ ...d, [r.id]: e.target.value }))}
                                onBlur={() => void saveComment(r)}
                              />
                              {r.excusedCount > 0 && (
                                <div className="dept-emp-sub">{t('excusedHint', { n: r.excusedCount })}</div>
                              )}
                              {r.absentCount > 0 && (
                                <div className="dept-emp-sub">{t('absentHint', { n: r.absentCount })}</div>
                              )}
                            </td>
                            <td className="muted">
                              {v.length} / 200{savingComment === r.id ? ` · ${t('saving')}` : ''}
                            </td>
                            <td>
                              <span className={r.commentStatus === '已定稿' ? 'dept-status dept-status-ok' : r.commentStatus === '已写' ? 'dept-status dept-status-inactive' : 'dept-status'}>
                                {r.commentStatus}
                              </span>
                            </td>
                            <td>
                              <button type="button" className="link-btn" onClick={() => copyPrevComment(idx)}>
                                {t('copyPrev')}
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="mb-foot">{t('commentLockedHint')}</div>
              </div>
            )}
          </>
        )}

        {/* ── Tab 4：异常审查 ─────────────────────────────── */}
        {tab === 'anomaly' && (
          <>
            <div className="notice notice-info" style={{ marginBottom: 12 }}>
              {t('anomalyThresholds', {
                high: thresholds.highFactor,
                low: thresholds.lowFactor,
                swing: thresholds.swingScore,
              })}
              ：{t('anomalyNoAutoFix')}
            </div>

            {anomalies.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-icon">✅</div>
                <div className="empty-state-text">{t('anomalyClean')}</div>
              </div>
            ) : (
              <div className="card">
                <div className="dept-card-head">
                  <span className="dept-card-title">{t('anomalyTitle', { n: anomalies.length })}</span>
                  <span className="dept-card-meta">{t('anomalySortHint')}</span>
                </div>
                <div className="data-table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>{t('colColumn')}</th>
                        <th>{t('colStudent')}</th>
                        <th>{t('colScoreFull')}</th>
                        <th>{t('colClassAvg')}</th>
                        <th>{t('colDeviation')}</th>
                        <th>{t('colRule')}</th>
                        <th>{t('colOps')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {anomalies.map((a, i) => (
                        <tr key={`${a.entryId}-${a.rule}-${i}`}>
                          <td>
                            <div className="dept-emp-name">{a.columnName}</div>
                            <div className="dept-emp-sub">{a.columnType}</div>
                          </td>
                          <td>{a.studentName}</td>
                          <td>
                            <strong>{a.score ?? '—'}</strong> <span className="muted">/ {a.fullMark}</span>
                          </td>
                          <td className="muted">{a.classAvg ?? '—'}</td>
                          <td className={a.deviation == null ? 'muted' : a.deviation > 0 ? 'exam-dev-up' : 'exam-dev-down'}>
                            {a.deviation == null ? '—' : (a.deviation > 0 ? '+' : '') + a.deviation}
                          </td>
                          <td>
                            <span className={a.rule.startsWith('R1') ? 'dept-status dept-status-resigned' : a.rule.startsWith('R2') ? 'dept-status dept-status-inactive' : 'dept-status'}>
                              {a.rule}
                            </span>
                            <div className="dept-emp-sub">{a.message}</div>
                          </td>
                          <td>
                            <a className="link-btn" href="/markbook">
                              {t('goFix')}
                            </a>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="mb-foot">{t('anomalyFooter')}</div>
              </div>
            )}
          </>
        )}
      </div>

      {/* 结转预览弹窗 */}
      {showPreview && preview && (
        <div className="modal-overlay" role="presentation" onClick={() => setShowPreview(false)}>
          <div className="exam-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="exam-modal-head">
              <div>
                <h3>{t('previewTitle', { cls })}</h3>
                <p className="dept-card-meta">
                  {preview.batchName} · {batch?.from || '—'} ~ {batch?.to || '—'}
                </p>
              </div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowPreview(false)}>
                ×
              </button>
            </div>
            <div className="exam-modal-body">
              <div className="mb-toolbar" style={{ marginBottom: 10 }}>
                <span className="mb-meta">
                  {t('previewSummary', {
                    create: preview.summary.create,
                    update: preview.summary.update,
                    unchanged: preview.summary.unchanged,
                    skipped: preview.summary.skipped,
                  })}
                </span>
              </div>
              <div className="data-table-wrap" style={{ maxHeight: 420 }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>{t('colStudent')}</th>
                      <th>{t('colSubject')}</th>
                      <th>{t('colOldTotal')}</th>
                      <th>{t('colNewTotal')}</th>
                      <th>{t('colChange')}</th>
                      <th>{t('colWhy')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((r) => (
                      <tr key={`p-${r.studentId}-${r.subject}`}>
                        <td>{r.studentName}</td>
                        <td>{r.subject === SUBJECT_NONE ? t('subjectNone') : r.subject}</td>
                        <td className="muted">{r.oldTotal ?? '—'}</td>
                        <td>
                          <strong>{r.total ?? '—'}</strong>
                        </td>
                        <td>
                          {r.action === '新建' ? (
                            <span className="dept-status dept-status-ok">{t('actCreate')}</span>
                          ) : r.action === '更新' && r.oldTotal != null && r.total != null ? (
                            <span className={r.total >= r.oldTotal ? 'dept-status dept-status-ok' : 'dept-status dept-status-resigned'}>
                              {r.total >= r.oldTotal ? '↑' : '↓'} {Math.abs(Math.round((r.total - r.oldTotal) * 100) / 100)}
                            </span>
                          ) : r.action === '跳过（已确认）' ? (
                            <span className="dept-status dept-status-inactive">{r.action}</span>
                          ) : (
                            <span className="dept-status">{r.action}</span>
                          )}
                        </td>
                        <td className="muted">
                          {t('itemsValue', { n: r.count, w: r.weightSum })}
                          {r.excusedCount ? ` · ${t('hasExcused', { n: r.excusedCount })}` : ''}
                          {r.absentCount ? ` · ${t('hasAbsent', { n: r.absentCount })}` : ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="exam-modal-foot">
              <button type="button" className="btn btn-ghost" onClick={() => setShowPreview(false)}>
                {t('cancel')}
              </button>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void doRoll()}>
                {t('confirmRoll', { n: preview.summary.create + preview.summary.update })}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── 成绩口径设置（Phase 2）──────────────────────────────
          定位：**批次上的同名字段优先，这里只是缺省值**。
          批次留空即继承这里配的值 —— 所以历史批次不用改数据，
          新建批次也能天然带上一套统一口径。 */}
      {tab === 'settings' && (
        <div className="card" style={{ padding: 20 }}>
          <div className="dept-card-head" style={{ marginBottom: 12 }}>
            <span className="dept-card-title">{t('settingsTitle')}</span>
            <span className="dept-card-meta">{t('settingsMeta')}</span>
          </div>
          {!settings ? (
            <div className="dept-loading">{t('loading')}</div>
          ) : (
            <>
              <div className="notice notice-info" style={{ marginBottom: 14 }}>{t('settingsNotice')}</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 16 }}>
                {(
                  [
                    ['roundMode', t('setRound'), ['四舍五入', '保留1位小数', '向上取整', '向下取整', '不处理']],
                    ['excusedMode', t('setExcused'), ['不计入分母', '计0分']],
                    ['absentMode', t('setAbsent'), ['计0分', '不计入分母']],
                  ] as [keyof ExamGradeSettings, string, string[]][]
                ).map(([key, label, opts]) => (
                  <label key={String(key)} style={{ display: 'block' }}>
                    <span style={{ display: 'block', marginBottom: 4, fontSize: 'var(--font-sm)' }}>{label}</span>
                    <select
                      className="form-input"
                      style={{ width: '100%' }}
                      value={String(settings[key] ?? '')}
                      onChange={(e) => setSettings({ ...settings, [key]: e.target.value } as ExamGradeSettings)}
                    >
                      {opts.map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
                {(
                  [
                    ['gpaDecimals', t('setGpaDecimals'), 0, 3],
                    ['highFactor', t('setHigh'), 1.1, 3],
                    ['lowFactor', t('setLow'), 0.1, 1],
                    ['swingScore', t('setSwing'), 5, 60],
                  ] as [keyof ExamGradeSettings, string, number, number][]
                ).map(([key, label, min, max]) => (
                  <label key={String(key)} style={{ display: 'block' }}>
                    <span style={{ display: 'block', marginBottom: 4, fontSize: 'var(--font-sm)' }}>{label}</span>
                    <input
                      className="form-input"
                      style={{ width: '100%' }}
                      type="number"
                      min={min}
                      max={max}
                      step={key === 'gpaDecimals' ? 1 : 0.1}
                      value={String(settings[key] ?? '')}
                      onChange={(e) =>
                        setSettings({ ...settings, [key]: Number(e.target.value) } as ExamGradeSettings)
                      }
                    />
                  </label>
                ))}
              </div>
              <div style={{ marginTop: 18, display: 'flex', alignItems: 'center', gap: 12 }}>
                <button className="btn btn-primary" disabled={savingSettings} onClick={() => void saveSettings()}>
                  {savingSettings ? t('working') : t('settingsSave')}
                </button>
                <span className="muted" style={{ fontSize: 'var(--font-xs)' }}>{t('settingsHint')}</span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
