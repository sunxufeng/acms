'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  api,
  type MarkbookCell,
  type MarkbookClassOption,
  type MarkbookColumn,
  type MarkbookGrid,
  type MarkbookSaveRow,
} from '../../lib/api';
import HomeworkSyncPanel from '../../components/markbook/HomeworkSyncPanel';
import ColumnEditor from '../../components/markbook/ColumnEditor';
import Modal from '../../components/markbook/Modal';
import { defaultTermOf } from '@acms/contracts';
import {
  MARKBOOK_VIEWS,
  MarkbookView,
  SUBJECT_NONE,
  useTypeFilters,
  type MarkbookViewKey,
} from '../../components/markbook/views';

/**
 * 成绩册（Markbook）—— 参照 GibbonEdu/core v31 移植，2026-09-13。
 *
 * 这一页是**二维录入网格**：行为学生、列为考核项，右侧给加权总评与达标判定。
 * 为什么不用 CrudPage：CrudPage 是「一行一条记录」的列表范式，
 * 而成绩册的核心交互是「一格一个值、整班一次提交」，网格才是对的形态。
 * 但列表页/表单页的风格仍照全站规范（.page-content / .card / .data-table / .btn）。
 *
 * 口径（与后端 markbook.logic.ts 同源，改口径要两边一起改）：
 *  - 两层权重：列权重 × 该班该「考核类型」的类型权重，缺省都按 1
 *  - 总评 = Σ(百分制得分 × 有效权重) ÷ Σ(有效权重)，**分母只算已录入的项**（自归一化）
 *  - 达标看**等级序号**：序号越小越好（1 最好），达标 = 实际序号 ≤ 目标序号
 */
