'use client';

import { Fragment, type CSSProperties, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

/**
 * 作业同步面板 —— 把「作业的完成情况」写进「成绩册」，教师不用再手工重录一遍。
 *
 * 为什么是独立组件而不是塞进 app/markbook/page.tsx：
 *   成绩册页是二维录入网格，任何改动都要连带回归「脏值暂存 / 批量保存 / 列编辑」三块交互；
 *   而作业同步是一个自包含的小流程（选班 → 选作业 → 预览 → 确认）。
 *   做成独立组件后，成绩册页只需插一行 + 一个 reload 回调（接入片段见交付报告）。
 *
 * ⚠️ 这个组件**不 import lib/api.ts**（该文件由主控统一合并）：
 *   四个数据访问函数全部通过 props 注入，形状就是 api.ts 里追加的那几个方法，
 *   所以合并时不需要改组件、页面直接 `<HomeworkSyncPanel ... loadCatalog={api.markbookHomeworkCatalog} />` 即可。
 *
 * 三条与后端对齐的硬约束（改前端前先读 apps/api/src/markbook/homework-link.logic.ts 的文件头）：
 *   1. **未完成 / 无提交 ⇒ 留空，不写 0**。成绩册的加权总评是自归一化的（分母只算已录入项），
 *      写 0 是「参与了但得 0 分」，会把总评实打实拉低 —— 和「未参与」完全是两回事。
 *   2. **预览与写入共用同一份计划器**，所以「预览到什么」=「同步后写什么」，不存在两套口径。
 *   3. 批量写成绩**不能盲写**：必须先预览（差异表）才能点「确认同步」，「确认」按钮在预览前是禁用的。
 *
 * 样式一律复用全站标准类（.card / .data-table / .btn / .form-input / .notice / .dept-status / .mb-*），
 * 颜色全部走 CSS 变量，不写死色值（暗色/浅色主题自动跟随）。
 */

// ── 与后端 homework-sync.service.ts / homework-link.logic.ts 一一对应的数据形状 ──

export type SyncMode = 'fill-empty' | 'overwrite';
export type SyncReason = '已完成' | '未完成留空' | '无提交' | '已存在将跳过';

export interface HomeworkOption {
  homeworkName: string;
  /** 已完成人数 */
  done: number;
  /** 应完成人数（该班在读学生数） */
  total: number;
  /** 追踪表里实际有记录的人数（< total 说明教师还没记全） */
  tracked: number;
  rate: number;
  /** 已绑定的考核列（空串 = 还没绑） */
  columnId: string;
  columnName: string;
}

export interface HomeworkSyncRow {
  studentId: string;
  studentName: string;
  /** 成绩册里的当前值（null = 空格子） */
  current: number | null;
  /** 计划写入的值（null = 留空） */
  next: number | null;
  reason: SyncReason;
  source: 'submission' | 'full-mark' | '';
  willWrite: boolean;
  willOverwrite: boolean;
  willClear: boolean;
  late: string;
  note: '' | 'clamped' | 'zero-not-graded';
}

export interface HomeworkSyncPreview {
  cls: string;
  homeworkName: string;
  columnId: string;
  columnName: string;
  fullMark: number;
  mode: SyncMode;
  done: number;
  total: number;
  rate: number;
  scanned: number;
  filled: number;
  overwritten: number;
  cleared: number;
  skipped: number;
  blank: number;
  rows: HomeworkSyncRow[];
}

export interface HomeworkSyncResult extends HomeworkSyncPreview {
  /** 实际发给成绩册写入口的行数（含清空） */
  saved: number;
}

export interface HomeworkSyncQuery {
  cls: string;
  homeworkName: string;
  columnId?: string;
  mode?: SyncMode;
}

/** 成绩册页已有的列（只需这三个字段，直接传 grid.columns 即可） */
export interface HomeworkSyncColumn {
  id: string;
  name: string;
  homeworkName?: string;
  homework?: { done: number; total: number; rate: number };
}

export interface HomeworkSyncPanelProps {
  /** 当前班级（成绩册页的班级下拉值）；空则渲染提示 */
  cls: string;
  /** 该班的考核列（成绩册页的 grid.columns），用于绑定与目标列展示 */
  columns: HomeworkSyncColumn[];
  /** 该班可选作业（GET /markbook/homework-catalog?cls=） */
  loadCatalog: (cls: string) => Promise<HomeworkOption[]>;
  /** 预览（GET /markbook/sync-homework/preview） */
  loadPreview: (q: HomeworkSyncQuery) => Promise<HomeworkSyncPreview>;
  /** 执行同步（POST /markbook/sync-homework） */
  runSync: (b: HomeworkSyncQuery) => Promise<HomeworkSyncResult>;
  /** 绑定 / 解绑（POST /markbook/homework-bind，homeworkName 传空 = 解绑） */
  bindHomework: (b: { cls: string; columnId: string; homeworkName: string }) => Promise<unknown>;
  /** 同步成功后的回调（成绩册页应在这里 reload 网格） */
  onSynced?: () => void | Promise<void>;
  /**
   * 是否嵌在弹出框里（2026-09-20 起成绩册页用按钮 + 弹出框承载本面板）。
   * 为真时不套自身的 card 外壳与标题（弹窗已有标题），改显示四步指示条。
   */
  inModal?: boolean;
}

/** 原因 → i18n key（**不直接显示后端返回的中文值**，那是机器码，要跟着语言切换） */
const REASON_KEY: Record<SyncReason, string> = {
  已完成: 'reasonDone',
  未完成留空: 'reasonNotDone',
  无提交: 'reasonNoSubmission',
  已存在将跳过: 'reasonSkipExisting',
};

/** 原因 → 状态色（复用全站 .dept-status-* 类，不新造颜色） */
const REASON_CLASS: Record<SyncReason, string> = {
  已完成: 'dept-status dept-status-ok',
  未完成留空: 'dept-status dept-status-resigned',
  无提交: 'dept-status dept-status-resigned',
  已存在将跳过: 'dept-status dept-status-inactive',
};

// 只做布局，颜色一律来自标准类（对照 acms-new-page-style 的「样式单一来源」）
const rowStyle: CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 'var(--space-md)' };
const growStyle: CSSProperties = { minWidth: 180, flex: '1 1 180px' };
const summaryStyle: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 'var(--space-md)', marginTop: 'var(--space-sm)' };
const nowrapStyle: CSSProperties = { whiteSpace: 'nowrap' };

