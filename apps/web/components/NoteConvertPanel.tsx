'use client';

import { useCallback, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useTranslations } from 'next-intl';
import type { NoteConvertTarget, NoteConvertLogItem } from '@acms/contracts';
import { STUDENT_RECORD_TYPE_FIELD } from '@acms/contracts';
import CrudPage, { recordTitleOf } from './CrudPage';
import { api } from '../lib/api';
import { convertFormFor, convertInitialExtras } from '../lib/convertForm';
import { useDeptMembers } from '../lib/useDeptMembers';
import { currentUserName } from '../lib/noteAutoFill';
import { humanizeError } from '../lib/errMsg';
import { audioOf, fmtDuration } from '../lib/getnoteNote';

export interface NoteConvertPanelProps {
  /** 笔记 id */
  noteId: string;
  /** 笔记标题（列表行的 title） */
  noteTitle: string;
  /** 笔记归属人（列表行的 `_owner`）——「记录人 / 负责人」的默认值取它 */
  noteOwner: string;
  /** 笔记创建时间（ms）——「时间」类字段的默认值取它 */
  noteCreatedAt: number;
  /** 已启用的转换目标（来自「后台管理 › 转换配置」） */
  targets: NoteConvertTarget[];
  /** 这条笔记每次转换成功的留痕（key = 模块 key） */
  logs: NoteConvertLogItem[];
  /** 页内不支持转换的模块：交回调用方走旧的「写预填 → 跳到新建页」流程 */
  onFallback: (target: NoteConvertTarget) => void;
  /** 保存成功并写完留痕后回调，让列表「已转」列刷新 */
  onLogged: (item: NoteConvertLogItem) => void;
  onClose: () => void;
}

type SaveResult = {
  label: string;
  recordId: string;
  detailHref: string;
  title: string;
  warn: string;
};

/**
 * 「我的笔记 → 转换」的**行内就地转换面板**（峰哥 2026-09-28 定稿）。
 *
 * ## 为什么改成行内
 *
 * 旧流程：点「转换」→ 弹窗选模块 → 写预填进 sessionStorage → **跳到目标模块的新建页** →
 * 填完保存 → 用户自己回「我的笔记」。转一条笔记要跳两次页。
 * 新流程：点「转换」→ **这一行下面直接展开** → 选目标 → 表单当场铺开（能填的都填好）→
 * 保存后**仍停在本页**、这条笔记仍是展开态，可以接着转成别的记录。
 *
 * ## 三段式
 *
 * ① 会带过去什么（总结/原始记录/录音 → 目标的哪个字段，主题/时间/记录人怎么来）
 * ② 转成哪种业务记录（「转换配置」里 enabled 的那些）
 * ③ 目标模块的表单 —— **由 CrudPage 的 `formOnly` 模式渲染**，字段定义、措辞、联动、
 *    字典候选全部复用该模块自己的那一份（见 lib/convertForm 的说明，别在这里拼字段）。
 *
 * ## 留痕：保存成功才记（峰哥 2026-09-28 要求）
 *
 * 旧实现是**点开转换就写一条**（哪怕最后没保存），于是「已转 N 次」会虚高。
 * 现在：`onSaved`（CrudPage 建完记录）之后才写留痕 + 回填「转成了哪条记录」+ 写笔记关联。
 * 代价是「归档笔记不许转换」这道闸门从「点转换时」挪到了「保存时」——
 * 按钮那一层仍然挡着（`openConvert` 里判 `isArchivedNote`），保存时后端还会再判一次 409。
 */
