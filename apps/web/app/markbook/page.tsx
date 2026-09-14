'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  api,
  type MarkbookClassOption,
  type MarkbookColumn,
  type MarkbookGrid,
  type MarkbookSaveRow,
} from '../../lib/api';
import HomeworkSyncPanel from '../../components/markbook/HomeworkSyncPanel';

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
  /** 列编辑：null=关闭，{col:null}=新建 */
  const [editing, setEditing] = useState<{ col: MarkbookColumn | null } | null>(null);

  const loadClasses = useCallback(async () => {
    const list = await api.markbookClasses();
    setClasses(list);
    setCls((cur) => (cur && list.some((c) => c.cls === cur) ? cur : (list[0]?.cls ?? '')));
  }, []);

  useEffect(() => {
    void loadClasses().catch(() => setClasses([]));
  }, [loadClasses]);

  const loadGrid = useCallback(async (c: string) => {
    if (!c) {
      setGrid(null);
      return;
    }
    setLoading(true);
    try {
      setGrid(await api.markbookGrid(c));
      setDirty(new Map());
    } catch {
      setGrid(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadGrid(cls);
  }, [cls, loadGrid]);

  /** 单元格当前值：未保存改动优先，否则取服务端值 */
  const cellText = (columnId: string, studentId: string): string => {
    const k = `${columnId}__${studentId}`;
    if (dirty.has(k)) return dirty.get(k)!;
    const c = cellMap.get(k);
    return c?.score == null ? '' : String(c.score);
  };

  const cellMap = useMemo(() => {
    const m = new Map<string, { score: number | null; level: string; concern: boolean; attained: string }>();
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
        return { columnId, studentId, score: trimmed === '' ? null : Number(trimmed) };
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

        <div className="mb-toolbar">
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
          <button className="btn btn-outline" onClick={() => setEditing({ col: null })} disabled={!cls}>
            {t('newColumn')}
          </button>
        </div>

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
            <div className="dept-card-head">
              <span className="dept-card-title">{t('gridTitle', { cls })}</span>
              <span className="dept-card-meta">{t('weightNote')}</span>
            </div>
            <div className="data-table-wrap">
              <table className="data-table mb-table">
                <thead>
                  <tr>
                    <th className="mb-sticky-col">{t('colStudent')}</th>
                    {grid.columns.map((c) => (
                      <th key={c.id} className="mb-col-head">
                        <div className="mb-col-name" title={`${c.type ? c.type + ' · ' : ''}权重 ${c.weight} · 满分 ${c.fullMark}`}>
                          {c.name}
                        </div>
                        <div className="mb-col-sub">
                          {c.type ? `${c.type} · ` : ''}
                          {t('colWeightFull', { weight: c.weight, full: c.fullMark })}
                        </div>
                        <div className="mb-col-ops">
                          <button type="button" className="link-btn" onClick={() => setEditing({ col: c })}>
                            {t('edit')}
                          </button>
                          <button type="button" className="link-btn" onClick={() => void removeColumn(c)}>
                            {t('delete')}
                          </button>
                        </div>
                      </th>
                    ))}
                    <th className="mb-sum-col">{t('colTotal')}</th>
                    <th className="mb-sum-col">{t('colLevel')}</th>
                    <th className="mb-sum-col">{t('colTarget')}</th>
                  </tr>
                </thead>
                <tbody>
                  {grid.students.map((s) => {
                    const sum = summaryMap.get(s.id);
                    return (
                      <tr key={s.id}>
                        <td className="mb-sticky-col">
                          <div className="dept-emp-name">{s.name}</div>
                          {s.enName ? <div className="dept-emp-sub">{s.enName}</div> : null}
                        </td>
                        {grid.columns.map((c) => {
                          const v = cellText(c.id, s.id);
                          const isDirty = dirty.has(`${c.id}__${s.id}`);
                          return (
                            <td key={c.id} className="mb-cell">
                              <input
                                className={`form-input mb-input${isDirty ? ' mb-input-dirty' : ''}`}
                                inputMode="decimal"
                                value={v}
                                placeholder="—"
                                onChange={(e) => onCellChange(c.id, s.id, e.target.value)}
                              />
                            </td>
                          );
                        })}
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
                          {sum?.targetLevel ? (
                            <span
                              className={
                                sum.attained === false
                                  ? 'dept-status dept-status-resigned'
                                  : sum.attained === true
                                    ? 'dept-status dept-status-ok'
                                    : 'dept-status'
                              }
                              title={
                                sum.attained === false
                                  ? t('belowTarget')
                                  : sum.attained === true
                                    ? t('atTarget')
                                    : t('noTarget')
                              }
                            >
                              {sum.targetLevel}
                              {sum.attained === false ? ' ↓' : ''}
                            </span>
                          ) : (
                            <span className="muted">{t('noTarget')}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="mb-foot">
              {t('footNote', {
                levels: grid.levels.length,
                scales: grid.scales.map((x) => x.name).join(' / ') || t('noneScale'),
              })}
            </div>
          </div>
        )}

        {editing && cls && (
          <ColumnEditor
            cls={cls}
            col={editing.col}
            scales={grid?.scales ?? []}
            onClose={() => setEditing(null)}
            onSaved={async () => {
              setEditing(null);
              await loadGrid(cls);
            }}
          />
        )}

        {/* ── 作业 → 成绩册同步 ──────────────────────────────────────────
            放在网格下方：它的产出就是上面那些格子，同步完直接看得到。
            ⚠️ 有未保存改动时**不渲染面板**：同步成功后要 reload 网格，
               而 reload 会丢弃 dirty 里的编辑 —— 先用一条提示挡一下，避免白录。 */}
        {cls && grid && grid.students.length > 0
          ? dirtyCount > 0
            ? <div className="notice notice-info">{t('hwDirtyBlock', { count: dirtyCount })}</div>
            : (
              <HomeworkSyncPanel
                cls={cls}
                columns={grid.columns}
                loadCatalog={api.markbookHomeworkCatalog}
                loadPreview={api.markbookSyncHomeworkPreview}
                runSync={api.markbookSyncHomework}
                bindHomework={api.markbookHomeworkBind}
                onSynced={() => loadGrid(cls)}
              />
            )
          : null}
      </div>
    </div>
  );
}

/** 列编辑（新建 / 修改）—— 用标准卡片 + .form-grid，不引第三方弹窗 */
function ColumnEditor({
  cls,
  col,
  scales,
  onClose,
  onSaved,
}: {
  cls: string;
  col: MarkbookColumn | null;
  scales: { id: string; name: string; isDefault: boolean }[];
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const t = useTranslations('markbook');
  const [name, setName] = useState(col?.name ?? '');
  const [type, setType] = useState(col?.type ?? '');
  const [weight, setWeight] = useState(String(col?.weight ?? 1));
  const [fullMark, setFullMark] = useState(String(col?.fullMark ?? 100));
  const [scaleId, setScaleId] = useState(col?.scaleId ?? '');
  const [date, setDate] = useState(col?.date ?? '');
  const [sort, setSort] = useState(String(col?.sort ?? 0));
  const [desc, setDesc] = useState('');
  const [status, setStatus] = useState(col?.status ?? '启用');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async () => {
    if (!name.trim()) {
      setErr(t('nameRequired'));
      return;
    }
    setBusy(true);
    setErr('');
    try {
      await api.markbookSaveColumn({
        id: col?.id,
        cls,
        name: name.trim(),
        type,
        weight: Number(weight) || 1,
        fullMark: Number(fullMark) || 100,
        scaleId,
        date,
        desc,
        sort: Number(sort) || 0,
        status,
        studentVisible: col?.studentVisible ?? '',
        parentVisible: col?.parentVisible ?? '',
        completeDate: col?.completeDate ?? '',
      });
      await onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card mb-editor">
      <div className="dept-card-head">
        <span className="dept-card-title">{col ? t('editColumn', { name: col.name }) : t('newColumn')}</span>
        <span className="dept-card-meta">{t('weightNote')}</span>
      </div>
      <div className="form-grid mb-editor-body">
        <label className="mb-field">
          <span>{t('fName')}</span>
          <input className="form-input" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="mb-field">
          <span>{t('fType')}</span>
          <input
            className="form-input"
            placeholder={t('fTypeHint')}
            value={type}
            onChange={(e) => setType(e.target.value)}
          />
        </label>
        <label className="mb-field">
          <span>{t('fWeight')}</span>
          <input className="form-input" inputMode="decimal" value={weight} onChange={(e) => setWeight(e.target.value)} />
        </label>
        <label className="mb-field">
          <span>{t('fFullMark')}</span>
          <input className="form-input" inputMode="decimal" value={fullMark} onChange={(e) => setFullMark(e.target.value)} />
        </label>
        <label className="mb-field">
          <span>{t('fScale')}</span>
          <select className="form-input" value={scaleId} onChange={(e) => setScaleId(e.target.value)}>
            <option value="">{t('scaleDefault')}</option>
            {scales.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="mb-field">
          <span>{t('fDate')}</span>
          <input className="form-input" type="date" value={date.slice(0, 10)} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="mb-field">
          <span>{t('fSort')}</span>
          <input className="form-input" inputMode="numeric" value={sort} onChange={(e) => setSort(e.target.value)} />
        </label>
        <label className="mb-field">
          <span>{t('fStatus')}</span>
          <select className="form-input" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="启用">{t('enabled')}</option>
            <option value="停用">{t('disabled')}</option>
          </select>
        </label>
        <label className="mb-field mb-field-wide">
          <span>{t('fDesc')}</span>
          <input className="form-input" value={desc} onChange={(e) => setDesc(e.target.value)} />
        </label>
      </div>
      {err ? <div className="notice notice-error mb-editor-msg">{err}</div> : null}
      <div className="mb-editor-foot">
        <button className="btn btn-outline" onClick={onClose} disabled={busy}>
          {t('cancel')}
        </button>
        <button className="btn btn-primary" onClick={() => void submit()} disabled={busy}>
          {busy ? t('saving') : t('confirm')}
        </button>
      </div>
    </div>
  );
}
