'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useTl } from '../../lib/useTl';
import { currentUserName } from '../../lib/noteAutoFill';
import { DateField, fmtDate, statusClassOf } from './fields';

/**
 * 行为跟进弹窗：对某条行为记录写后续处理流水（可多条）。
 *
 * 为什么是弹窗而不是跳页：跟进是**行级高频小动作**（打完电话顺手记一笔），
 * 跳走再回来会丢掉列表的筛选与页码。全站的 `.modal-overlay` + `.detail-modal` 就是干这个的。
 *
 * 数据来源：
 *   读 —— 专用接口 `GET /behaviour/records/:id/follow-ups`（关联字段在 jsonb 里是数组，
 *         通用列表的等值筛选筛不出来，所以后端给了这个接口）
 *   写 —— 通用 CRUD `POST /behaviour/follow-ups`（与其它模块同一套写入/审计链路）
 */

const METHODS = ['谈话', '电话', '家访', '书面', '其它'];
const STATUSES = ['待跟进', '进行中', '已完成'];

export default function FollowUpModal({
  record,
  canWrite,
  onClose,
  onSaved,
}: {
  record: Record<string, unknown>;
  canWrite: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const tl = useTl();
  const recordId = String(record.id ?? '');
  const studentName = String(record['学生姓名'] ?? '');

  const [items, setItems] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const [form, setForm] = useState<Record<string, unknown>>({
    跟进人: '',
    跟进日期: Date.now(),
    跟进方式: '谈话',
    跟进内容: '',
    结果: '',
    下一步: '',
    状态: '待跟进',
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!recordId) return;
    setLoading(true);
    try {
      const r = await api.listBehaviourFollowUps(recordId);
      setItems(r.items ?? []);
      setLoadErr(null);
    } catch (e) {
      setLoadErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [recordId]);

  useEffect(() => {
    void load();
  }, [load]);

  // 预填「跟进人」= 当前登录用户：谁在跟进就记谁，省一次手敲
  useEffect(() => {
    let alive = true;
    void currentUserName().then((n) => {
      if (alive && n) setForm((f) => (f['跟进人'] ? f : { ...f, 跟进人: n }));
    });
    return () => {
      alive = false;
    };
  }, []);

  const set = (k: string, v: unknown) => setForm((f) => ({ ...f, [k]: v }));

  async function submit() {
    if (!String(form['跟进内容'] ?? '').trim()) {
      setErr(tl('请填写跟进内容'));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api.behaviourFollowUps.create({ ...form, 行为记录: recordId });
      setForm((f) => ({ ...f, 跟进内容: '', 结果: '', 下一步: '' }));
      await load();
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="detail-modal" onClick={(e) => e.stopPropagation()}>
        <div className="detail-modal-head">
          <h3 className="detail-modal-title">
            {tl('行为跟进')}
            {studentName ? ` · ${studentName}` : ''}
          </h3>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} aria-label={tl('关闭')}>
            ×
          </button>
        </div>

        <div className="detail-modal-body" style={{ whiteSpace: 'normal' }}>
          <div className="muted" style={{ marginBottom: 'var(--space-md)' }}>
            {`${fmtDate(record['发生日期'])} · ${String(record['行为类型'] ?? '—')} · ${
              String(record['行为分类'] ?? '—')
            } · ${String(record['描述'] ?? '—')}`}
          </div>

          <h4 style={{ fontSize: 'var(--font-md)', fontWeight: 700, marginBottom: 'var(--space-sm)' }}>
            {tl('已有跟进记录')}
          </h4>
          {loading ? (
            <p className="muted">{tl('读取中…')}</p>
          ) : loadErr ? (
            <p className="msg-error">{loadErr}</p>
          ) : items.length ? (
            <div className="data-table-wrap" style={{ marginBottom: 'var(--space-lg)' }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{tl('跟进日期')}</th>
                    <th>{tl('跟进人')}</th>
                    <th>{tl('跟进方式')}</th>
                    <th>{tl('跟进内容')}</th>
                    <th>{tl('结果')}</th>
                    <th>{tl('状态')}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((it) => (
                    <tr key={String(it.id)}>
                      <td className="muted">{fmtDate(it['跟进日期'])}</td>
                      <td>{String(it['跟进人'] ?? '—')}</td>
                      <td>{tl(String(it['跟进方式'] ?? '—'))}</td>
                      <td>{String(it['跟进内容'] ?? '—')}</td>
                      <td>{String(it['结果'] ?? '—')}</td>
                      <td>
                        <span className={`status-dot ${statusClassOf(String(it['状态'] ?? ''))}`}>
                          {tl(String(it['状态'] ?? '—'))}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted" style={{ marginBottom: 'var(--space-lg)' }}>
              {tl('暂无跟进记录')}
            </p>
          )}

          {canWrite ? (
            <>
              <h4 style={{ fontSize: 'var(--font-md)', fontWeight: 700, marginBottom: 'var(--space-sm)' }}>
                {tl('新增跟进')}
              </h4>
              <div className="form-grid">
                <label className="form-label">
                  <span className="form-label-text">{tl('跟进人')}</span>
                  <input
                    className="form-input"
                    value={String(form['跟进人'] ?? '')}
                    onChange={(e) => set('跟进人', e.target.value)}
                  />
                </label>
                <label className="form-label">
                  <span className="form-label-text">{tl('跟进日期')}</span>
                  <DateField value={form['跟进日期']} onChange={(v) => set('跟进日期', v)} />
                </label>
                <label className="form-label">
                  <span className="form-label-text">{tl('跟进方式')}</span>
                  <select
                    className="form-input"
                    value={String(form['跟进方式'] ?? '谈话')}
                    onChange={(e) => set('跟进方式', e.target.value)}
                  >
                    {METHODS.map((m) => (
                      <option key={m} value={m}>
                        {tl(m)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="form-label">
                  <span className="form-label-text">{tl('状态')}</span>
                  <select
                    className="form-input"
                    value={String(form['状态'] ?? '待跟进')}
                    onChange={(e) => set('状态', e.target.value)}
                  >
                    {STATUSES.map((m) => (
                      <option key={m} value={m}>
                        {tl(m)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="form-label" style={{ marginTop: 16 }}>
                <span className="form-label-text">{tl('跟进内容')}</span>
                <textarea
                  className="form-input"
                  rows={3}
                  value={String(form['跟进内容'] ?? '')}
                  onChange={(e) => set('跟进内容', e.target.value)}
                  placeholder={tl('如：与家长电话沟通，家长表示会配合监督作业')}
                />
              </label>
              <label className="form-label" style={{ marginTop: 16 }}>
                <span className="form-label-text">{tl('结果')}</span>
                <input
                  className="form-input"
                  value={String(form['结果'] ?? '')}
                  onChange={(e) => set('结果', e.target.value)}
                />
              </label>
              <label className="form-label" style={{ marginTop: 16 }}>
                <span className="form-label-text">{tl('下一步')}</span>
                <input
                  className="form-input"
                  value={String(form['下一步'] ?? '')}
                  onChange={(e) => set('下一步', e.target.value)}
                  placeholder={tl('如：一周后回访，观察课堂表现')}
                />
              </label>
              {err ? <p className="msg-error" style={{ marginTop: 12 }}>{err}</p> : null}
            </>
          ) : (
            <p className="muted">{tl('当前账号没有新增跟进的权限')}</p>
          )}
        </div>

        <div className="detail-modal-foot">
          <button type="button" className="btn btn-outline" onClick={onClose}>
            {tl('关闭')}
          </button>
          {canWrite ? (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void submit()}>
              {busy ? tl('保存中…') : tl('保存跟进')}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