export default function NoteConvertPanel({
  noteId,
  noteTitle,
  noteOwner,
  noteCreatedAt,
  targets,
  logs,
  onFallback,
  onLogged,
  onClose,
}: NoteConvertPanelProps) {
  const t = useTranslations('getnote');

  /** 选中的目标模块；为空 = 停在「选类型」那一步 */
  const [target, setTarget] = useState<NoteConvertTarget | null>(null);
  /** 目标模块表单的初始值（点类型时算一次，之后不再变 —— 它是 CrudPage 的挂载入参） */
  const [initial, setInitial] = useState<Record<string, unknown> | null>(null);
  /** 学生记录：当前「记录类型」（决定列定义的措辞与显隐，由表单回吐） */
  const [studentType, setStudentType] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState<SaveResult | null>(null);
  /** 表单当前值（保存后写 entityName 用）；用 ref 存，改它不该触发重渲染 */
  const formRef = useRef<Record<string, unknown>>({});
  /** 笔记详情（总结 / 原始记录 / 录音）——只在选完目标后按需拉一次 */
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [reading, setReading] = useState(false);

  /**
   * 部门 → 成员：只有会议纪要要用（参会人员联动）。
   * 传 `false` 时 hook 一个接口都不打 —— 别的目标模块用不上这套数据。
   */
  const dept = useDeptMembers(target?.key === 'meetingMinutes');

  const targetKey = target?.key ?? '';

  /**
   * 目标模块的就地表单零件（列定义 + api + 预填增强 + 详情页路径）。
   * 🔴 必须 memo：`columns` 一旦每次渲染都是新数组，CrudPage 里几个依赖 `columns` 的
   *    effect 会**反复重跑**（学生名单是全量翻页拉的，重跑一次就是几十个请求）。
   */
  const parts = useMemo(() => {
    if (!targetKey) return null;
    return convertFormFor(targetKey, {
      me: '',
      studentType: studentType || undefined,
      deptMembers: dept.deptMembers,
      myDeptIds: dept.myDeptIds,
      manuallyRemoved: dept.manuallyRemoved,
    });
    // dept.* 的内部引用稳定（state/ref），只在真拉到时才变
  }, [targetKey, studentType, dept.deptMembers, dept.myDeptIds, dept.manuallyRemoved]);

  /** 带过去的内容（① 区展示用）：目标没配某个字段名就不显示那一颗 */
  const carried = useMemo(() => {
    if (!target) return [];
    const out: { text: string }[] = [];
    if (target.summaryField) out.push({ text: t('carrySummary', { field: target.summaryField }) });
    if (target.rawField) out.push({ text: t('carryRaw', { field: target.rawField }) });
    const a = audioOf(detail);
    if (a && target.audioField) {
      out.push({ text: t('carryAudio', { dur: fmtDuration(a.durationMs) || '—', field: target.audioField }) });
    }
    out.push({ text: t('carrySubject') });
    out.push({ text: t('carryTime', { time: fmtWhen(noteCreatedAt) }) });
    out.push({ text: noteOwner ? t('carryOwner', { owner: noteOwner }) : t('carryOwnerSame') });
    return out;
  }, [target, detail, noteCreatedAt, noteOwner, t]);

  /** 拉笔记详情（总结 + 原始记录 + 录音元信息）。失败也继续 —— 只是预填少两块 */
  const loadDetail = useCallback(async (): Promise<Record<string, unknown> | null> => {
    if (detail) return detail;
    setReading(true);
    try {
      const n = (await api.getGetnote(noteId)) as Record<string, unknown>;
      setDetail(n);
      return n;
    } catch {
      setDetail({});
      return {};
    } finally {
      setReading(false);
    }
  }, [detail, noteId]);

  /**
   * 选目标模块：拉详情 → 拼预填 → 铺表单。
   *
   * 预填增强（`enrichPrefill`）在这里调、**不走 CrudPage 的转换入口**：那个入口认的是
   * URL 的 `acmsConvert=1` + sessionStorage，而就地转换没有跳页。用的是同一个函数，
   * 所以「笔记标题 → 主题、归属人 → 记录人」这些口径两边一致。
   */
  const pick = useCallback(
    async (tg: NoteConvertTarget) => {
      setErr('');
      setResult(null);
      // 页内不支持就直接交回调用方跳页（旧行为），不在这里拼一个打不开的表单
      if (!convertFormFor(tg.key, { me: '' })) {
        onFallback(tg);
        return;
      }
      setBusy(true);
      try {
        const n = (await loadDetail()) ?? {};
        const summary = String(n.content ?? '');
        const raw = String(n.rawRecord ?? '');

        const values: Record<string, unknown> = { ...convertInitialExtras(tg.key) };
        if (tg.summaryField && summary) values[tg.summaryField] = summary;
        if (tg.rawField && raw) values[tg.rawField] = raw;

        /**
         * 原始录音一并带过去（2026-09-18）：把笔记音频的 `file_token` **直接写进**目标记录的
         * 附件字段，不复制文件 —— 附件是内容寻址落盘的独立文件，同一 token 被两条记录引用
         * 完全安全。没配 `audioField` 的模块（纯文本类）就不带，不报错、不阻断。
         */
        const a = audioOf(n);
        if (a && tg.audioField) {
          values[tg.audioField] = [
            {
              file_token: a.token,
              name: a.name ?? `${noteId}.ogg`,
              size: a.size ?? 0,
              type: a.type ?? 'audio/ogg',
            },
          ];
        }

        const partsForPick = convertFormFor(tg.key, { me: '' });
        const userName = await currentUserName();
        let filled = values;
        if (partsForPick?.enrichPrefill) {
          try {
            filled = partsForPick.enrichPrefill(values, {
              userName,
              noteOwner,
              noteTitle,
              noteCreatedAt: noteCreatedAt || undefined,
            });
          } catch {
            /* 解析失败不影响预填 */
          }
        }

        formRef.current = {};
        setStudentType(String(filled[STUDENT_RECORD_TYPE_FIELD] ?? ''));
        setInitial(filled);
        setTarget(tg);
      } catch (e) {
        setErr(humanizeError(e));
      } finally {
        setBusy(false);
      }
    },
    [loadDetail, noteId, noteOwner, noteTitle, noteCreatedAt, onFallback],
  );

  /**
   * 保存成功后的收尾：**这一步才写留痕**（峰哥 2026-09-28：保存成功才计一次）。
   *
   * 三件事，前一件失败不影响后一件：
   *  ① 写留痕（后端在这里判「归档笔记不许转换」，409 会被下面的 catch 抓到）
   *  ② 回填「转成了哪条业务记录」（日后能从留痕直接跳过去）
   *  ③ 写「笔记 ↔ 业务记录」关联（详情页的「关联笔记」面板靠它反查）
   */
  const handleSaved = useCallback(
    async (created: Record<string, unknown> | null) => {
      const tg = target;
      if (!tg) return;
      const newId = String(created?.id ?? created?.recordId ?? '');
      const entity = recordTitleOf(formRef.current);
      let warn = '';
      try {
        const r = await api.logNoteConvert({
          noteId,
          noteTitle,
          moduleKey: tg.key,
          moduleLabel: tg.label,
        });
        const logId = r?.logId ?? '';
        if (newId) {
          if (logId) {
            try {
              await api.linkNoteConvert(logId, newId);
            } catch {
              /* 回填失败不阻断：业务记录已经存下来了 */
            }
          }
          try {
            await api.replaceGetnoteLinks(tg.label, newId, entity, [{ noteId, title: noteTitle }]);
          } catch {
            /* 关联失败不阻断业务 */
          }
        }
        onLogged({ logId, moduleKey: tg.key, moduleLabel: tg.label, count: Number(r?.count ?? 1) || 1 });
      } catch (e) {
        // 归档闸门（NOTE_ARCHIVED）也走这里：**记录已经存下来了**，只是没留痕。
        // 必须让用户看见，否则「已转」列不涨、用户以为白转了。
        warn = t('convertLogFailed', { msg: humanizeError(e) });
      }
      setResult({ label: tg.label, recordId: newId, detailHref: parts?.detailHref(newId) ?? '', title: entity, warn });
    },
    [target, parts, noteId, noteTitle, onLogged, t],
  );

  /** 表单值回吐：学生记录要按「记录类型」重建列定义（措辞与显隐都跟着变） */
  const handleFormChange = useCallback((form: Record<string, unknown>) => {
    formRef.current = form;
    const v = String(form[STUDENT_RECORD_TYPE_FIELD] ?? '');
    if (v) setStudentType((cur) => (cur === v ? cur : v));
  }, []);

  const doneCount = (moduleKey: string) => logs.find((i) => i.moduleKey === moduleKey)?.count ?? 0;

  return (
    <div style={panelStyle}>
      {/* ── ① 会带过去什么 ─────────────────────────────── */}
      <div style={stepStyle}>
        <span style={stepNoStyle}>1</span>
        {t('carryTitle')}
      </div>
      <div style={chipWrapStyle}>
        {carried.length ? (
          carried.map((c) => (
            <span key={c.text} style={chipStyle}>
              {c.text}
            </span>
          ))
        ) : (
          <span className="muted" style={{ fontSize: 12.5 }}>
            {reading ? t('convertReading') : t('carryBeforePick')}
          </span>
        )}
      </div>

      {/* ── ② 转成哪种业务记录 ───────────────────────────── */}
      <div style={stepStyle}>
        <span style={stepNoStyle}>2</span>
        {t('pickTitle')}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
        {targets.map((tg) => {
          const n = doneCount(tg.key);
          const on = targetKey === tg.key;
          return (
            <button
              key={tg.key}
              type="button"
              disabled={busy}
              className={on ? 'btn btn-primary' : 'btn btn-outline'}
              onClick={() => void pick(tg)}
            >
              {tg.label}
              {tg.enLabel ? <span style={{ opacity: 0.75, marginLeft: 6, fontWeight: 400 }}>{tg.enLabel}</span> : null}
              {n ? <span style={{ marginLeft: 8, fontWeight: 400 }}>· {t('convertedTimes', { count: n })}</span> : null}
            </button>
          );
        })}
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
        {t('pickHint')}
      </div>

      {err ? <p className="msg-error">{err}</p> : null}

      {/* ── ④ 保存结果态：留在本页，这条笔记仍是展开态 ───────── */}
      {result ? (
        <div style={doneStyle}>
          <div style={{ fontWeight: 700, color: 'var(--accent)', marginBottom: 6 }}>
            {t('savedAs', { label: result.label })}
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--fg-secondary)', marginBottom: 4 }}>
            {t('savedMeta', { extra: result.title || '—' })}
          </div>
          <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
            {t('savedLinked')} · {t('savedLogOnly')}
          </div>
          {result.warn ? <p className="msg-error" style={{ marginTop: 0 }}>{result.warn}</p> : null}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {result.recordId && result.detailHref ? (
              <a className="btn btn-outline btn-sm" href={result.detailHref} target="_blank" rel="noreferrer">
                {t('openRecord')}
              </a>
            ) : null}
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => {
                setResult(null);
                setTarget(null);
                setInitial(null);
              }}
            >
              {t('convertAgain')}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
              {t('collapsePanel')}
            </button>
            <span className="muted" style={{ fontSize: 12, marginLeft: 'auto', alignSelf: 'center' }}>
              {t('stayHint')}
            </span>
          </div>
        </div>
      ) : null}

      {/* ── ③ 目标模块的表单（CrudPage 的 formOnly 模式） ─────── */}
      {target && parts && initial && !result ? (
        <div style={{ marginTop: 4 }}>
          <div style={stepStyle}>
            <span style={stepNoStyle}>3</span>
            {target.label}
          </div>
          <CrudPage
            /**
             * 🔴 key 必须带模块：`formOnly.initial` 只在**挂载时**读一次，
             *    换目标模块要重挂载才能换初始值（同一个 key 会拿着旧值渲染新表单）。
             */
            key={`${noteId}::${targetKey}`}
            moduleKey={target.key}
            title={target.label}
            columns={parts.columns}
            api={parts.api}
            formOnly={{
              initial,
              onSaved: handleSaved,
              onCancel: () => {
                setTarget(null);
                setInitial(null);
              },
            }}
            onFormChange={handleFormChange}
          />
        </div>
      ) : null}
    </div>
  );
}

