'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Modal } from './Modal';
import { api, type WeilingEnrollPreview } from '../lib/api';

/**
 * 「联系人 → 转入学生档案」的确认弹窗（2026-09-30 峰哥需求）。
 *
 * ── 设计口径（每一条都有具体理由，别随手改）────────────────────────
 * 1. **所有判据来自服务端**（`/weiling/contacts/:id/enroll-preview`）。
 *    前端不自己算"哪些字段能填" —— 判据在 `@acms/contracts` 里只有一份，
 *    前端重算必然与后端漂移，症状是"弹窗说会填、实际没填"。
 * 2. **重名检测放在最上面**。提交后才报重名意味着用户已经填完一轮再来一次。
 *    命中时默认走「关联到已有学生」，并保留「仍然新建」这个显式出口。
 * 3. **默认都填，但每一格都能取消，且看得出它从哪来**（`source` 小字）。
 * 4. **不填的格子也要展示**（`tier: 'skip'`），并**写明原因**。
 *    只显示"能填的"会让人以为后面那些字段是漏了；而不写理由的跳过会被当成 bug 报上来。
 * 5. `招生负责老师` 展示 `display`（姓名）而不是 `value`（open_id）——
 *    界面上给人看一串 `ou_xxx` 毫无意义。
 */
export interface WeilingEnrollModalProps {
  contactId: string;
  /** 联系人姓名，仅用于标题 */
  contactName: string;
  onClose: () => void;
  /** 转档成功后回调（用于刷新列表） */
  onDone: (studentId: string) => void;
}

const TIER_META: Record<string, { dot: string; label: string; hint: string }> = {
  solid: { dot: 'var(--accent)', label: '可靠来源', hint: '默认填写，来源明确' },
  check: { dot: 'var(--gold)', label: '请确认', hint: '卫瓴口径与档案字段不完全一致，看一眼再提交' },
  skip: { dot: 'var(--fg-tertiary)', label: '不填', hint: '以下字段本次不写入，原因见每行说明' },
};