export default function MarkbookPage() {
  const t = useTranslations('markbook');

  const [classes, setClasses] = useState<MarkbookClassOption[]>([]);
  const [cls, setCls] = useState('');
  const [grid, setGrid] = useState<MarkbookGrid | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  /** 未保存的改动：key = `${columnId}__${studentId}` → 输入框里的原始文本 */
  const [dirty, setDirty] = useState<Map<string, string>>(new Map());
  /**
   * 视图（四种排版，渲染同一份数据）：横排 / 竖排 / 学科分列 / 学科分行。
   *
   * 选择记在 localStorage：老师习惯用哪个视图，下次进来还是它 —— 而不是每次都回默认。
   * 读取放在 lazy initializer 里（`typeof window` 判断是为了 SSR 首帧不炸）。
   */
  const [view, setView] = useState<MarkbookViewKey>('flat');
  useEffect(() => {
    const saved = typeof window !== 'undefined' ? window.localStorage.getItem('acms.markbookView') : null;
    if (saved && (MARKBOOK_VIEWS as string[]).includes(saved)) setView(saved as MarkbookViewKey);
  }, []);
  const pickView = (v: MarkbookViewKey) => {
    setView(v);
    try {
      window.localStorage.setItem('acms.markbookView', v);
    } catch {
      /* 隐私模式下 localStorage 可能不可写：忽略，仅本次生效 */
    }
  };
  /**
   * 学年 / 学期（页面顶部筛选，读字典「学年」「教学学期」）。
   *
   * 🔴 它们决定**显示哪些考核列**：成绩册的每一列都带学年/学期归属。
   * 默认值按「今天」推断（见 `defaultTermOf`：8 月起算新学年、2–7 月是第二学期），
   * 免得老师每次打开都要自己挑一次。
   * ⚠️ 未归属的历史列在任何筛选下都会出现（后端 `columnInTerm` 的兜底），界面会标出来。
   */
  const [year, setYear] = useState(() => defaultTermOf(new Date()).year);
  const [term, setTerm] = useState(() => defaultTermOf(new Date()).term);
  /** 学年候选（字典「学年」） */
  const [yearOptions, setYearOptions] = useState<string[]>([]);
  /** 学期候选（字典「教学学期」） */
  const [termOptions, setTermOptions] = useState<string[]>([]);

  /** 学科筛选：'' = 全部；SUBJECT_NONE = 未指定学科 */
  const [subjectFilter, setSubjectFilter] = useState('');
  /** 考核类型筛选：'' = 全部 */
  const [typeFilter, setTypeFilter] = useState('');

  /** 列编辑：null=关闭，{col:null}=新建 */
  const [editing, setEditing] = useState<{ col: MarkbookColumn | null } | null>(null);
  /** 「作业转成绩册」弹出框是否打开（2026-09-20：从网格下方的内联面板提到顶部按钮） */
  const [hwOpen, setHwOpen] = useState(false);

  /**
   * 「考核类型」候选（列编辑用）。
   *
   * 🔴 候选来自**「考核类型」表**，不是「成绩类型权重」表 —— 后者是**按班级配的**，
   * 某个班没配过权重就会得到空下拉，老师反而建不了列。权重表管的是「每类占多少分」，
   * 「有哪些类」由「考核类型」页管。两处的候选因此是同一份名单，不会出现
   * 「成绩册里能选、权重页里没有」。
   *
   * 传当前班级给端点，返回的 label 里会带上**本班权重**（「期末考试（本班权重 55）」），
   * 建列时一眼能看出这一列会按多少权重算。
   */
  const [typeOptions, setTypeOptions] = useState<{ value: string; label: string }[]>([]);

  /**
   * 「科目」候选 = 字典 **`授课科目`**（峰哥 2026-09-20 定）。
   *
   * 之前候选是「当前班级已有列里出现过的科目」—— 那等于**按班级配的候选**：
   * 新班、或这个班第一次开某学科时，候选是**空的**，只能手打；而手打的写法一旦不一致
   * （「数学」/「数学课」）就会让期末总评**按科目拆成两份**（总评是 学生 × 批次 × 科目 的快照）。
   * 生产实测就出现过同一班两列分别写成「数学课」和空。
   *
   * 改读字典后：科目清单在「字典管理」里维护一处、所有班统一，教师也不用再打错字。
   * 字典 key 与「教师档案 · 授课科目」共用同一份（本校区实际开课的科目就这些）。
   */
  const [subjectOptions, setSubjectOptions] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    api
      .dictionaries()
      .then((all) => {
        if (!alive) return;
        setSubjectOptions(all['授课科目'] ?? []);
        // 学年 / 学期候选与「成绩批次」用的是同一份字典（口径统一，别另立一套）
        setYearOptions(all['学年'] ?? []);
        setTermOptions(all['教学学期'] ?? []);
      })
      .catch(() => {
        // 读不到字典不阻塞建列：下拉退化成「未指定 + 手输兜底」由列编辑器处理
        if (alive) setSubjectOptions([]);
      });
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    if (!cls) {
      setTypeOptions([]);
      return;
    }
    let alive = true;
    api
      .markbookTypeOptions(cls)
      .then((res) => {
        if (!alive) return;
        setTypeOptions((res?.detail ?? []).map((d) => ({ value: d.value, label: d.label })));
      })
      .catch(() => {
        if (alive) setTypeOptions([]);
      });
    return () => {
      alive = false;
    };
  }, [cls]);

  const loadClasses = useCallback(async () => {
    const list = await api.markbookClasses();
    setClasses(list);
    setCls((cur) => (cur && list.some((c) => c.cls === cur) ? cur : (list[0]?.cls ?? '')));
  }, []);

  useEffect(() => {
    void loadClasses().catch(() => setClasses([]));
  }, [loadClasses]);

  /**
   * 拉网格。学年/学期从闭包取（调用方一律 `loadGrid(cls)`，不必到处传三个参数）。
   * ⚠️ 依赖里必须带上 year/term：否则切换学年学期后网格不会重新拉。
   */
  const loadGrid = useCallback(
    async (c: string) => {
      if (!c) {
        setGrid(null);
        return;
      }
      setLoading(true);
      try {
        setGrid(await api.markbookGrid(c, year, term));
        setDirty(new Map());
      } catch {
        setGrid(null);
      } finally {
        setLoading(false);
      }
    },
    [year, term],
  );

  useEffect(() => {
    void loadGrid(cls);
  }, [cls, loadGrid]);

  /**
   * 格子显示文本（单元格当前值：未保存改动优先，否则取服务端值）。
   *
   * ⚠️ **不能只显示 `score`**（2026-09-20 修）：免考落库时得分为空、缺考落库时得分是 0，
   *    只看 score 会让「免考」显示成空白、「缺考」显示成普普通通的 0 ——
   *    老师录完看不出到底录上没有，也分不清免考与缺考（两者对总评分母的影响完全不同）。
   */
  const cellText = (columnId: string, studentId: string): string => {
    const k = `${columnId}__${studentId}`;
    if (dirty.has(k)) return dirty.get(k)!;
    const c = cellMap.get(k);
    if (!c) return '';
    if (c.status === '免考') return t('cellExcused');
    if (c.status === '缺考') return t('cellAbsent');
    if (c.score != null) return String(c.score);
    // 只录了等级（等级区间没有分数上下限时，得分可能为空）→ 显示等级本身
    return c.level || '';
  };

  const cellMap = useMemo(() => {
    const m = new Map<string, MarkbookCell>();
    for (const c of grid?.cells ?? []) m.set(`${c.columnId}__${c.studentId}`, c);
    return m;
  }, [grid]);

  const summaryMap = useMemo(() => {
    const m = new Map<string, NonNullable<MarkbookGrid['summary']>[number]>();
    for (const s of grid?.summary ?? []) m.set(s.studentId, s);
    return m;
  }, [grid]);

  const onCellChange = (columnId: string, studentId: string, v: string) => {
    setDirty((prev) => {
      const next = new Map(prev);
      next.set(`${columnId}__${studentId}`, v);
      return next;
    });
  };

  const save = async () => {
    if (!cls || !dirty.size) return;
    setSaving(true);
    setMsg(null);
    try {
      const rows: MarkbookSaveRow[] = [...dirty.entries()].map(([k, v]) => {
        const [columnId, studentId] = k.split('__');
        const trimmed = v.trim();
        /**
         * 🔴 **原样传字符串，绝不要 `Number()`**（2026-09-20 修）。
         *
         * 服务端的 `parseScoreInput` 支持一整套写法：`85` / `85%`（按满分折算）/
         * `B`（折成该等级区间中位）/ `*`｜`免考`｜`EX`（免考，得分为空）/ `缺`（缺考，按 0 分）。
         * 而前端原先这里 `Number(trimmed)` —— 于是 `A`、`缺`、`免考` 全变成 **NaN**，
         * `JSON.stringify` 把 NaN 写成 `null`，服务端按「未录入」处理，**直接把格子删掉**：
         * 老师录了免考、保存后格子变空，看不出是哪一步错了，也没有任何报错。
         *
         * ⚠️ 空串仍传 null（= 删掉该格）—— 这是唯一该由前端判空的地方。
         */
        return { columnId, studentId, score: trimmed === '' ? null : trimmed };
      });
      const r = await api.markbookSaveEntries(cls, rows);
      setMsg({
        tone: 'ok',
        text: t('saveDone', { saved: r.saved, removed: r.removed }),
      });
      await loadGrid(cls);
    } catch (e) {
      setMsg({ tone: 'error', text: `${t('saveFailed')}：${(e as Error).message}` });
    } finally {
      setSaving(false);
    }
  };

  const recalc = async () => {
    if (!cls) return;
    setMsg(null);
    try {
      const r = await api.markbookRecalc(cls);
      setMsg({ tone: 'ok', text: t('recalcDone', { scanned: r.scanned, updated: r.updated }) });
      await loadGrid(cls);
    } catch (e) {
      setMsg({ tone: 'error', text: `${t('recalcFailed')}：${(e as Error).message}` });
    }
  };

  const removeColumn = async (col: MarkbookColumn) => {
    if (!window.confirm(t('confirmDeleteColumn', { name: col.name }))) return;
    await api.markbookDeleteColumn(col.id);
    await loadGrid(cls);
  };

  const dirtyCount = dirty.size;

  /** 该班出现过的学科（筛选候选；'' = 未指定学科，用 SUBJECT_NONE 表示） */
  const subjectFilterOptions = useMemo(() => {
    const out: string[] = [];
    for (const c of grid?.columns ?? []) {
      const sj = c.subject || SUBJECT_NONE;
      if (!out.includes(sj)) out.push(sj);
    }
    // 未指定学科固定放最后（它不是「一个学科」，是兜底分组）
    return out.sort((a, b) => (a === SUBJECT_NONE ? 1 : 0) - (b === SUBJECT_NONE ? 1 : 0));
  }, [grid]);
  const typeFilters = useTypeFilters(grid);
  /** 未归属学年学期的列数（历史数据；它们在任何筛选下都会显示，界面要说一句） */
  const unassignedCount = useMemo(
    () => (grid?.columns ?? []).filter((c) => c.unassigned).length,
    [grid],
  );

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
            <button className="btn btn-outline" onClick={() => void recalc()} disabled={!cls}>
              {t('recalc')}
            </button>
            <button className="btn btn-primary" onClick={() => void save()} disabled={!dirtyCount || saving}>
              {saving ? t('saving') : dirtyCount ? t('saveWithCount', { count: dirtyCount }) : t('noChanges')}
            </button>
          </div>
        </div>

        {msg && <div className={msg.tone === 'ok' ? 'notice notice-ok' : 'notice notice-error'}>{msg.text}</div>}

        {/* 学年 / 学期 / 班级：三者共同决定「显示哪些考核列」（学生名单仍只看班级）。
            🔴 学年学期不是「选完就忘」的筛选项 —— 新建考核列时会作为这一列的归属带进去。 */}
        <div className="mb-toolbar">
          <label className="mb-field">
            <span>{t('yearLabel')}</span>
            <select className="form-input" value={year} onChange={(e) => setYear(e.target.value)}>
              <option value="">{t('termAll')}</option>
              {yearOptions.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </label>
          <label className="mb-field">
            <span>{t('termLabel')}</span>
            <select className="form-input" value={term} onChange={(e) => setTerm(e.target.value)}>
              <option value="">{t('termAll')}</option>
              {termOptions.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
          </label>
          <label className="mb-field">
            <span>{t('classLabel')}</span>
            <select className="form-input" value={cls} onChange={(e) => setCls(e.target.value)}>
              {classes.length === 0 && <option value="">{t('noClass')}</option>}
              {classes.map((c) => (
                <option key={c.cls} value={c.cls}>
                  {t('classOption', { cls: c.cls, n: c.students })}
                </option>
              ))}
            </select>
          </label>
          {/* 两个动作放在一起：都是「往这个成绩册里加/写数据」 */}
          <span className="mb-toolbar-actions">
            <button
              className="btn btn-primary"
              onClick={() => setEditing({ col: null })}
              disabled={!cls}
            >
              ＋ {t('newColumn')}
            </button>
            <button className="btn btn-outline" onClick={() => setHwOpen(true)} disabled={!cls || !grid}>
              {t('hwButton')}
            </button>
          </span>
          <span className="mb-meta">
            {grid ? t('gridMeta', { students: grid.students.length, columns: grid.columns.length }) : ''}
          </span>
          <span className="mb-meta">
            {grid && grid.typeWeights.length
              ? t('typeWeightHint', {
                  list: grid.typeWeights.map((x) => `${x.type}×${x.weight}`).join('、'),
                })
              : t('noTypeWeight')}
          </span>
        </div>

        {/*
          未归属学年学期的历史列：它们在任何筛选下都会显示（后端兜底，避免"一筛选数据就没了"），
          所以必须说明一句 —— 否则老师会疑惑「我切到 2025学年，怎么还看得到这些列」。
        */}
        {unassignedCount > 0 ? (
          <div className="notice notice-info">{t('unassignedNotice', { count: unassignedCount })}</div>
        ) : null}

        {loading ? (
          <div className="dept-loading">{t('loading')}</div>
        ) : !cls ? (
          <div className="empty-state">
            <div className="empty-state-icon">📘</div>
            <div className="empty-state-text">{t('noClassHint')}</div>
          </div>
        ) : !grid || grid.students.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">🧑‍🎓</div>
            <div className="empty-state-text">{t('noStudents')}</div>
          </div>
        ) : (
          <div className="card mb-card">
            <div className="dept-card-head mbv-head">
              <span className="dept-card-title">{t('gridTitle', { cls })}</span>
              <span className="dept-card-meta">{t('weightNote')}</span>

              {/* 视图切换：四种排版渲染同一份数据，选择记在本机（下次进来还是它） */}
              <span className="mbv-switch">
                <span className="mbv-switch-label">{t('viewLabel')}</span>
                <span className="mbv-seg">
                  {MARKBOOK_VIEWS.map((v) => (
                    <button
                      key={v}
                      type="button"
                      className={v === view ? 'on' : undefined}
                      onClick={() => pickView(v)}
                    >
                      {t(`view_${v}`)}
                    </button>
                  ))}
                </span>
              </span>

              {subjectFilterOptions.length > 1 ? (
                <label className="mbv-filter">
                  <span>{t('colSubject')}</span>
                  <select
                    className="form-input"
                    value={subjectFilter}
                    onChange={(e) => setSubjectFilter(e.target.value)}
                  >
                    <option value="">{t('filterAll')}</option>
                    {subjectFilterOptions.map((sj) => (
                      <option key={sj} value={sj}>
                        {sj || t('subjectNone')}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}

              {typeFilters.length > 1 ? (
                <label className="mbv-filter">
                  <span>{t('colTypeLabel')}</span>
                  <select className="form-input" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
                    <option value="">{t('filterAll')}</option>
                    {(typeFilters as (string | null)[]).map((ty) => (
                      <option key={String(ty)} value={String(ty)}>
                        {ty || t('typeNone')}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>
            {/* 四种视图渲染的是同一份数据（见 components/markbook/views.tsx）：
                横排 / 竖排 / 学科分列 / 学科分行。切换只换排版，不改任何口径。 */}
            <MarkbookView
              view={view}
              grid={grid}
              cellValue={cellText}
              isDirty={(colId, stuId) => dirty.has(`${colId}__${stuId}`)}
              onCellChange={onCellChange}
              onEditColumn={(c) => setEditing({ col: c })}
              onRemoveColumn={(c) => void removeColumn(c)}
              summaryOf={(id) => summaryMap.get(id)}
              subjectFilter={subjectFilter}
              typeFilter={typeFilter}
            />
            <div className="mb-foot">
              {t('footNote', {
                levels: grid.levels.length,
                scales: grid.scales.map((x) => x.name).join(' / ') || t('noneScale'),
              })}
            </div>
          </div>
        )}

        {/*
          列编辑器 = 弹出框（2026-09-20 从「网格下方的内联面板」改过来）。
          🔴 `key` 仍然要按列 id 给：模态虽然挡住了页面，但**同一份表单会被复用来「编辑下一列」**
             （例如从成绩册点另一列的「编辑」时若忘了先关），没有 key 就是老 bug 重现。
        */}
        {editing && cls ? (
          <ColumnEditor
            key={editing.col?.id ?? '__new__'}
            cls={cls}
            col={editing.col}
            scales={grid?.scales ?? []}
            // 「科目」候选 = 字典「授课科目」（原来取该班已有列 ⇒ 新班/新科目候选为空）
            subjects={subjectOptions}
            // 考核类型候选（带本班权重标注）—— 见页面顶部 typeOptions 的注释
            types={typeOptions}
            years={yearOptions}
            terms={termOptions}
            defaultYear={year}
            defaultTerm={term}
            onClose={() => setEditing(null)}
            onSaved={async (created, keepOpen) => {
              if (created > 1) setMsg({ tone: 'ok', text: t('createdColumns', { count: created }) });
              // 勾了「继续建下一个」就留着弹窗（编辑器自己清表单），否则关掉
              if (!keepOpen) setEditing(null);
              await loadGrid(cls);
            }}
          />
        ) : null}

        {/* ── 作业 → 成绩册同步（弹出框，按钮在工具栏上）────────────────────
            以前这个面板埋在整张成绩表下面：要滚到底才看得见，而且**有未保存改动时整块不渲染**
            （老师以为「功能没了」）。现在改成按钮 + 弹窗，并把门控写成弹窗里的一条提示。 */}
        {hwOpen && cls && grid ? (
          <Modal
            title={t('hwSyncTitle')}
            subtitle={t('hwModalSub', { year: year || t('termAll'), term: term || t('termAll'), cls })}
            onClose={() => setHwOpen(false)}
            width={900}
          >
            {dirtyCount > 0 ? (
              <div className="notice notice-info">{t('hwDirtyBlock', { count: dirtyCount })}</div>
            ) : (
              <HomeworkSyncPanel
                cls={cls}
                columns={grid.columns}
                loadCatalog={api.markbookHomeworkCatalog}
                loadPreview={api.markbookSyncHomeworkPreview}
                runSync={api.markbookSyncHomework}
                bindHomework={api.markbookHomeworkBind}
                onSynced={() => loadGrid(cls)}
                inModal
              />
            )}
          </Modal>
        ) : null}
      </div>
    </div>
  );
}
