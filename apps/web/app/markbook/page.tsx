'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
// 筛选下拉统一走全站组件（2026-09-22 第二批）：本页原先用「标签在左 + 原生 select」的 mb-field 写法
import { FilterSelect } from '../../components/FilterSelect';
// 模板导出 / 成绩导入的纯函数（2026-09-30）：
//  · 表头生成与解析**共用同一份**（`gradeColumnHeaders`）—— 各写一份必然串位
//  · `gradeCellExportText`：导出用的**语言无关**文本（免/缺/等级/数字）；
//    不要用界面那个 cellText（它走 i18n，英文界面会导出 Excused/Absent）
//  · `parseGradeImport`：空 = 不动 · `clear` = 清空 · 学生ID 优先匹配
import {
  GRADE_IMPORT_CLEAR,
  buildGradeTemplateCsv,
  defaultTermOf,
  gradeCellExportText,
  parseGradeImport,
  type GradeImportParsed,
} from '@acms/contracts';
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

  /** 导入成绩：弹窗 + 解析结果（确认前先给老师看清楚要改多少格）+ 提交结果 */
  const [impOpen, setImpOpen] = useState(false);
  const [impBusy, setImpBusy] = useState(false);
  const [impFileName, setImpFileName] = useState('');
  const [impParsed, setImpParsed] = useState<GradeImportParsed | null>(null);
  const [impReport, setImpReport] = useState<{
    saved: number;
    removed: number;
    skipped: number;
    warnings: { columnId: string; studentId: string; message: string }[];
    errors: { columnId: string; studentId: string; value: string; message: string }[];
  } | null>(null);
  const impFileRef = useRef<HTMLInputElement>(null);

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

  /**
   * 列编辑：null=关闭，{col:null}=新建。
   * `siblings` = 「按学科分行」视图里与 `col` 同属一个考核项（同一基础名）的其它列记录
   * —— 归并表头下点「编辑」会一次带进来，弹窗顶部可切学科分别编辑。
   */
  const [editing, setEditing] = useState<{
    col: MarkbookColumn | null;
    siblings?: MarkbookColumn[];
  } | null>(null);
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

  /**
   * 批量删除（「按学科分行」视图的**归并表头**专用，2026-09-23）。
   *
   * 该视图里表头一列 = 一个考核项，背后可能是 N 条列记录（每个学科一条）。
   * 老师点「删除」想删的是这**一列**，所以要连着删 N 条；
   * 但确认框必须把科目列清楚 —— 删错就是把别的学科的成绩一起带走。
   *
   * ⚠️ 串行删（`for await` 故意不并发）：同一张表的列记录，并发写容易撞
   * 「读旧行 → 写回」的合并路径。
   */
  const removeColumns = async (cols: MarkbookColumn[]) => {
    if (!cols.length) return;
    const ok =
      cols.length === 1
        ? window.confirm(t('confirmDeleteColumn', { name: cols[0].name }))
        : window.confirm(
            t('confirmDeleteColumns', {
              count: cols.length,
              subjects: cols.map((c) => c.subject || t('subjectNone')).join('、'),
            }),
          );
    if (!ok) return;
    for (const c of cols) await api.markbookDeleteColumn(c.id);
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

  /** 学生 id → 姓名（导入错误清单里要给人看名字，不能是一串 id） */
  const nameOf = (studentId: string) =>
    grid?.students.find((x) => x.id === studentId)?.name ?? studentId;
  /** 列 id → 列名（同上） */
  const colNameOf = (columnId: string) => grid?.columns.find((c) => c.id === columnId)?.name ?? columnId;

  /**
   * 导出当前班级的**导入模板**（CSV，带现有分数作参照）。
   *
   * 🔴 为什么带上现有分数：老师改分时能一眼看到原来是几分（不带的话就是"盲填"，
   *    填错也发现不了）。空着的格子留空 = 导入时不改动它。
   * 🔴 为什么用 `gradeCellExportText` 而不是界面上的 `cellText`：后者是给人看的、
   *    免考/缺考走 i18n 文案（英文界面导出 `Excused` 这种），而导出/导入是机器往返。
   */
  const exportTemplate = () => {
    if (!grid || !cls) return;
    const text = buildGradeTemplateCsv({
      students: grid.students.map((x) => ({ id: x.id, name: x.name, enName: x.enName })),
      columns: grid.columns.map((c) => ({ id: c.id, name: c.name })),
      cellText: (studentId, columnId) => gradeCellExportText(cellMap.get(`${columnId}__${studentId}`)),
    });
    downloadTextFile(`${cls}-成绩导入模板.csv`, text);
    setMsg({
      tone: 'ok',
      text: t('templateDone', { students: grid.students.length, columns: grid.columns.length }),
    });
  };

  /** 选文件 → 立刻解析并展示"要改多少格"（**不直接提交**，老师确认后才写库） */
  const pickImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // ⚠️ 先清空 input 的 value：同一个文件连续选两次时 change 不再触发（真踩过）
    e.target.value = '';
    if (!file || !grid) return;
    setImpFileName(file.name);
    setImpReport(null);
    try {
      const text = await file.text();
      setImpParsed(
        parseGradeImport({
          text,
          students: grid.students.map((x) => ({ id: x.id, name: x.name })),
          columns: grid.columns.map((c) => ({ id: c.id, name: c.name })),
        }),
      );
    } catch (err) {
      setImpParsed(null);
      setMsg({ tone: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  };

  /**
   * 提交导入。**分批**（每批 300 格）：一个请求塞几百格的话，
   * 后端逐格解析 + 逐条 upsert 会超时，而超时后老师不知道到底进了多少。
   */
  const runImport = async () => {
    if (!grid || !impParsed || !cls) return;
    const all = impParsed.rows;
    if (!all.length) return;
    setImpBusy(true);
    const acc = { saved: 0, removed: 0, skipped: 0, warnings: [], errors: [] } as NonNullable<typeof impReport>;
    try {
      for (let i = 0; i < all.length; i += 300) {
        const batch = all.slice(i, i + 300);
        const res = await api.markbookSaveEntries(
          cls,
          batch.map((r) => ({ columnId: r.columnId, studentId: r.studentId, score: r.raw })),
        );
        acc.saved += res.saved;
        acc.removed += res.removed;
        acc.skipped += res.skipped;
        acc.warnings.push(...res.warnings);
        acc.errors.push(...res.errors);
      }
      setImpReport(acc);
      setMsg({ tone: 'ok', text: t('importResult', { saved: acc.saved, removed: acc.removed, skipped: acc.skipped }) });
      await loadGrid(cls);
    } catch (err) {
      setMsg({ tone: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setImpBusy(false);
    }
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
          {/* 学年 / 学期可不限（原「全部」选项）；班级是**必选参数**（成绩册整页按它取数）
              ⇒ `clearable={false}`，空列表时用文字提示替代原来的「暂无班级」option。 */}
          <FilterSelect label={t('yearLabel')} value={year} onChange={setYear} options={yearOptions} />
          <FilterSelect label={t('termLabel')} value={term} onChange={setTerm} options={termOptions} />
          {classes.length === 0 ? (
            <span className="muted" style={{ fontSize: 'var(--font-xs)' }}>{t('noClass')}</span>
          ) : (
            <FilterSelect
              label={t('classLabel')}
              value={cls}
              onChange={setCls}
              options={classes.map((c) => c.cls)}
              optionLabels={Object.fromEntries(
                classes.map((c) => [c.cls, t('classOption', { cls: c.cls, n: c.students })]),
              )}
              clearable={false}
            />
          )}
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
            {/* 模板导出 / 成绩导入（2026-09-30 峰哥要求）。
                放在这一组是有意的：它们和「＋ 新建考核列」「作业同步」一样，
                都是"往这个成绩册里加 / 写数据"的动作。 */}
            <button className="btn btn-outline" onClick={exportTemplate} disabled={!cls || !grid}>
              {t('templateBtn')}
            </button>
            <button
              className="btn btn-outline"
              onClick={() => {
                setImpOpen(true);
                setImpParsed(null);
                setImpReport(null);
                setImpFileName('');
              }}
              disabled={!cls || !grid}
            >
              {t('importBtn')}
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
                <FilterSelect
                  label={t('colSubject')}
                  value={subjectFilter}
                  onChange={setSubjectFilter}
                  options={subjectFilterOptions}
                  optionLabels={Object.fromEntries(
                    subjectFilterOptions.map((sj) => [sj, sj || t('subjectNone')]),
                  )}
                />
              ) : null}

              {typeFilters.length > 1 ? (
                <FilterSelect
                  label={t('colTypeLabel')}
                  value={typeFilter}
                  onChange={setTypeFilter}
                  options={(typeFilters as (string | null)[]).map((ty) => String(ty))}
                  optionLabels={Object.fromEntries(
                    (typeFilters as (string | null)[]).map((ty) => [String(ty), ty || t('typeNone')]),
                  )}
                />
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
              // 归并表头（一列 = 一个考核项 × N 个学科）走这两个：编辑带学科切换、删除按科目批量
              onEditColumns={(cols) =>
                setEditing({ col: cols[0] ?? null, siblings: cols.length > 1 ? cols : undefined })
              }
              onRemoveColumns={(cols) => void removeColumns(cols)}
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
            // 归并表头一次带进来的「同考核项的其它学科列记录」（顶部 chip 切换，key 变了会重建表单）
            siblings={editing.siblings}
            onPickSibling={(c) => setEditing((cur) => (cur ? { ...cur, col: c } : cur))}
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

        {/* ── 导入成绩（2026-09-30 峰哥要求）────────────────────────────────
            两步：选文件 → **先看"要改多少格"再确认**。成绩导入是批量写，
            没有这一步的话，一个列名写错的文件会把整班的分悄悄改掉。 */}
        {impOpen && cls && grid ? (
          <Modal
            title={t('importTitle')}
            subtitle={t('importSub', { cls })}
            onClose={() => setImpOpen(false)}
            width={760}
            footer={
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', width: '100%' }}>
                <button className="btn btn-outline" onClick={() => setImpOpen(false)}>
                  {t('close')}
                </button>
                <button
                  className="btn btn-primary"
                  disabled={impBusy || !impParsed || !impParsed.rows.length}
                  onClick={() => void runImport()}
                >
                  {impBusy
                    ? t('importing')
                    : impParsed && impParsed.rows.length
                      ? t('importConfirm', { n: impParsed.rows.length, c: impParsed.clears })
                      : t('importNone')}
                </button>
              </div>
            }
          >
            <input
              ref={impFileRef}
              type="file"
              accept=".csv,text/csv"
              style={{ display: 'none' }}
              onChange={(e) => void pickImportFile(e)}
            />
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
              <button className="btn btn-outline" onClick={() => impFileRef.current?.click()}>
                {t('importPick')}
              </button>
              <span className="muted" style={{ fontSize: 'var(--font-xs)' }}>
                {impFileName || t('importNoFile')}
              </span>
            </div>
            {/* 填法说明：与模板第 2 行的说明同源（改判据就改 contracts 的常量注释） */}
            <div className="notice notice-info" style={{ marginBottom: 10 }}>
              {t('importHowto', { clear: GRADE_IMPORT_CLEAR })}
            </div>

            {impParsed ? (
              <>
                {impParsed.unknownColumns.length ? (
                  <div className="notice notice-error" style={{ marginBottom: 8 }}>
                    {t('importUnknownCols', { cols: impParsed.unknownColumns.join('、') })}
                  </div>
                ) : null}
                <div style={{ fontSize: 'var(--font-sm)', marginBottom: 6 }}>
                  {t('importSummary', {
                    rows: impParsed.rows.length,
                    students: new Set(impParsed.rows.map((r) => r.studentId)).size,
                    clears: impParsed.clears,
                    untouched: impParsed.untouched,
                  })}
                </div>

                {impParsed.problems.length ? (
                  <div style={{ marginTop: 8 }}>
                    <div style={{ fontWeight: 600, fontSize: 'var(--font-sm)', marginBottom: 4 }}>
                      {t('importProblems', { n: impParsed.problems.length })}
                    </div>
                    <div style={{ maxHeight: 160, overflow: 'auto', fontSize: 'var(--font-xs)' }}>
                      {impParsed.problems.slice(0, 60).map((p, i) => (
                        <div key={i} className="muted">
                          {t('importLine', { line: p.line })} {p.where}：{p.reason}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                {impReport ? (
                  <div style={{ marginTop: 10 }}>
                    <div style={{ fontWeight: 600, fontSize: 'var(--font-sm)' }}>
                      {t('importResult', { saved: impReport.saved, removed: impReport.removed, skipped: impReport.skipped })}
                    </div>
                    {impReport.warnings.length ? (
                      <div className="muted" style={{ fontSize: 'var(--font-xs)', marginTop: 4 }}>
                        {t('importWarn', { n: impReport.warnings.length })}
                      </div>
                    ) : null}
                    {impReport.errors.length ? (
                      <div style={{ marginTop: 6, color: 'var(--danger)', fontSize: 'var(--font-xs)' }}>
                        <div style={{ fontWeight: 600 }}>{t('importErrors', { n: impReport.errors.length })}</div>
                        <div style={{ maxHeight: 140, overflow: 'auto' }}>
                          {impReport.errors.slice(0, 60).map((e, i) => (
                            <div key={i}>
                              {nameOf(e.studentId)} · {colNameOf(e.columnId)}：{e.value} —— {e.message}
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : (
              <div className="muted" style={{ fontSize: 'var(--font-xs)' }}>
                {t('importHint')}
              </div>
            )}
          </Modal>
        ) : null}
      </div>
    </div>
  );
}

/**
 * 触发浏览器下载一个文本文件（BOM + UTF-8）。
 *
 * ⚠️ 必须带 BOM：不带的话 Excel 打开中文会乱码（老师第一反应就是"文件坏了"）。
 */
function downloadTextFile(filename: string, text: string): void {
  const blob = new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