export function WeilingEnrollModal({ contactId, contactName, onClose, onDone }: WeilingEnrollModalProps) {
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState<WeilingEnrollPreview | null>(null);
  const [err, setErr] = useState('');

  /** 重名分支：默认「关联到已有」（`false` = 用户显式选了「仍然新建」） */
  const [linkExisting, setLinkExisting] = useState(true);
  const [linkTarget, setLinkTarget] = useState('');

  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [values, setValues] = useState<Record<string, string>>({});
  const [bf, setBf] = useState({ sourceFollowups: true, mail: true });

  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ mode: string; studentId: string; studentName: string; steps: { label: string; value: string }[] } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const p = await api.weilingEnrollPreview(contactId);
      setPreview(p);
      // 预填：只把 solid / check 档的当前值灌进"可编辑值"里
      const init: Record<string, string> = {};
      const pk: Record<string, boolean> = {};
      for (const f of p.draft.fields) {
        if (f.tier === 'skip') continue;
        init[f.key] = f.value;
        pk[f.key] = true;
      }
      setValues(init);
      setPicked(pk);
      setLinkTarget(p.sameName[0]?.id ?? '');
      setLinkExisting(p.sameName.length > 0);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [contactId]);

  useEffect(() => {
    void load();
  }, [load]);

  const editable = useMemo(() => (preview?.draft.fields ?? []).filter((f) => f.tier !== 'skip'), [preview]);
  const skipped = useMemo(() => (preview?.draft.fields ?? []).filter((f) => f.tier === 'skip'), [preview]);

  const nameProblem = preview?.draft.nameProblem ?? null;
  const overriddenName = values['学生姓名'] ?? '';
  const nameOk = !nameProblem || (overriddenName.trim().length > 0 && overriddenName !== preview?.draft.studentName);
  const willCreate = !preview?.sameName.length || !linkExisting;

  const submit = async () => {
    if (!preview) return;
    setBusy(true);
    setErr('');
    try {
      const overrides: Record<string, string> = {};
      for (const f of editable) if (values[f.key] !== f.value) overrides[f.key] = values[f.key];
      const res = await api.weilingEnroll(contactId, {
        picked,
        overrides,
        ...(willCreate ? {} : { linkExistingStudentId: linkTarget }),
        backfill: { sourceFollowups: bf.sourceFollowups, mail: bf.mail },
      });
      setResult(res);
      onDone(res.studentId);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // ── 结果态：逐步列出写进去了什么 ──────────────────────────────
  if (result) {
    return (
      <Modal
        title={result.mode === 'created' ? `已转入学生档案 · ${result.studentName}` : `已关联到已有学生 · ${result.studentName}`}
        onClose={onClose}
        width={680}
        footer={
          <>
            <button className="btn" onClick={onClose}>关闭</button>
            <Link className="btn btn-primary" href={`/students/${encodeURIComponent(result.studentId)}`}>查看学生档案 ↗</Link>
          </>
        }
      >
        <div className="notice notice-ok" style={{ marginBottom: 12 }}>
          {result.mode === 'created' ? '新建了一条学生档案，并已把该联系人关联上去。' : '没有新建档案，只把该联系人关联到已有学生上。'}
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
          <tbody>
            {result.steps.map((s, i) => (
              <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={{ padding: '7px 8px 7px 0', color: 'var(--fg-tertiary)', whiteSpace: 'nowrap', verticalAlign: 'top' }}>{s.label}</td>
                <td style={{ padding: '7px 0', color: 'var(--fg-secondary)', whiteSpace: 'pre-wrap' }}>{s.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Modal>
    );
  }

  const alreadyLinked = preview?.link ?? null;

  return (
    <Modal
      title={`转入学生档案 · ${contactName}`}
      onClose={onClose}
      width={720}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>取消</button>
          <button
            className="btn btn-primary"
            onClick={() => void submit()}
            disabled={busy || loading || !!alreadyLinked || !nameOk || (willCreate && !values['学生姓名']?.trim())}
          >
            {busy ? '处理中…' : willCreate ? '确认转入学生档案' : '确认关联到已有学生'}
          </button>
        </>
      }
    >
      {loading ? (
        <div className="muted" style={{ padding: '20px 0' }}>正在读取该联系人的可转档信息…</div>
      ) : !preview ? (
        <div className="notice notice-error">{err || '读取失败'}</div>
      ) : (
        <>
          {err ? <div className="notice notice-error" style={{ marginBottom: 12 }}>{err}</div> : null}

          {/* ① 已关联过 —— 直接拦住，避免重复建档 */}
          {alreadyLinked ? (
            <div className="notice" style={{ marginBottom: 14, borderLeft: '3px solid var(--accent)' }}>
              该联系人**已经关联**到学生「{alreadyLinked.studentName}」（置信度 {alreadyLinked.score || '—'}，
              {alreadyLinked.reason || '无说明'}）。
              重复转档会造出第二条同样的档案，所以这里不再提供「入学」。
              <div style={{ marginTop: 8 }}>
                <Link className="btn btn-sm btn-primary" href={`/students/${encodeURIComponent(alreadyLinked.studentId)}`}>查看该学生 ↗</Link>
              </div>
            </div>
          ) : null}

          {/* ② 重名检测 —— 一定放在最上面 */}
          {!alreadyLinked && preview.sameName.length ? (
            <div className="notice" style={{ marginBottom: 14, borderLeft: '3px solid var(--gold)' }}>
              <b>已存在同名学生。</b>学生档案里已有 {preview.sameName.length} 位叫「{preview.draft.studentName}」的学生 ——
              直接新建会产生重复档案。
              <div style={{ margin: '10px 0 6px' }}>
                {preview.sameName.map((s) => (
                  <label key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', cursor: 'pointer' }}>
                    <input
                      type="radio"
                      name="same-name"
                      checked={linkExisting && linkTarget === s.id}
                      onChange={() => { setLinkExisting(true); setLinkTarget(s.id); }}
                    />
                    <span>
                      {s.name}
                      <span className="muted"> · {[s.enrolledAt, s.grade, s.cls, s.status].filter(Boolean).join(' · ') || '无更多信息'}</span>
                    </span>
                    <Link href={`/students/${encodeURIComponent(s.id)}`} target="_blank" className="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>查看 ↗</Link>
                  </label>
                ))}
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', cursor: 'pointer' }}>
                  <input type="radio" name="same-name" checked={!linkExisting} onChange={() => setLinkExisting(false)} />
                  <span>仍然新建一条新的学生档案<span className="muted"> · 同名可能是不同的人</span></span>
                </label>
              </div>
              {linkExisting ? (
                <div className="muted" style={{ fontSize: 12 }}>
                  选「关联到已有学生」时：**不新建、不改动该学生已有字段**，只补空的「招生负责老师」。
                </div>
              ) : null}
            </div>
          ) : null}

          {/* ③ 姓名不可用 —— 必须人工填 */}
          {!alreadyLinked && nameProblem ? (
            <div className="notice notice-error" style={{ marginBottom: 14 }}>
              <b>学生姓名不可用：</b>{nameProblem}
              {nameOk ? <div style={{ marginTop: 6, color: 'var(--success)' }}>已手工填写，继续即可。</div> : null}
            </div>
          ) : null}

          {/* ④ 将写入的字段 */}
          {!alreadyLinked ? (
            <>
              <div style={{ fontSize: 12, color: 'var(--fg-tertiary)', margin: '4px 0 10px' }}>
                将写入学生档案的字段 —— 每一格都标了来源，**可以逐项取消**。
              </div>
              {editable.map((f) => {
                const meta = TIER_META[f.tier];
                const on = picked[f.key] !== false;
                const val = values[f.key] ?? '';
                return (
                  <div key={f.key} style={{ display: 'grid', gridTemplateColumns: '20px 120px 1fr', gap: 10, alignItems: 'center', padding: '5px 0' }}>
                    <input type="checkbox" checked={on} onChange={(e) => setPicked((m) => ({ ...m, [f.key]: e.target.checked }))} />
                    <span style={{ fontSize: 12.5, color: 'var(--fg-secondary)', display: 'flex', alignItems: 'center', gap: 5 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 3, background: meta.dot, display: 'inline-block', flex: '0 0 auto' }} />
                      {f.label}
                      {f.key === '学生姓名' ? <span style={{ color: 'var(--danger)' }}>*</span> : null}
                    </span>
                    <div>
                      {f.editable ? (
                        f.key === '备注' ? (
                          <textarea
                            className="form-input"
                            style={{ width: '100%', minHeight: 76, fontFamily: 'inherit', fontSize: 12 }}
                            value={val}
                            disabled={!on}
                            onChange={(e) => setValues((m) => ({ ...m, [f.key]: e.target.value }))}
                          />
                        ) : f.options?.length ? (
                          <select
                            className="form-input"
                            style={{ width: '100%' }}
                            value={val}
                            disabled={!on}
                            onChange={(e) => setValues((m) => ({ ...m, [f.key]: e.target.value }))}
                          >
                            <option value="">（留空）</option>
                            {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
                          </select>
                        ) : (
                          <input
                            className="form-input"
                            style={{ width: '100%' }}
                            value={val}
                            disabled={!on}
                            onChange={(e) => setValues((m) => ({ ...m, [f.key]: e.target.value }))}
                          />
                        )
                      ) : (
                        <span style={{ fontSize: 12.5, color: on ? 'var(--fg)' : 'var(--fg-tertiary)' }}>
                          {f.display ?? (val || '（留空）')}
                        </span>
                      )}
                      <div className="muted" style={{ fontSize: 11, marginTop: 2, lineHeight: 1.5 }}>{f.source}</div>
                      {f.why ? <div className="muted" style={{ fontSize: 11, marginTop: 2, lineHeight: 1.5 }}>{f.why}</div> : null}
                    </div>
                  </div>
                );
              })}

              {/* ⑤ 派生字段（由入学年月带出，只展示不可改） */}
              {Object.keys(preview.draft.derived).length ? (
                <div className="muted" style={{ fontSize: 12, margin: '8px 0 0', paddingLeft: 130 }}>
                  由「入学年月」自动带出：
                  {Object.entries(preview.draft.derived).map(([k, v]) => `${k} ${v}`).join(' · ')}
                </div>
              ) : null}

              {/* ⑥ 不填的字段 —— 展示 + 说明原因 */}
              <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
                <div style={{ fontSize: 12, color: 'var(--fg-tertiary)', marginBottom: 8 }}>
                  以下**本次不写入**（不是漏了，每条都有原因）：
                </div>
                {skipped.map((f) => (
                  <div key={f.key} style={{ padding: '5px 0 5px 30px', fontSize: 12 }}>
                    <span style={{ color: 'var(--fg-secondary)' }}>{f.label}</span>
                    <span className="muted"> · {f.source}</span>
                    {f.why ? <div className="muted" style={{ fontSize: 11, marginTop: 2, lineHeight: 1.55 }}>{f.why}</div> : null}
                  </div>
                ))}
              </div>

              {/* ⑦ 顺带建立的关联 */}
              <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
                <div style={{ fontSize: 12, color: 'var(--fg-tertiary)', marginBottom: 8 }}>顺带建立关联（只动**该学生/该联系人名下**的记录，已有的关联不覆盖）：</div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, padding: '4px 0', cursor: 'pointer' }}>
                  <input type="checkbox" checked={bf.sourceFollowups} onChange={(e) => setBf((m) => ({ ...m, sourceFollowups: e.target.checked }))} />
                  <span>回填招生跟进记录<span className="muted"> · 按姓名精确匹配，命中 {preview.backfill.sourceFollowups} 条待回填</span></span>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, padding: '4px 0', cursor: 'pointer' }}>
                  <input type="checkbox" checked={bf.mail} onChange={(e) => setBf((m) => ({ ...m, mail: e.target.checked }))} />
                  <span>
                    回填相关邮件<span className="muted"> · 按姓名精确匹配，命中 {preview.backfill.mail} 封</span>
                  </span>
                </label>
                <div className="muted" style={{ fontSize: 11, marginTop: 4, lineHeight: 1.55 }}>
                  ⚠️ 邮件只能按**姓名**匹配（卫瓴联系人的「邮箱」字段全库 0 条有值，没有更可靠的键）⇒
                  邮件不多的学生建议关掉这一项。历史上断掉的关联（6404 封里只有 8 封有学生关联）不在本次范围内。
                </div>
              </div>
            </>
          ) : null}
        </>
      )}
    </Modal>
  );
}

export default WeilingEnrollModal;
