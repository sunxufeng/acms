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
        if (alive) setSubjectOptions(all['授课科目'] ?? []);
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
                                /**
                                 * 用 text 而不是 decimal：格子里除了数字，还要能录
                                 * `85%` / `B`（字母等级）/ `*`（免考）/ `缺`（缺考）（2026-09-20）。
                                 * 限成数字键盘会让移动端根本打不出这些写法。
                                 */
                                inputMode="text"
                                value={v}
                                placeholder="—"
                                title={t('cellInputHint')}
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
                          {(() => {
                            /**
                             * 🔴 「有目标」的判据从「目标等级名非空」放宽为「三样里任意一样有值」
                             * （2026-09-20 修）。原因：「学生成绩目标」页的表单只有
                             * **目标分 + 目标等级序号**，`目标等级`（名字）那个字段**没有录入入口** ⇒
                             * 老师设好目标后这里永远显示「未设置」（且达标其实已经算出来了，等于白算）。
                             * 后端现在会按序号反查等级名，所以正常情况有名字；这里再兜一层
                             * 「只有序号」或「只有分数」的写法。
                             */
                            const hasTarget =
                              !!sum &&
                              (sum.targetLevel !== '' || sum.targetOrder != null || sum.targetScore != null);
                            if (!hasTarget) return <span className="muted">{t('noTarget')}</span>;
                            const label =
                              sum!.targetLevel ||
                              (sum!.targetOrder != null
                                ? t('targetOrderShort', { n: sum!.targetOrder })
                                : '');
                            const scoreText =
                              sum!.targetScore != null ? t('targetScoreLabel', { score: sum!.targetScore }) : '';
                            /**
                             * 目标序号不在该生的等级体系里 ⇒ **永远判不出达标**
                             * （判定是「实际等级序号 ≤ 目标序号」，序号非法则必然为假）。
                             * 生产实测：体系序号是 10/15/…/60（A 最好 = 10），有人填了 1。
                             * 这种「数据非法但接口一切正常」的情况必须在格子里说出来，
                             * 否则老师只会看到「一直未达标」而以为系统算错。
                             */
                            const outOfRange = sum!.targetOrderKnown === false;
                            const text = [
                              label,
                              outOfRange ? t('targetOrderUnknown') : '',
                              scoreText,
                            ]
                              .filter(Boolean)
                              .join(' · ');
                            return (
                              <span
                                className={
                                  outOfRange
                                    ? 'dept-status dept-status-resigned'
                                    : sum!.attained === false
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
                          })()}
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
            /**
             * 🔴 `key` 必须有（2026-09-20 修）。
             *
             * 这个编辑器是**网格下方的内联面板**（`.mb-editor` 只是 `margin-top`，不是模态遮罩），
             * 所以用户可以在它打开时直接点**另一个列头上的「编辑」**、或点上方的「新建考核列」。
             * 没有 `key` 时 React 复用同一个组件实例 ⇒ `useState(col?.x)` 的初始值**只在首次挂载时算过**，
             * 面板里仍是上一列的内容（症状：改了列名/科目后，编辑框里显示的还是别的列）。
             * 按列 id 给 key ⇒ 换列即重建，表单与所编辑的列永远一致。
             */
            key={editing.col?.id ?? '__new__'}
            cls={cls}
            col={editing.col}
            scales={grid?.scales ?? []}
            // 「科目」候选 = 字典「授课科目」（2026-09-20 改：原来取该班已有列，新班/新科目候选为空）
            subjects={subjectOptions}
            // 考核类型候选（带本班权重标注）—— 见页面顶部 typeOptions 的注释
            types={typeOptions}
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
  subjects,
  types,
  onClose,
  onSaved,
}: {
  cls: string;
  col: MarkbookColumn | null;
  scales: { id: string; name: string; isDefault: boolean }[];
  /**
   * 「科目」候选 = 字典「授课科目」的取值（页面上一次性从 `/dictionaries` 读）。
   * 必须从候选里选：科目是**期末总评拆分的键**，手打写岔会让总评按科目拆成两份且不报错。
   */
  subjects: string[];
  /**
   * 考核类型候选（value=类型名，label 里带本班权重）。
   * 必须从候选里选：类型名是**与权重/颜色/计入总评逐字匹配**的键，
   * 手打错一个字，那一列的权重与「是否计入期末」就双双静默失效。
   */
  types: { value: string; label: string }[];
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const t = useTranslations('markbook');
  const [name, setName] = useState(col?.name ?? '');
  const [type, setType] = useState(col?.type ?? '');
  const [subject, setSubject] = useState(col?.subject ?? '');
  const [weight, setWeight] = useState(String(col?.weight ?? 1));
  const [fullMark, setFullMark] = useState(String(col?.fullMark ?? 100));
  const [scaleId, setScaleId] = useState(col?.scaleId ?? '');
  const [date, setDate] = useState(col?.date ?? '');
  const [sort, setSort] = useState(String(col?.sort ?? 0));
  // 描述要从原值回填：不回填的话「改个权重」会把备注一起清掉（后端已改为未传不覆盖，
  // 这里再补上回显，两头都对）
  const [desc, setDesc] = useState(col?.desc ?? '');
  const [status, setStatus] = useState(col?.status ?? '启用');
  /**
   * 可见性与「完成闸门」（2026-09-20 补录入项）。
   *
   * 三个值的语义（判据在 apps/api/src/portal/portal-visibility.ts，写死不可改）：
   *  - 空串 = **未设置**（学生/家长都看不到）—— 只有显式选「是」才公开，
   *    所以别把空串当「是」，也别把它当「否」。
   *  - 完成日期（闸门）= 到达该日期前**不对家长**开放；留空 = 不设闸门（立即开放）。
   *    学生侧不看闸门（闸门只拦家长）。
   */
  const [studentVisible, setStudentVisible] = useState(col?.studentVisible ?? '');
  const [parentVisible, setParentVisible] = useState(col?.parentVisible ?? '');
  const [completeDate, setCompleteDate] = useState(col?.completeDate ?? '');
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
        subject: subject.trim(),
        weight: Number(weight) || 1,
        fullMark: Number(fullMark) || 100,
        scaleId,
        date,
        desc,
        sort: Number(sort) || 0,
        status,
        // 这三个从 state 取（原先用 col?.xxx —— 表单里没有输入项，等于永远写回旧值）
        studentVisible,
        parentVisible,
        completeDate,
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
          {/* 🔴 必须是下拉：类型名与「成绩类型权重」「考核类型」表逐字匹配，
              手打错一个字 ⇒ 该列的权重与「是否计入期末」双双静默失效（不报错）。 */}
          <select className="form-input" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">{t('fTypeNone')}</option>
            {/* 编辑既有列时，若该类型已被停用/删除而不在候选里，补一项，避免显示成「未指定」 */}
            {type && !types.some((o) => o.value === type) ? (
              <option value={type}>{`${type}（${t('fTypeMissing')}）`}</option>
            ) : null}
            {types.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {types.length === 0 ? (
            <span className="mb-meta">{t('fTypeEmpty')}</span>
          ) : (
            <span className="mb-meta">{t('fTypeHint')}</span>
          )}
          {/*
            类型留空不阻断保存，但必须把后果说清：结转时该列将按**权重 1** 计入期末总评，
            老师会看到「总评怎么被这一列影响了」却找不到原因 —— 这类不报错的后果一律显式提示。
          */}
          {type === '' && types.length > 0 && !col ? (
            <span style={{ color: 'var(--warning)', fontSize: 'var(--font-xs)' }}>{t('fTypeWarn')}</span>
          ) : null}
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
        {/* ── 科目（2026-09-20 补）：期末总评按它拆科目，缺了就没法按科目合成 ── */}
        <label className="mb-field">
          <span>{t('fSubject')}</span>
          {/* 🔴 必须是下拉（2026-09-20 改）：科目是**期末总评拆分的键**（学生 × 批次 × 科目），
              自由文本写岔（「数学」/「数学课」）会让总评拆成两份，而且不报错。
              候选读字典「授课科目」—— 字典里维护一处，所有班统一。 */}
          <select className="form-input" value={subject} onChange={(e) => setSubject(e.target.value)}>
            <option value="">{t('fSubjectNone')}</option>
            {/* 编辑既有列时，若该科目已不在字典里（被改名/删除），补一项，避免显示成「未指定」 */}
            {subject && !subjects.includes(subject) ? (
              <option value={subject}>{`${subject}（${t('fSubjectMissing')}）`}</option>
            ) : null}
            {subjects.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          {subjects.length === 0 ? (
            <span className="mb-meta">{t('fSubjectEmpty')}</span>
          ) : (
            <span className="mb-meta">{t('fSubjectHint')}</span>
          )}
        </label>
        {/* ── 可见性与完成闸门（2026-09-20 补）：三态各一档，空串 = 未设置（都不公开） ── */}
        <label className="mb-field">
          <span>{t('fStudentVisible')}</span>
          <select
            className="form-input"
            value={studentVisible}
            onChange={(e) => setStudentVisible(e.target.value)}
          >
            <option value="">{t('visibleUnset')}</option>
            <option value="是">{t('visibleYes')}</option>
            <option value="否">{t('visibleNo')}</option>
          </select>
        </label>
        <label className="mb-field">
          <span>{t('fParentVisible')}</span>
          <select className="form-input" value={parentVisible} onChange={(e) => setParentVisible(e.target.value)}>
            <option value="">{t('visibleUnset')}</option>
            <option value="是">{t('visibleYes')}</option>
            <option value="否">{t('visibleNo')}</option>
          </select>
        </label>
        <label className="mb-field">
          <span>{t('fCompleteDate')}</span>
          <input
            className="form-input"
            type="date"
            value={completeDate.slice(0, 10)}
            onChange={(e) => setCompleteDate(e.target.value)}
          />
        </label>
        <label className="mb-field mb-field-wide">
          <span>{t('fDesc')}</span>
          <input className="form-input" value={desc} onChange={(e) => setDesc(e.target.value)} />
        </label>
        {col ? (
          <div className="mb-field mb-field-wide">
            <span>{t('fHomework')}</span>
            <span className="muted">
              {col.homeworkName ? col.homeworkName : t('homeworkUnbound')}
              {' · '}
              {t('homeworkBindHint')}
            </span>
          </div>
        ) : null}
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
