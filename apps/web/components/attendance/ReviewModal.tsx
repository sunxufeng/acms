'use client';

import { useState } from 'react';
import { api } from '../../lib/api';
import { useTl } from '../../lib/useTl';

/**
 * 考勤终态审核弹窗（单条 / 批量共用）。
 *
 * 为什么是弹窗而不是跳页：审核是**行级高频小动作**（教务扫一遍当天的考勤记录），
 * 跳走再回来会丢掉列表的筛选与页码。全站的 `.modal-overlay` + `.detail-modal`
 * 就是干这个的（与行为记录的跟进弹窗同一范式）。
 *
 * 审核人由**服务端**取当前登录用户，前端不传 —— 否则可以伪造审核人。
 */

const APPROVED = '已通过';
const REJECTED = '已驳回';

export default function ReviewModal({
  records,
  onClose,
  onSaved,
}: {
  /** 被审核的记录（单条时长度 1；批量时是勾选的全部行，用于展示与取 id） */
  records: Record<string, unknown>[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const tl = useTl();
  const [status, setStatus] = useState<string>(APPROVED);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const ids = records.map((r) => String(r.id ?? '')).filter(Boolean);
  const isBatch = ids.length > 1;
  // 驳回必须写理由：终态审核不可回退，没有理由的驳回下游无法申诉
  const needComment = status === REJECTED && !comment.trim();

  async function submit(): Promise<void> {
    if (needComment) {
      setErr(tl('驳回必须填写审核意见'));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const text = comment.trim() || undefined;
      if (isBatch) await api.reviewStudentAttendances({ ids, status, comment: text });
      else if (ids[0]) await api.reviewStudentAttendance(ids[0], { status, comment: text });
      onSaved();
    } catch (e) {
      setErr((e as Error).message || tl('审核失败'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="detail-modal" onClick={(e) => e.stopPropagation()}>
        <div className="detail-modal-head">
          <h3 className="detail-modal-title">
            {isBatch ? `${tl('批量审核')}（${ids.length}）` : tl('考勤终态审核')}
          </h3>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} aria-label={tl('关闭')}>
            ×
          </button>
        </div>

        <div className="detail-modal-body" style={{ whiteSpace: 'normal' }}>
          {/* 审的是哪几条：批量时只列前 8 条，避免把弹窗撑爆 */}
          <div className="muted" style={{ fontSize: 'var(--font-sm)', marginBottom: 'var(--space-md)', lineHeight: 1.7 }}>
            {records.slice(0, 8).map((r) => {
              const parts = [
                String(r['关联学生编号'] ?? '—'),
                String(r['考勤日期'] ?? '—').slice(0, 10),
                String(r['考勤结果'] ?? '—'),
                `${tl('当前')}：${String(r['审核状态'] || tl('待审核'))}`,
              ];
              return <div key={String(r.id)}>{parts.join(' · ')}</div>;
            })}
            {records.length > 8 ? <div>{`… ${tl('等')} ${records.length} ${tl('条')}`}</div> : null}
          </div>

          <h4 style={{ fontSize: 'var(--font-md)', fontWeight: 700, marginBottom: 'var(--space-sm)' }}>{tl('审核结论')}</h4>
          <div style={{ display: 'flex', gap: 10, marginBottom: 'var(--space-md)' }}>
            {[APPROVED, REJECTED].map((s) => (
              <button
                key={s}
                type="button"
                className={`btn ${status === s ? 'btn-primary' : 'btn-outline'}`}
                onClick={() => setStatus(s)}
              >
                {tl(s)}
              </button>
            ))}
          </div>

          <label className="form-label">
            <span className="form-label-text">
              {tl('审核意见')}
              {status === REJECTED ? <span style={{ color: 'var(--danger)' }}> *</span> : null}
            </span>
            <textarea
              className="form-input"
              rows={3}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder={tl('如：已核对打卡记录，同意计入出勤')}
            />
          </label>

          <p className="muted" style={{ fontSize: 'var(--font-xs)', marginTop: 10, lineHeight: 1.7 }}>
            {tl('审核后成为终态：只有「已通过」的考勤记录才计入出勤率与结算基数，「已驳回」与「待审核」都不计入。')}
          </p>
          {err ? <p className="msg-error" style={{ marginTop: 12 }}>{err}</p> : null}
        </div>

        <div className="detail-modal-foot">
          <button type="button" className="btn btn-outline" onClick={onClose}>
            {tl('取消')}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || needComment}
            onClick={() => void submit()}
          >
            {busy ? tl('提交中…') : isBatch ? tl('提交批量审核') : tl('提交审核')}
          </button>
        </div>
      </div>
    </div>
  );
}
