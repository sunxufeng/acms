'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { subjectColumnDrafts, TERM_WHOLE_YEAR } from '@acms/contracts';
import { api, type MarkbookColumn } from '../../lib/api';
import Modal from './Modal';

/**
 * 成绩册「新建 / 修改考核列」（2026-09-20 从页面内联面板改为弹出框）。
 *
 * 三处关键约定：
 * 1. 🔴 **考核类型 / 科目 / 学年 / 学期 都必须是下拉**：这几个值都是「与别的表逐字匹配的键」
 *    （类型名 → 权重/颜色/计入总评；科目 → 期末总评拆分；学年学期 → 这次加的成绩册归属）。
 *    手打错一个字就静默失效：要么权重不算、要么总评按科目拆成两份、要么这一列跑进别的成绩册。
 * 2. 🔴 **多科目 = 多列**（勾 N 个科目建 N 列）。展开规则来自 `@acms/contracts` 的
 *    `subjectColumnDrafts` —— 与后端真正建列**同一份代码**，所以底部的「将创建 N 列」预览
 *    不会出现「预览 3 列、实际建出 4 列」。
 * 3. 新建时「学年 / 学期」默认继承页面顶部选的那两个（在弹窗里也能改，比如补录上学期的期末）。
 */
export default function ColumnEditor({
  cls,
  col,
  siblings,
  onPickSibling,
  scales,
  subjects,
  types,
  years,
  terms,
  defaultYear,
  defaultTerm,
  onClose,
  onSaved,
}: {
  cls: string;
  /** null = 新建；非空 = 修改该列 */
  col: MarkbookColumn | null;
  /**
   * 「按学科分行」视图的**归并表头**一次带进来的同组列记录（同一个考核项下的各学科）。
   * 长度 > 1 时弹窗顶部出现学科切换条；点另一个学科由页面改 `col` —— 外层 `key` 变了
   * 组件会重建，表单自然回填成那一条的值（不用手写一套「切换时重置」的同步逻辑）。
   */
  siblings?: MarkbookColumn[];
  onPickSibling?: (col: MarkbookColumn) => void;
  scales: { id: string; name: string; isDefault: boolean }[];
  /** 「科目」候选 = 字典「授课科目」 */
  subjects: string[];
  /** 考核类型候选（value=类型名，label 里带本班权重） */
  types: { value: string; label: string }[];
  /** 「学年」候选 = 字典「学年」 */
  years: string[];
  /** 「学期」候选 = 字典「教学学期」 */
  terms: string[];
  defaultYear: string;
  defaultTerm: string;
  onClose: () => void;
  /**
   * 保存成功回调。
   * @param created  本次实际建了几列（多科目时 > 1）
   * @param keepOpen 是否勾了「保存后继续建下一个」（为真时页面**不要**关弹窗）
   */
  onSaved: (created: number, keepOpen: boolean) => void | Promise<void>;
}) {
  const t = useTranslations('markbook');
  const isNew = !col;

  const [name, setName] = useState(col?.name ?? '');
  const [type, setType] = useState(col?.type ?? '');
  /** 编辑既有列时的单科目值（一列只能有一个科目） */
  const [subject, setSubject] = useState(col?.subject ?? '');
  /** 新建时的多选科目（'' = 未指定，与后端约定一致） */
  const [picked, setPicked] = useState<string[]>(['']);
  const [year, setYear] = useState(col?.year || defaultYear);
  const [term, setTerm] = useState(col?.term || defaultTerm);
  const [weight, setWeight] = useState(String(col?.weight ?? 1));
  const [fullMark, setFullMark] = useState(String(col?.fullMark ?? 100));
  const [scaleId, setScaleId] = useState(col?.scaleId ?? '');
  const [date, setDate] = useState(col?.date ?? '');
  const [sort, setSort] = useState(String(col?.sort ?? 0));
  // 描述要从原值回填：不回填的话「改个权重」会把备注一起清掉（后端已改为未传不覆盖，这里再补上回显）
  const [desc, setDesc] = useState(col?.desc ?? '');
  const [status, setStatus] = useState(col?.status ?? '启用');
  /**
   * 可见性与「完成闸门」。三态语义（判据在 apps/api/src/portal/portal-visibility.ts）：
   *  - 空串 = **未设置**（学生/家长都看不到）—— 只有显式选「是」才公开；
   *  - 完成日期（闸门）= 到达该日期前不对家长开放；留空 = 不设闸门（立即开放）。
   */
  const [studentVisible, setStudentVisible] = useState(col?.studentVisible ?? '');
  const [parentVisible, setParentVisible] = useState(col?.parentVisible ?? '');
  const [completeDate, setCompleteDate] = useState(col?.completeDate ?? '');
  /** 保存后不关闭、继续建下一个（一次建 5 个科目的列时不用开 5 次弹窗） */
  const [keepOpen, setKeepOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  /**
   * 将创建哪几列（**与后端同一份规则的预览**）。
   * 只在新建时有意义：编辑就是改这一列，不会裂成多列。
   */
  const drafts = useMemo(
    () => subjectColumnDrafts({ name, subjects: picked, sort: Number(sort) || 0 }),
    [name, picked, sort],
  );
  const createCount = isNew ? drafts.length : 1;

  const toggleSubject = (s: string) => {
    setPicked((cur) => {
      // 「未指定」是互斥的：选了具体科目就不该再包括未指定（后端也会把空串当一列）
      if (s === '') return cur.includes('') ? [] : [''];
      const next = cur.filter((x) => x !== '');
      return next.includes(s) ? next.filter((x) => x !== s) : [...next, s];
    });
  };

  const submit = async () => {
    if (!name.trim()) {
      setErr(t('nameRequired'));
      return;
    }
    setBusy(true);
    setErr('');
    try {
      const res = await api.markbookSaveColumn({
        id: col?.id,
        cls,
        name: name.trim(),
        type,
        // 新建走多科目；编辑走单科目（一列只有一个科目）
        ...(isNew ? { subjects: picked.length ? picked : [''] } : { subject: subject.trim() }),
        year,
        term,
        weight: Number(weight) || 1,
        fullMark: Number(fullMark) || 100,
        scaleId,
        date,
        desc,
        sort: Number(sort) || 0,
        status,
        studentVisible,
        parentVisible,
        completeDate,
      });
      await onSaved(res?.created ?? 1, isNew && keepOpen);
      if (isNew && keepOpen) {
        // 继续建下一个：只清「这一列特有」的内容，学年/学期/类型/权重这些多半要沿用
        setName('');
        setDesc('');
        setDate('');
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={col ? t('editColumn', { name: col.name }) : t('newColumn')}
      subtitle={t('columnModalSub', { year: year || t('unassignedTerm'), term: term || t('unassignedTerm'), cls })}
      onClose={onClose}
      width={780}
      footer={
        <>
          <span className="mb-modal-summary">
            {isNew ? (
              <>
                {t('willCreate', { count: createCount })}
                <span className="mb-preview-list">
                  {drafts.map((d, i) => (
                    <span className="mb-chip static" key={`${d.name}-${d.subject}-${i}`}>
                      {d.name}
                      {d.subject ? '' : `（${t('subjectNoneShort')}）`}
                    </span>
                  ))}
                </span>
                {createCount > 1 ? <div className="mb-modal-hint">{t('willCreateAdjacent')}</div> : null}
              </>
            ) : (
              <span className="muted">{t('editColumnHint')}</span>
            )}
          </span>
          <span className="mb-modal-actions">
            {isNew ? (
              <label className="mb-check">
                <input type="checkbox" checked={keepOpen} onChange={(e) => setKeepOpen(e.target.checked)} />
                <span>{t('keepOpen')}</span>
              </label>
            ) : null}
            <button className="btn btn-outline" onClick={onClose} disabled={busy}>
              {t('cancel')}
            </button>
            <button className="btn btn-primary" onClick={() => void submit()} disabled={busy}>
              {busy ? t('saving') : isNew ? t('createCountBtn', { count: createCount }) : t('confirm')}
            </button>
          </span>
        </>
      }
    >
      {err ? <div className="notice notice-error">{err}</div> : null}

      {/* 归并表头一次带进来多条列记录（每个学科一条）：先切学科，再改这一条。
          不加这段的话，老师点「编辑」只会打开第一条（数学），改完以为其它学科也跟着改了。 */}
      {siblings && siblings.length > 1 ? (
        <div className="mb-sibbar">
          <span className="mb-sibbar-label">{t('editSiblingHint', { count: siblings.length })}</span>
          <span className="mb-sibbar-chips">
            {siblings.map((s) => (
              <button
                key={s.id}
                type="button"
                className={['mb-chip', s.subject ? '' : 'none', s.id === col?.id ? 'on' : ''].filter(Boolean).join(' ')}
                onClick={() => onPickSibling?.(s)}
              >
                {s.subject || t('subjectNoneShort')}
              </button>
            ))}
          </span>
          <span className="mb-sibbar-hint">{t('editSiblingEach')}</span>
        </div>
      ) : null}

      {/* ── ① 归属：决定这一列出现在哪个成绩册里 ───────────────────── */}
      <div className="mb-sect">
        <div className="mb-sect-t">{t('sectOwner')}</div>
        <div className="form-grid mb-editor-body">
          <label className="mb-field">
            <span>{t('fYear')}</span>
            {/* 学年不填也能存（未归属的列在任何学年筛选下都会出现），但默认就填好了 */}
            <select className="form-input" value={year} onChange={(e) => setYear(e.target.value)}>
              <option value="">{t('unassignedTerm')}</option>
              {/* 历史值不在字典里时补一项，避免显示成「未归属」让人以为丢了 */}
              {year && !years.includes(year) ? <option value={year}>{`${year}（${t('notInDict')}）`}</option> : null}
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </label>
          <label className="mb-field">
            <span>{t('fTerm')}</span>
            <select className="form-input" value={term} onChange={(e) => setTerm(e.target.value)}>
              <option value="">{t('unassignedTerm')}</option>
              {term && !terms.includes(term) ? (
                <option value={term}>{`${term}（${t('notInDict')}）`}</option>
              ) : null}
              {terms.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
            {term === TERM_WHOLE_YEAR ? <span className="mb-meta">{t('termWholeYearHint')}</span> : null}
          </label>
        </div>
      </div>

      {/* ── ② 考核内容 ───────────────────────────────────────────── */}
      <div className="mb-sect">
        <div className="mb-sect-t">{t('sectContent')}</div>
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
            {/* 类型留空不阻断保存，但必须说清后果：结转按权重 1 计入期末总评 */}
            {type === '' && types.length > 0 && isNew ? (
              <span style={{ color: 'var(--warning)', fontSize: 'var(--font-xs)' }}>{t('fTypeWarn')}</span>
            ) : null}
          </label>
          <label className="mb-field">
            <span>{t('fDate')}</span>
            <input className="form-input" type="date" value={date.slice(0, 10)} onChange={(e) => setDate(e.target.value)} />
            <span className="mb-meta">{t('fDateHint')}</span>
          </label>
          <label className="mb-field">
            <span>{t('fSort')}</span>
            <input className="form-input" inputMode="numeric" value={sort} onChange={(e) => setSort(e.target.value)} />
            {isNew && createCount > 1 ? <span className="mb-meta">{t('sortChainHint')}</span> : null}
          </label>
          <label className="mb-field mb-field-wide">
            <span>{t('fDesc')}</span>
            <input className="form-input" value={desc} onChange={(e) => setDesc(e.target.value)} />
          </label>
        </div>

        {/* ── 科目：新建可多选（勾 N 个 = N 列），编辑单选 ── */}
        <div className="mb-field mb-field-wide" style={{ marginTop: 'var(--space-md)' }}>
          <span>{t('fSubject')}{isNew ? ` · ${t('subjectMulti')}` : ''}</span>
          {isNew ? (
            <>
              <div className="mb-chips">
                {subjects.map((s) => (
                  <button
                    type="button"
                    key={s}
                    className={picked.includes(s) ? 'mb-chip on' : 'mb-chip'}
                    onClick={() => toggleSubject(s)}
                  >
                    {s}
                  </button>
                ))}
                <button
                  type="button"
                  className={picked.includes('') ? 'mb-chip on none' : 'mb-chip none'}
                  onClick={() => toggleSubject('')}
                >
                  {t('fSubjectNone')}
                </button>
              </div>
              {subjects.length === 0 ? (
                <span className="mb-meta">{t('fSubjectEmpty')}</span>
              ) : (
                <span className="mb-meta">{t('fSubjectMultiHint')}</span>
              )}
            </>
          ) : (
            <>
              {/* 🔴 编辑时是单选：一列只能属于一个科目（期末总评的幂等键含科目） */}
              <select className="form-input" value={subject} onChange={(e) => setSubject(e.target.value)}>
                <option value="">{t('fSubjectNone')}</option>
                {subject && !subjects.includes(subject) ? (
                  <option value={subject}>{`${subject}（${t('fSubjectMissing')}）`}</option>
                ) : null}
                {subjects.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <span className="mb-meta">{t('fSubjectEditHint')}</span>
            </>
          )}
        </div>
      </div>

      {/* ── ③ 计分 ──────────────────────────────────────────────── */}
      <div className="mb-sect">
        <div className="mb-sect-t">{t('sectScore')}</div>
        <div className="form-grid mb-editor-body">
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
            <span>{t('fStatus')}</span>
            <select className="form-input" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="启用">{t('enabled')}</option>
              <option value="停用">{t('disabled')}</option>
            </select>
          </label>
        </div>
        <span className="mb-meta">{t('weightNote')}</span>
      </div>

      {/* ── ④ 可见性 ────────────────────────────────────────────── */}
      <div className="mb-sect" style={{ marginBottom: 0 }}>
        <div className="mb-sect-t">{t('sectVisible')}</div>
        <div className="form-grid mb-editor-body">
          <label className="mb-field">
            <span>{t('fStudentVisible')}</span>
            <select className="form-input" value={studentVisible} onChange={(e) => setStudentVisible(e.target.value)}>
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
        </div>
        <span className="mb-meta">{t('visibleHint')}</span>
        {col ? (
          <div className="mb-field mb-field-wide" style={{ marginTop: 8 }}>
            <span>{t('fHomework')}</span>
            <span className="muted">
              {col.homeworkName ? col.homeworkName : t('homeworkUnbound')}
              {' · '}
              {t('homeworkBindHint')}
            </span>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