/** 笔记创建时间 → `2026-09-17 13:57`（本地时区，与各模块 datetime 的显示一致） */
function fmtWhen(ms: number): string {
  if (!ms) return '—';
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const panelStyle: CSSProperties = {
  border: '1px solid var(--border)',
  borderLeft: '3px solid var(--accent)',
  borderRadius: 'var(--radius-md)',
  background: 'var(--surface)',
  padding: '14px 16px',
  margin: '6px 0 12px',
};

const stepStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 9,
  fontSize: 13,
  fontWeight: 700,
  margin: '0 0 9px',
};

const stepNoStyle: CSSProperties = {
  width: 19,
  height: 19,
  borderRadius: '50%',
  background: 'var(--accent)',
  color: '#fff',
  fontSize: 12,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
};

const chipWrapStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
  marginBottom: 14,
};

const chipStyle: CSSProperties = {
  fontSize: 12,
  padding: '2px 9px',
  borderRadius: 999,
  background: 'var(--accent-muted)',
  color: 'var(--accent)',
  border: '1px solid rgba(14,155,142,.25)',
};

const doneStyle: CSSProperties = {
  border: '1px solid rgba(14,155,142,.35)',
  background: 'var(--accent-muted)',
  borderRadius: 'var(--radius-md)',
  padding: '13px 15px',
  marginTop: 6,
};