export default function HomeworkSyncPanel({
  cls,
  columns,
  loadCatalog,
  loadPreview,
  runSync,
  bindHomework,
  onSynced,
  inModal = false,
}: HomeworkSyncPanelProps) {
  const t = useTranslations('markbook');

  const [catalog, setCatalog] = useState<HomeworkOption[]>([]);
  const [homeworkName, setHomeworkName] = useState('');
  const [mode, setMode] = useState<SyncMode>('fill-empty');
  const [preview, setPreview] = useState<HomeworkSyncPreview | null>(null);
  const [bindTarget, setBindTarget] = useState('');
  const [busy, setBusy] = useState<'catalog' | 'preview' | 'sync' | 'bind' | ''>('');
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  // 换班级 → 重新拉作业目录，并清掉上一个班的选中项与预览（否则会把 A 班的预览误当成 B 班的）
  const reloadCatalog = useCallback(
    async (c: string) => {
      if (!c) {
        setCatalog([]);
        return;
      }
      setBusy('catalog');
      try {
        const list = await loadCatalog(c);
        setCatalog(list);
        setHomeworkName((cur) => (cur && list.some((x) => x.homeworkName === cur) ? cur : (list[0]?.homeworkName ?? '')));
      } catch (e) {
        setCatalog([]);
        setMsg({ tone: 'error', text: `${t('hwCatalogFailed')}：${(e as Error).message}` });
      } finally {
        setBusy('');
      }
    },
    [loadCatalog, t],
  );

  useEffect(() => {
    setPreview(null);
    setMsg(null);
    setBindTarget('');
    void reloadCatalog(cls);
  }, [cls, reloadCatalog]);

  const current = useMemo(
    () => catalog.find((x) => x.homeworkName === homeworkName) ?? null,
    [catalog, homeworkName],
  );
  const boundColumn = useMemo(
    () => (current?.columnId ? (columns.find((c) => c.id === current.columnId) ?? null) : null),
    [columns, current],
  );

  /** 没绑定列时，预选一个「正在编辑的作业」列的候选（优先选列名相同、且未绑定别家作业的） */
  useEffect(() => {
    if (current?.columnId) {
      setBindTarget(current.columnId);
      return;
    }
    setBindTarget((cur) => (cur && columns.some((c) => c.id === cur) ? cur : ''));
  }, [current, columns]);

  const doBind = async () => {
    if (!cls || !bindTarget) return;
    setBusy('bind');
    setMsg(null);
    try {
      await bindHomework({ cls, columnId: bindTarget, homeworkName });
      setMsg({ tone: 'ok', text: t('hwBindDone') });
      setPreview(null);
      await reloadCatalog(cls);
      await onSynced?.();
    } catch (e) {
      setMsg({ tone: 'error', text: `${t('hwBindFailed')}：${(e as Error).message}` });
    } finally {
      setBusy('');
    }
  };

  /** 解绑：homeworkName 传空串（后端约定：空 = 解绑） */
  const doUnbind = async (columnId: string) => {
    if (!cls) return;
    setBusy('bind');
    setMsg(null);
    try {
      await bindHomework({ cls, columnId, homeworkName: '' });
      setMsg({ tone: 'ok', text: t('hwUnbindDone') });
      setPreview(null);
      await reloadCatalog(cls);
      await onSynced?.();
    } catch (e) {
      setMsg({ tone: 'error', text: `${t('hwBindFailed')}：${(e as Error).message}` });
    } finally {
      setBusy('');
    }
  };

  const doPreview = async () => {
    if (!cls || !homeworkName) return;
    setBusy('preview');
    setMsg(null);
    try {
      const p = await loadPreview({ cls, homeworkName, columnId: current?.columnId || undefined, mode });
      setPreview(p);
    } catch (e) {
      setPreview(null);
      setMsg({ tone: 'error', text: `${t('hwPreviewFailed')}：${(e as Error).message}` });
    } finally {
      setBusy('');
    }
  };

  const doSync = async () => {
    if (!cls || !homeworkName || !preview) return;
    setBusy('sync');
    setMsg(null);
    try {
      const r = await runSync({ cls, homeworkName, columnId: preview.columnId, mode });
      setMsg({
        tone: 'ok',
        text: t('hwSyncDone', {
          filled: r.filled,
          overwritten: r.overwritten,
          cleared: r.cleared,
          skipped: r.skipped,
          blank: r.blank,
        }),
      });
      // 写完立刻重取预览：用户能直接看到「再同步一次应当是 0 新增」（幂等）
      setPreview(r);
      await reloadCatalog(cls);
      await onSynced?.();
    } catch (e) {
      setMsg({ tone: 'error', text: `${t('hwSyncFailed')}：${(e as Error).message}` });
    } finally {
      setBusy('');
    }
  };

  if (!cls) {
    return (
      <div className={inModal ? 'mb-hw' : 'card mb-editor'}>
        {inModal ? null : (
          <div className="dept-card-head">
            <span className="dept-card-title">{t('hwSyncTitle')}</span>
          </div>
        )}
        <div className="mb-editor-body muted">{t('hwNeedClass')}</div>
      </div>
    );
  }

  /** 预览结果里真正会动的行排前面，用户先看要改的 */
  const rows = preview?.rows ?? [];
  const changed = rows.filter((r) => r.willWrite || r.willClear);

  /**
   * 当前走到哪一步（只是提示，不拦操作）—— 让「先预览后确认」这件事看得见：
   * 以前这四步是一段文字说明，埋在网格最下面，老师根本不会读。
   */
  const step = !homeworkName ? 1 : !boundColumn ? 2 : !preview ? 3 : 4;

  return (
    <div className={inModal ? 'mb-hw' : 'card mb-editor'}>
      {inModal ? (
        <div className="mb-steps">
          {[1, 2, 3, 4].map((n, i) => (
            <Fragment key={n}>
              {i ? <span className="mb-steps-sep">›</span> : null}
              <span className={n <= step ? 'mb-step on' : 'mb-step'}>
                <i>{n}</i>
                {t(`hwStep${n}`)}
              </span>
            </Fragment>
          ))}
        </div>
      ) : (
        <div className="dept-card-head">
          <span className="dept-card-title">{t('hwSyncTitle')}</span>
          <span className="dept-card-meta">{t('hwSyncSubtitle')}</span>
        </div>
      )}

      <div className="mb-editor-body">
        <div style={rowStyle}>
          <label className="mb-field" style={growStyle}>
            <span>{t('hwHomeworkLabel')}</span>
            <select
              className="form-input"
              value={homeworkName}
              onChange={(e) => {
                setHomeworkName(e.target.value);
                setPreview(null);
                setMsg(null);
              }}
              disabled={busy === 'catalog' || catalog.length === 0}
            >
              {catalog.length === 0 && <option value="">{t('hwNoHomework')}</option>}
              {catalog.map((o) => (
                <option key={o.homeworkName} value={o.homeworkName}>
                  {t('hwOption', { name: o.homeworkName, done: o.done, total: o.total })}
                </option>
              ))}
            </select>
          </label>

          <label className="mb-field" style={growStyle}>
            <span>{t('hwMode')}</span>
            <select
              className="form-input"
              value={mode}
              onChange={(e) => {
                setMode(e.target.value === 'overwrite' ? 'overwrite' : 'fill-empty');
                setPreview(null);
              }}
            >
              <option value="fill-empty">{t('hwModeFillEmpty')}</option>
              <option value="overwrite">{t('hwModeOverwrite')}</option>
            </select>
          </label>

          <span className="mb-meta" style={nowrapStyle}>
            {current ? t('hwCompletion', { done: current.done, total: current.total }) : ''}
            {current && current.tracked < current.total ? t('hwTrackedHint', { tracked: current.tracked }) : ''}
          </span>
        </div>

        <div className="mb-meta" style={{ marginTop: 4 }}>
          {mode === 'overwrite' ? t('hwModeOverwriteHint') : t('hwModeFillEmptyHint')}
        </div>

        {/* ── 绑定区：没绑就不让同步（后端也会报错，这里先给出可点的补救入口）── */}
        <div style={rowStyle}>
          {boundColumn ? (
            <>
              <span className="mb-meta">
                {t('hwBoundTo', { name: boundColumn.name })}
                {boundColumn.homework
                  ? ` · ${t('hwCompletion', { done: boundColumn.homework.done, total: boundColumn.homework.total })}`
                  : ''}
              </span>
              <button
                type="button"
                className="btn btn-outline"
                disabled={busy !== ''}
                onClick={() => void doUnbind(boundColumn.id)}
              >
                {busy === 'bind' ? t('hwBinding') : t('hwUnbind')}
              </button>
            </>
          ) : (
            <>
              <label className="mb-field" style={growStyle}>
                <span>{t('hwTargetColumn')}</span>
                <select className="form-input" value={bindTarget} onChange={(e) => setBindTarget(e.target.value)}>
                  <option value="">{t('hwPickColumn')}</option>
                  {columns
                    .filter((c) => !c.homeworkName || c.homeworkName === homeworkName)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                        {c.homeworkName ? t('hwColumnBusy', { name: c.homeworkName }) : ''}
                      </option>
                    ))}
                </select>
              </label>
              <button
                type="button"
                className="btn btn-outline"
                disabled={!bindTarget || busy !== ''}
                onClick={() => void doBind()}
              >
                {busy === 'bind' ? t('hwBinding') : t('hwBind')}
              </button>
              <span className="mb-meta">{t('hwBindHint')}</span>
            </>
          )}
        </div>

        <div style={{ ...rowStyle, marginTop: 'var(--space-md)' }}>
          <button
            type="button"
            className="btn btn-outline"
            disabled={!homeworkName || !boundColumn || busy !== ''}
            onClick={() => void doPreview()}
          >
            {busy === 'preview' ? t('hwPreviewing') : t('hwPreview')}
          </button>
          {/* 必须先预览才能写：批量写成绩不能盲写 */}
          <button
            type="button"
            className="btn btn-primary"
            disabled={!preview || busy !== '' || changed.length === 0}
            onClick={() => void doSync()}
          >
            {busy === 'sync'
              ? t('hwSyncing')
              : changed.length
                ? t('hwSyncWithCount', { count: changed.length })
                : t('hwNothingToWrite')}
          </button>
          {preview ? (
            <span className="mb-meta">
              {t('hwSummary', {
                scanned: preview.scanned,
                filled: preview.filled,
                overwritten: preview.overwritten,
                cleared: preview.cleared,
                skipped: preview.skipped,
                blank: preview.blank,
              })}
            </span>
          ) : (
            <span className="mb-meta">{t('hwPreviewFirst')}</span>
          )}
        </div>

        {msg && (
          <div className={msg.tone === 'ok' ? 'notice notice-ok' : 'notice notice-error'} style={{ marginTop: 'var(--space-md)' }}>
            {msg.text}
          </div>
        )}

        {preview && (
          <div className="data-table-wrap" style={{ marginTop: 'var(--space-md)' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('hwColStudent')}</th>
                  <th>{t('hwColCurrent')}</th>
                  <th>{t('hwColNext')}</th>
                  <th>{t('hwColReason')}</th>
                  <th>{t('hwColSource')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.studentId}>
                    <td>{r.studentName}</td>
                    <td>{r.current == null ? <span className="muted">—</span> : r.current}</td>
                    <td>
                      {r.willClear ? (
                        <span className="dept-status dept-status-inactive">{t('hwWillClear')}</span>
                      ) : r.willWrite ? (
                        <strong>{r.next}</strong>
                      ) : (
                        <span className="muted">{t('hwBlank')}</span>
                      )}
                      {r.late === '是' ? <span className="muted"> {t('hwLate')}</span> : null}
                    </td>
                    <td>
                      <span className={REASON_CLASS[r.reason]}>{t(REASON_KEY[r.reason])}</span>
                      {/* 分数来源 / 异常说明：折算规则不透明时用户不敢点同步 */}
                      {r.note === 'clamped' ? <span className="muted"> {t('hwNoteClamped')}</span> : null}
                      {r.note === 'zero-not-graded' ? <span className="muted"> {t('hwNoteZeroNotGraded')}</span> : null}
                    </td>
                    <td>
                      {r.source === 'submission'
                        ? t('hwSourceSubmission')
                        : r.source === 'full-mark'
                          ? t('hwSourceFullMark')
                          : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {preview ? (
          <div className="mb-meta" style={summaryStyle}>
            <span>{t('hwTargetColumnLabel', { name: preview.columnName, full: preview.fullMark })}</span>
            <span>{t('hwWeightNote')}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
