'use client';

import { Fragment, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { mergeColumnsByBaseName, mergedWeightFull } from '@acms/contracts';
import type { MarkbookColumn, MarkbookGrid, MarkbookSummary } from '../../lib/api';

/**
 * 成绩册的**四种视图**（2026-09-20）。
 *
 * 四个视图渲染的是**同一份** `/markbook/grid` 数据，只是排版不同：
 *   1. `flat`         横排：学生为行、考核列为列（按考核类型分组 + 每组小计）—— 沿用最久、兼容性最好
 *   2. `transposed`   竖排：考核项为行、学生为列（行尾均分/最高/最低 + 每组学生的类型小计）
 *   3. `subjectCols`  按学科分列：学生为行、学科为列组（组内是该学科的考核列、组尾是学科合计）
 *   4. `subjectRows`  按学科分行：学生 × 学科为行、考核类型为表头、行尾是该生该学科的合计
 *
 * 🔴 三条共用约定（四个视图必须一致，否则同一个数在两处不同）：
 *  ① 参与计算的聚合（列均分、类型小计、学科加权均分）**全部由服务端算好**传下来
 *     （`columnStats` / `typeTotals` / `subjectSummaries`）—— 前端只管排版，不复制权重公式；
 *  ② 可编辑的格子只有「一个具体成绩册列 × 一个学生」这一种（四个视图都用同一个 `CellBox`）；
 *     统计列、汇总列、跨行合并的单元格一律**只读**；
 *  ③ 「留空 ≠ 0」：空值显示 `—`，聚合里按「未参与」处理（服务端口径）。
 */

export type MarkbookViewKey = 'flat' | 'transposed' | 'subjectCols' | 'subjectRows';

export const MARKBOOK_VIEWS: MarkbookViewKey[] = ['flat', 'transposed', 'subjectCols', 'subjectRows'];

export interface GridViewProps {
  grid: MarkbookGrid;
  /** 单元格显示值（已叠加未保存的编辑） */
  cellValue: (columnId: string, studentId: string) => string;
  isDirty: (columnId: string, studentId: string) => boolean;
  onCellChange: (columnId: string, studentId: string, value: string) => void;
  onEditColumn: (col: MarkbookColumn) => void;
  onRemoveColumn: (col: MarkbookColumn) => void;
  /**
   * 归并表头的批量操作（「按学科分行」视图专用）：一次传入同一考核项下的 N 条列记录。
   * ⚠️ 只有这两个回调存在时，归并列的「编辑 / 删除」才会按科目批量处理；
   *    缺失则回退成只操作第一条（旧行为）—— 页面务必都传上。
   */
  onEditColumns?: (cols: MarkbookColumn[]) => void;
  onRemoveColumns?: (cols: MarkbookColumn[]) => void;
  summaryOf: (studentId: string) => MarkbookSummary | undefined;
  /** '' = 全部；'' 之外的取值 = 只看该校（未指定学科用 `__none__`） */
  subjectFilter: string;
  /** '' = 全部 */
  typeFilter: string;
}

/** 未指定学科在筛选里的哨兵值（空串要留给「全部」） */
export const SUBJECT_NONE = '__none__';

const cls = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(' ');

/** 可编辑的成绩格子：四个视图共用同一个输入控件（保证手改的行为一致） */
function CellBox({
  value,
  dirty,
  onChange,
}: {
  value: string;
  dirty: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <input
      className={cls('form-input', 'mb-input', dirty && 'mb-input-dirty')}
      /**
       * 用 text 而不是 decimal：格子里除了数字，还要能录 `85%` / `B`（字母等级）/ `*`（免考）/ `缺`（缺考）。
       * 限成数字键盘会让移动端根本打不出这些写法。
       */
      inputMode="text"
      value={value}
      placeholder="—"
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/** 只读格子（统计/汇总用）；空值显示「—」而不是 0 */
function ReadOnlyBox({ value, tone }: { value: string | number | null | undefined; tone?: 'total' | 'sub' }) {
  const empty = value === '' || value == null;
  return <span className={cls('mbv-ro', tone && `mbv-ro-${tone}`, empty && 'mbv-ro-empty')}>{empty ? '—' : value}</span>;
}

/** 学生名字（中/英）+ 可选副标题（学科） */
function StudentCell({ name, enName }: { name: string; enName?: string }) {
  return (
    <div>
      <div className="dept-emp-name">{name}</div>
      {enName ? <div className="dept-emp-sub">{enName}</div> : null}
    </div>
  );
}

function ColumnOps({
  col,
  cols,
  onEdit,
  onRemove,
  onEditMany,
  onRemoveMany,
}: {
  col?: MarkbookColumn;
  /**
   * 归并后的多条列记录（「按学科分行」视图用）。
   * 归并后表头一列可能对应 N 条列记录（每学科一条）⇒ 编辑/删除要能按科目处理，
   * 不能只对第一条生效（那样另外几条会静默留着，老师以为删干净了）。
   */
  cols?: MarkbookColumn[];
  onEdit: (c: MarkbookColumn) => void;
  onRemove: (c: MarkbookColumn) => void;
  onEditMany?: (cs: MarkbookColumn[]) => void;
  onRemoveMany?: (cs: MarkbookColumn[]) => void;
}) {
  const t = useTranslations('markbook');
  const list = cols?.length ? cols : col ? [col] : [];
  if (!list.length) return null;
  const many = list.length > 1;
  const first = list[0];
  return (
    <div className="mb-col-ops">
      <button
        type="button"
        className="link-btn"
        title={many ? t('editMergedHint', { count: list.length }) : undefined}
        onClick={() => (many && onEditMany ? onEditMany(list) : onEdit(list[0]))}
      >
        {t('edit')}
      </button>
      <button
        type="button"
        className="link-btn"
        title={many ? t('deleteMergedHint', { count: list.length }) : undefined}
        onClick={() => (many && onRemoveMany ? onRemoveMany(list) : onRemove(list[0]))}
      >
        {t('delete')}
      </button>
    </div>
  );
}

/** 目标列（含「序号不在体系里」的显式提示；与横排视图的原有口径一致） */
function TargetBadge({ sum }: { sum: MarkbookSummary | undefined }) {
  const t = useTranslations('markbook');
  const has = !!sum && (sum.targetLevel !== '' || sum.targetOrder != null || sum.targetScore != null);
  if (!has) return <span className="muted">{t('noTarget')}</span>;
  const outOfRange = sum!.targetOrderKnown === false;
  const label =
    sum!.targetLevel || (sum!.targetOrder != null ? t('targetOrderShort', { n: sum!.targetOrder }) : '');
  const scoreText = sum!.targetScore != null ? t('targetScoreLabel', { score: sum!.targetScore }) : '';
  const text = [label, outOfRange ? t('targetOrderUnknown') : '', scoreText].filter(Boolean).join(' · ');
  return (
    <span
      className={
        outOfRange || sum!.attained === false
          ? 'dept-status dept-status-resigned'
          : sum!.attained === true
            ? 'dept-status dept-status-ok'
            : 'dept-status'
      }
      title={
        outOfRange
          ? t('targetOrderUnknownHint')
          : sum!.attained === false
            ? t('belowTarget')
            : sum!.attained === true
              ? t('atTarget')
              : t('attainUnknown')
      }
    >
      {text}
      {!outOfRange && sum!.attained === false ? ' ↓' : ''}
    </span>
  );
}

/** 学科标签（未指定学科用橙色，与列头一致） */
function SubjectTag({ subject }: { subject: string }) {
  const t = useTranslations('markbook');
  return (
    <span className={cls('mbv-subj', !subject && 'mbv-subj-none')}>{subject || t('subjectNone')}</span>
  );
}

// ── 通用的索引与小工具（纯展示，不含任何计分口径）──────────────────────────

function useIndexes(grid: MarkbookGrid, subjectFilter: string, typeFilter: string) {
  return useMemo(() => {
    const matchSubject = (c: MarkbookColumn) => {
      if (!subjectFilter) return true;
      const sub = c.subject || '';
      return subjectFilter === SUBJECT_NONE ? sub === '' : sub === subjectFilter;
    };
    const matchType = (c: MarkbookColumn) => !typeFilter || c.type === typeFilter;
    const columns = grid.columns.filter((c) => matchSubject(c) && matchType(c));

    /** 列 → 考核类型 分组（顺序保持服务端给的列顺序，即「排序」后的顺序） */
    const byType = new Map<string, MarkbookColumn[]>();
    for (const c of columns) {
      const k = c.type || '';
      const arr = byType.get(k) ?? [];
      arr.push(c);
      byType.set(k, arr);
    }
    const colStat = new Map(grid.columnStats.map((x) => [x.columnId, x]));
    const typeTotal = new Map(grid.typeTotals.map((x) => [`${x.studentId}__${x.type}`, x]));
    const subjSum = new Map(grid.subjectSummaries.map((x) => [`${x.studentId}__${x.subject}`, x]));
    const cellOf = new Map(grid.cells.map((x) => [`${x.columnId}__${x.studentId}`, x]));
    /** 该班出现过的学科（按列的先后顺序去重；'' = 未指定） */
    const subjects: string[] = [];
    for (const c of grid.columns) {
      const s = c.subject || '';
      if (!subjects.includes(s)) subjects.push(s);
    }
    return { columns, byType, colStat, typeTotal, subjSum, cellOf, subjects };
  }, [grid, subjectFilter, typeFilter]);
}

/**
 * 该班出现过的考核类型（筛选下拉的候选）。按列的先后顺序去重 —— 与「考核类型」页的排序一致。
 * ⚠️ 接受 `null`：页面在 grid 还没加载时也要（无条件地）调用 hook，否则违反 hooks 规则。
 */
function useTypeFilters(grid: MarkbookGrid | null) {
  return useMemo(() => {
    const out: string[] = [];
    for (const c of grid?.columns ?? []) {
      const t = c.type || '';
      if (!out.includes(t)) out.push(t);
    }
    return out;
  }, [grid]);
}

export { useTypeFilters };

/**
 * 汇总四列：总评 / 等级 / 目标 / 已录项数 —— **顺序与原来一致**（总评在最前），
 * 只是把「已录项数」补上（它解释「为什么总评是空的」：一项都没录）。
 */
function SummaryCells({ sum }: { sum: MarkbookSummary | undefined }) {
  const t = useTranslations('markbook');
  return (
    <>
      <td className="mb-sum-col mb-total">{sum?.total == null ? '—' : sum.total}</td>
      <td className="mb-sum-col">
        {sum?.level ? (
          <span className={sum.concern ? 'dept-status dept-status-inactive' : 'dept-status dept-status-ok'}>
            {sum.level}
          </span>
        ) : (
          '—'
        )}
      </td>
      <td className="mb-sum-col">
        <TargetBadge sum={sum} />
      </td>
      <td className="mb-sum-col muted" style={{ fontSize: 11 }}>
        {t('summaryFilled', { count: sum?.filled ?? 0 })}
      </td>
    </>
  );
}

// ── ① 横排：学生为行、考核列为列（按考核类型分组 + 每组小计）───────────────

export function FlatView(p: GridViewProps) {
  const t = useTranslations('markbook');
  const { columns, byType, colStat, typeTotal } = useIndexes(p.grid, p.subjectFilter, p.typeFilter);

  if (!columns.length) return <div className="mbv-empty">{t('noColumnsYet')}</div>;

  return (
    <div className="data-table-wrap">
      <table className="data-table mb-table">
        <thead>
          <tr className="mbv-grouphdr">
            <th className="mb-sticky-col" rowSpan={2}>
              {t('colStudent')}
            </th>
            {[...byType.entries()].map(([type, cs]) => (
              <th key={`g-${type}`} colSpan={cs.length + 1} className="mbv-typeband">
                {type || t('typeNone')}
                <span className="mbv-bandcount">{t('typeBandCount', { count: cs.length })}</span>
              </th>
            ))}
            <th className="mb-sum-col" colSpan={4} rowSpan={2}>
              {t('summaryGroup')}
            </th>
          </tr>
          <tr>
            {[...byType.entries()].map(([type, cs]) => (
              <Fragment key={`h-${type}`}>
                {cs.map((c) => (
                  <th key={c.id} className="mb-col-head">
                    <div className="mb-col-name" title={`${c.type ? c.type + ' · ' : ''}${t('colWeightFull', { weight: c.weight, full: c.fullMark })}`}>
                      {c.name}
                    </div>
                    <div className="mb-col-sub">
                      {c.subject ? <SubjectTag subject={c.subject} /> : null}
                      {t('colWeightFull', { weight: c.weight, full: c.fullMark })}
                    </div>
                    <ColumnOps col={c} onEdit={p.onEditColumn} onRemove={p.onRemoveColumn} />
                  </th>
                ))}
                <th key={`st-${type}`} className="mbv-subcol">
                  {t('colSubtotal')}
                  <div className="mb-col-sub">{t('subtotalOf', { count: cs.length })}</div>
                </th>
              </Fragment>
            ))}
          </tr>
        </thead>
        <tbody>
          {p.grid.students.map((s) => {
            const sum = p.summaryOf(s.id);
            return (
              <tr key={s.id}>
                <td className="mb-sticky-col">
                  <StudentCell name={s.name} enName={s.enName} />
                </td>
                {[...byType.entries()].map(([type, cs]) => (
                  <Fragment key={`b-${type}`}>
                    {cs.map((c) => (
                      <td key={c.id} className="mb-cell">
                        <CellBox
                          value={p.cellValue(c.id, s.id)}
                          dirty={p.isDirty(c.id, s.id)}
                          onChange={(v) => p.onCellChange(c.id, s.id, v)}
                        />
                      </td>
                    ))}
                    <td key={`st-${type}`} className="mbv-subcol">
                      <ReadOnlyBox value={typeTotal.get(`${s.id}__${type}`)?.sum ?? null} tone="sub" />
                    </td>
                  </Fragment>
                ))}
                <SummaryCells sum={sum} />
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="mbv-foot">{t('footNoteFlat')}</div>
    </div>
  );
}

// ── ② 竖排：考核项为行、学生为列 ─────────────────────────────────────────

export function TransposedView(p: GridViewProps) {
  const t = useTranslations('markbook');
  const { columns, byType, colStat, typeTotal } = useIndexes(p.grid, p.subjectFilter, p.typeFilter);
  const students = p.grid.students;

  if (!columns.length) return <div className="mbv-empty">{t('noColumnsYet')}</div>;

  return (
    <div className="data-table-wrap">
      <table className="data-table mb-table mbv-t">
        <thead>
          <tr>
            <th className="mb-sticky-col">{t('colItem')}</th>
            {students.map((s) => (
              <th key={s.id} className="mbv-stuh">
                {s.name}
                {s.enName ? <div className="mb-col-sub">{s.enName}</div> : null}
              </th>
            ))}
            <th className="mbv-subcol">{t('colMean')}</th>
            <th className="mbv-subcol">{t('colMax')}</th>
            <th className="mbv-subcol">{t('colMin')}</th>
          </tr>
        </thead>
        <tbody>
          {[...byType.entries()].map(([type, cs]) => (
            <Fragment key={`g-${type}`}>
              <tr key={`band-${type}`} className="mbv-typebandrow">
                <td className="mb-sticky-col" colSpan={students.length + 4}>
                  {type || t('typeNone')}
                  <span className="mbv-bandcount">{t('typeBandCount', { count: cs.length })}</span>
                </td>
              </tr>
              {cs.map((c) => {
                const st = colStat.get(c.id);
                return (
                  <tr key={c.id}>
                    <td className="mb-sticky-col">
                      <div className="mbv-itemname">
                        <span className={cls('mbv-dot')} style={c.typeColor ? { background: c.typeColor } : undefined} />
                        {c.name}
                        {c.subject ? <SubjectTag subject={c.subject} /> : null}
                      </div>
                      <div className="mb-col-sub">
                        {t('colWeightFull', { weight: c.weight, full: c.fullMark })}
                        <ColumnOpsInline col={c} onEdit={p.onEditColumn} onRemove={p.onRemoveColumn} />
                      </div>
                    </td>
                    {students.map((s) => (
                      <td key={s.id} className="mb-cell">
                        <CellBox
                          value={p.cellValue(c.id, s.id)}
                          dirty={p.isDirty(c.id, s.id)}
                          onChange={(v) => p.onCellChange(c.id, s.id, v)}
                        />
                      </td>
                    ))}
                    <td className="mbv-subcol">
                      <ReadOnlyBox value={st?.mean ?? null} tone="sub" />
                    </td>
                    <td className="mbv-subcol">
                      <ReadOnlyBox value={st?.max ?? null} tone="sub" />
                    </td>
                    <td className="mbv-subcol">
                      <ReadOnlyBox value={st?.min ?? null} tone="sub" />
                    </td>
                  </tr>
                );
              })}
              <tr key={`sub-${type}`} className="mbv-subrow">
                <td className="mb-sticky-col">{t('typeSubtotal', { type: type || t('typeNone') })}</td>
                {students.map((s) => (
                  <td key={s.id}>
                    <ReadOnlyBox value={typeTotal.get(`${s.id}__${type}`)?.sum ?? null} tone="sub" />
                  </td>
                ))}
                <td className="mbv-subcol" colSpan={3}>
                  <span className="muted" style={{ fontSize: 11 }}>
                    {t('subtotalHint')}
                  </span>
                </td>
              </tr>
            </Fragment>
          ))}
          <tr className="mbv-grand">
            <td className="mb-sticky-col">{t('colTotal')}</td>
            {students.map((s) => (
              <td key={s.id}>
                <ReadOnlyBox value={p.summaryOf(s.id)?.total ?? null} tone="total" />
              </td>
            ))}
            <td className="mbv-subcol" colSpan={3}>
              <span className="muted" style={{ fontSize: 11 }}>
                {t('grandHint')}
              </span>
            </td>
          </tr>
          <tr className="mbv-grand">
            <td className="mb-sticky-col">{t('colLevel')}</td>
            {students.map((s) => (
              <td key={s.id}>
                <ReadOnlyBox value={p.summaryOf(s.id)?.level ?? null} tone="total" />
              </td>
            ))}
            <td className="mbv-subcol" colSpan={3} />
          </tr>
          <tr className="mbv-grand">
            <td className="mb-sticky-col">{t('colTarget')}</td>
            {students.map((s) => (
              <td key={s.id}>
                <TargetBadge sum={p.summaryOf(s.id)} />
              </td>
            ))}
            <td className="mbv-subcol" colSpan={3} />
          </tr>
        </tbody>
      </table>
      <div className="mbv-foot">{t('footNoteTransposed')}</div>
    </div>
  );
}

/** 竖排的行标签里塞「编辑/删除」，与其它视图的列头操作等价 */
function ColumnOpsInline({
  col,
  onEdit,
  onRemove,
}: {
  col: MarkbookColumn;
  onEdit: (c: MarkbookColumn) => void;
  onRemove: (c: MarkbookColumn) => void;
}) {
  const t = useTranslations('markbook');
  return (
    <span className="mb-col-ops">
      <button type="button" className="link-btn" onClick={() => onEdit(col)}>
        {t('edit')}
      </button>
      <button type="button" className="link-btn" onClick={() => onRemove(col)}>
        {t('delete')}
      </button>
    </span>
  );
}

// ── ③ 按学科分列：学生为行、学科为列组（组尾 = 学科合计）──────────────────

export function SubjectColsView(p: GridViewProps) {
  const t = useTranslations('markbook');
  const { columns, subjSum } = useIndexes(p.grid, p.subjectFilter, p.typeFilter);

  /** 按学科把（已筛选的）列分组；学科顺序 = 该班列里出现的先后（与字典顺序一致） */
  const groups = useMemo(() => {
    const order: string[] = [];
    const map = new Map<string, MarkbookColumn[]>();
    for (const c of columns) {
      const s = c.subject || '';
      if (!map.has(s)) {
        map.set(s, []);
        order.push(s);
      }
      map.get(s)!.push(c);
    }
    // 未指定学科固定放最后（它不是「一个学科」，是本页的兜底分组）
    order.sort((a, b) => (a === '' ? 1 : 0) - (b === '' ? 1 : 0));
    return order.map((s) => ({ subject: s, cols: map.get(s)! }));
  }, [columns]);

  if (!columns.length) return <div className="mbv-empty">{t('noColumnsYet')}</div>;

  return (
    <div className="data-table-wrap">
      <table className="data-table mb-table">
        <thead>
          <tr className="mbv-grouphdr">
            <th className="mb-sticky-col" rowSpan={2}>
              {t('colStudent')}
            </th>
            {groups.map((g) => (
              <th
                key={`g-${g.subject}`}
                colSpan={g.cols.length + 1}
                className={cls('mbv-typeband', !g.subject && 'mbv-typeband-none')}
              >
                {g.subject || t('subjectNone')}
                <span className="mbv-bandcount">{t('subjectBandCount', { count: g.cols.length })}</span>
              </th>
            ))}
            <th className="mb-sum-col" colSpan={4} rowSpan={2}>
              {t('summaryGroup')}
            </th>
          </tr>
          <tr>
            {groups.map((g) => (
              <Fragment key={`h-${g.subject}`}>
                {g.cols.map((c) => (
                  <th key={c.id} className="mb-col-head">
                    <div className="mb-col-name">{c.name}</div>
                    <div className="mb-col-sub">
                      {c.type ? `${c.type} · ` : ''}
                      {t('colWeightFull', { weight: c.weight, full: c.fullMark })}
                    </div>
                    <ColumnOps col={c} onEdit={p.onEditColumn} onRemove={p.onRemoveColumn} />
                  </th>
                ))}
                <th key={`st-${g.subject}`} className="mbv-subcol">
                  {t('colSubjectTotal')}
                </th>
              </Fragment>
            ))}
          </tr>
        </thead>
        <tbody>
          {p.grid.students.map((s) => {
            const sum = p.summaryOf(s.id);
            return (
              <tr key={s.id}>
                <td className="mb-sticky-col">
                  <StudentCell name={s.name} enName={s.enName} />
                </td>
                {groups.map((g) => (
                  <Fragment key={`b-${g.subject}`}>
                    {g.cols.map((c) => (
                      <td key={c.id} className="mb-cell">
                        <CellBox
                          value={p.cellValue(c.id, s.id)}
                          dirty={p.isDirty(c.id, s.id)}
                          onChange={(v) => p.onCellChange(c.id, s.id, v)}
                        />
                      </td>
                    ))}
                    <td key={`st-${g.subject}`} className="mbv-subcol">
                      <ReadOnlyBox value={subjSum.get(`${s.id}__${g.subject}`)?.weighted ?? null} tone="sub" />
                      <div className="mbv-ro-sub">
                        {subjSum.get(`${s.id}__${g.subject}`)?.level || ''}
                      </div>
                    </td>
                  </Fragment>
                ))}
                <SummaryCells sum={sum} />
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="mbv-foot">{t('footNoteSubjectCols')}</div>
    </div>
  );
}

// ── ④ 按学科分行：学生 × 学科为行、考核类型为表头 ────────────────────────

export function SubjectRowsView(p: GridViewProps) {
  const t = useTranslations('markbook');
  const { byType, subjSum, subjects } = useIndexes(p.grid, p.subjectFilter, p.typeFilter);

  /**
   * 表头：按考核类型分组；组内按**基础名**归并（去掉建列时自动拼上去的「 · 科目」后缀）。
   *
   * 🔴 这是「学科拆到行里」的**前提**：建列时勾了 3 个科目 ⇒ `subjectColumnDrafts`
   *    会落成「日常 · 数学 / 日常 · 英语 / 日常 · 生物学」**三条独立列记录**。
   *    表头若照它们排三列，每一行就只有斜对角那一格能填、另外两格永远是空的
   *    （2026-09-22 生产截图）。归并后一列 = 一个考核项，由行上的学科决定取哪条记录。
   *    规则与撞名保护都在 `@acms/contracts` 的 `mergeColumnsByBaseName`（带单测）。
   */
  const groups = useMemo(() => {
    return [...byType.entries()].map(([type, cs]) => ({
      type,
      /** 每个元素 = 表头一列：`base` 是显示名，`bySubject` 决定各学科行取哪条列记录 */
      cols: mergeColumnsByBaseName(cs).map((g) => ({
        base: g.base,
        bySubject: g.bySubject,
        all: g.cols,
        wf: mergedWeightFull(g.cols),
      })),
    }));
  }, [byType]);

  /** 行：学生 × 学科（学科来自该班列；筛选后只剩选中的那个） */
  const rows = useMemo(() => {
    const list: { studentId: string; name: string; enName: string; subject: string; firstOfStudent: boolean; span: number }[] = [];
    for (const s of p.grid.students) {
      subjects.forEach((sub, i) => {
        list.push({
          studentId: s.id,
          name: s.name,
          enName: s.enName,
          subject: sub,
          firstOfStudent: i === 0,
          span: subjects.length,
        });
      });
    }
    return list;
  }, [p.grid.students, subjects]);

  if (!groups.length || !subjects.length) return <div className="mbv-empty">{t('noColumnsYet')}</div>;

  return (
    <div className="data-table-wrap">
      <table className="data-table mb-table">
        <thead>
          <tr className="mbv-grouphdr">
            <th className="mb-sticky-col" rowSpan={2}>
              {t('colStudent')}
            </th>
            <th className="mbv-subjh" rowSpan={2}>
              {t('colSubject')}
            </th>
            {groups.map((g) => (
              <th key={`g-${g.type}`} colSpan={g.cols.length} className="mbv-typeband">
                {g.type || t('typeNone')}
                <span className="mbv-bandcount">{t('typeBandCount', { count: g.cols.length })}</span>
              </th>
            ))}
            <th className="mbv-subcol" rowSpan={2}>
              {t('colSubjectTotal')}
            </th>
            <th className="mb-sum-col" colSpan={4} rowSpan={2}>
              {t('summaryGroup')}
            </th>
          </tr>
          <tr>
            {groups.map((g) => (
              <Fragment key={`h-${g.type}`}>
                {g.cols.map((c) => (
                  <th key={`${g.type}__${c.all[0]?.id ?? c.base}`} className="mb-col-head">
                    {/* 表头只写考核项名（不含科目）—— 科目已经在行上；悬停告诉它涵盖哪几个学科 */}
                    <div
                      className="mb-col-name"
                      title={c.wf.items.map((i) => i.subject || t('subjectNone')).join('、')}
                    >
                      {c.base}
                    </div>
                    <div
                      className="mb-col-sub"
                      title={
                        c.wf.same
                          ? undefined
                          : c.wf.items
                              .map(
                                (i) =>
                                  `${i.subject || t('subjectNone')}：${t('colWeightFull', {
                                    weight: i.weight,
                                    full: i.fullMark,
                                  })}`,
                              )
                              .join('\n')
                      }
                    >
                      {/* 归并后一列可能对应多科目，权重/满分不一致时不敢写一个具体值 */}
                      {c.wf.same
                        ? t('colWeightFull', { weight: c.wf.weight, full: c.wf.fullMark })
                        : t('colWeightVaries')}
                    </div>
                    <ColumnOps
                      cols={c.all}
                      onEdit={p.onEditColumn}
                      onRemove={p.onRemoveColumn}
                      onEditMany={p.onEditColumns}
                      onRemoveMany={p.onRemoveColumns}
                    />
                  </th>
                ))}
              </Fragment>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const sum = p.summaryOf(r.studentId);
            return (
              <tr key={`${r.studentId}__${r.subject}`} className={r.firstOfStudent ? 'mbv-firstrow' : undefined}>
                {r.firstOfStudent ? (
                  <td className="mb-sticky-col" rowSpan={r.span}>
                    <StudentCell name={r.name} enName={r.enName} />
                  </td>
                ) : null}
                <td className="mbv-subjcell">
                  <SubjectTag subject={r.subject} />
                </td>
                {groups.map((g) => (
                  <Fragment key={`b-${g.type}`}>
                    {g.cols.map((c) => {
                      const col = c.bySubject.get(r.subject);
                      return (
                        <td key={`${g.type}__${c.all[0]?.id ?? c.base}`} className="mb-cell">
                          {col ? (
                            <CellBox
                              value={p.cellValue(col.id, r.studentId)}
                              dirty={p.isDirty(col.id, r.studentId)}
                              onChange={(v) => p.onCellChange(col.id, r.studentId, v)}
                            />
                          ) : (
                            /* 这个学科没给该考核项建列（不是「没录分」）：不可编辑，且说明为什么 */
                            <span
                              className="mbv-ro mbv-ro-empty"
                              title={t('cellNoColumnForSubject', {
                                subject: r.subject || t('subjectNone'),
                              })}
                            >
                              —
                            </span>
                          )}
                        </td>
                      );
                    })}
                  </Fragment>
                ))}
                <td className="mbv-subcol">
                  <ReadOnlyBox value={subjSum.get(`${r.studentId}__${r.subject}`)?.weighted ?? null} tone="sub" />
                  <div className="mbv-ro-sub">{subjSum.get(`${r.studentId}__${r.subject}`)?.level || ''}</div>
                </td>
                {r.firstOfStudent ? (
                  <td className="mb-sum-col mb-total" rowSpan={r.span}>
                    {sum?.total == null ? '—' : sum.total}
                  </td>
                ) : null}
                {r.firstOfStudent ? (
                  <td className="mb-sum-col" rowSpan={r.span}>
                    {sum?.level ? (
                      <span className={sum.concern ? 'dept-status dept-status-inactive' : 'dept-status dept-status-ok'}>
                        {sum.level}
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                ) : null}
                {r.firstOfStudent ? (
                  <td className="mb-sum-col" rowSpan={r.span}>
                    <TargetBadge sum={sum} />
                  </td>
                ) : null}
                {r.firstOfStudent ? (
                  <td className="mb-sum-col muted" rowSpan={r.span} style={{ fontSize: 11 }}>
                    {t('summaryFilled', { count: sum?.filled ?? 0 })}
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="mbv-foot">{t('footNoteSubjectRows')}</div>
    </div>
  );
}

export function MarkbookView(props: GridViewProps & { view: MarkbookViewKey }) {
  const { view, ...rest } = props;
  if (view === 'transposed') return <TransposedView {...rest} />;
  if (view === 'subjectCols') return <SubjectColsView {...rest} />;
  if (view === 'subjectRows') return <SubjectRowsView {...rest} />;
  return <FlatView {...rest} />;
}
