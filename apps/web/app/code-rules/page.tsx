'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import type {
  CodeFillPreview,
  CodePreviewItem,
  CodeRuleRow,
  CodeRulesView,
  CodeSegment,
  CodeSegmentKind,
} from '@acms/contracts';
import { api } from '../../lib/api';
import { humanizeError } from '../../lib/errMsg';
import { usePermissions } from '../../lib/permissions';

/**
 * 「代码规则」配置页（v14，2026-10-01 峰哥）。
 *
 * 管「一个编号怎么拼出来」——首批上「学籍号（脱敏）」，另登记「学生编号」（默认停用）。
 *
 * ── 三条设计原则（与「信号规则」「卫瓴映射」一致）──────────────────
 * ① **预览在服务端跑**：每次改动都 POST `/code-rules/preview`，用**生成时同一份**判据
 *    ⇒ 预览看到的号必然等于以后真生成的号。前端**不许自己算**（算出来必然漂移且不报错）。
 * ② **改一处即时预览**（不点按钮）—— 配规则是"试出来"的，来回点按钮会很烦。
 * ③ **批量补号两步走**：先预检（列出将生成的每一个号）→ 再确认。
 *    学籍号是登录凭证，写多条之前必须让人先看到。
 */
export default function CodeRulesPage() {
  const t = useTranslations('common');
  const perms = usePermissions();
  const canEdit = perms.includes('module:codeRules:update');

  const [view, setView] = useState<CodeRulesView | null>(null);
  const [draft, setDraft] = useState<CodeRuleRow[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [fill, setFill] = useState<{ ruleKey: string; preview: CodeFillPreview | null } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const v = await api.codeRulesGet();
      setView(v);
      setDraft(v.rules);
    } catch (e) {
      setErr(humanizeError(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** 改一处即时预览（走服务端，**不保存**） */
  const refreshPreview = useCallback(async (rules: CodeRuleRow[]) => {
    try {
      const v = await api.codeRulesPreview({ rules });
      // 只把 preview / conflicts / fieldValues 换掉，保留本地正在编辑的字段值
      setView((prev) => (prev ? { ...prev, conflicts: v.conflicts, fieldValues: v.fieldValues, meta: v.meta } : v));
      setDraft((prev) => prev.map((r) => ({ ...r, preview: v.rules.find((x) => x.key === r.key)?.preview ?? r.preview })));
    } catch {
      /* 试算失败不打断编辑：预览旧值 + 保存时再报错 */
    }
  }, []);

  const patchRule = useCallback(
    (key: string, patch: Partial<CodeRuleRow>) => {
      setDraft((prev) => {
        const next = prev.map((r) => (r.key === key ? { ...r, ...patch } : r));
        void refreshPreview(next);
        return next;
      });
    },
    [refreshPreview],
  );

  const patchSegment = useCallback(
    (ruleKey: string, idx: number, patch: Partial<CodeSegment>) => {
      setDraft((prev) => {
        const next = prev.map((r) => {
          if (r.key !== ruleKey) return r;
          const segs = r.segments.map((s, i) => (i === idx ? ({ ...s, ...patch } as CodeSegment) : s));
          return { ...r, segments: segs };
        });
        void refreshPreview(next);
        return next;
      });
    },
    [refreshPreview],
  );

  const moveSegment = useCallback(
    (ruleKey: string, idx: number, dir: -1 | 1) => {
      setDraft((prev) => {
        const next = prev.map((r) => {
          if (r.key !== ruleKey) return r;
          const segs = [...r.segments];
          const to = idx + dir;
          if (to < 0 || to >= segs.length) return r;
          const a = segs[idx];
          const b = segs[to];
          if (!a || !b) return r;
          segs[idx] = b;
          segs[to] = a;
          return { ...r, segments: segs };
        });
        void refreshPreview(next);
        return next;
      });
    },
    [refreshPreview],
  );

  const addSegment = useCallback(
    (ruleKey: string, kind: CodeSegmentKind) => {
      setDraft((prev) => {
        const next = prev.map((r) => (r.key === ruleKey ? { ...r, segments: [...r.segments, blankSegment(kind)] } : r));
        void refreshPreview(next);
        return next;
      });
    },
    [refreshPreview],
  );

  const removeSegment = useCallback(
    (ruleKey: string, idx: number) => {
      setDraft((prev) => {
        const next = prev.map((r) => (r.key === ruleKey ? { ...r, segments: r.segments.filter((_, i) => i !== idx) } : r));
        void refreshPreview(next);
        return next;
      });
    },
    [refreshPreview],
  );

  async function save() {
    setSaving(true);
    setErr('');
    setMsg('');
    try {
      const v = await api.codeRulesSave({ rules: draft });
      setView(v);
      setDraft(v.rules);
      setMsg('已保存。**已生成的号不会被追溯修改**，规则只影响以后新生成的号。');
      setEditing(null);
    } catch (e) {
      setErr(humanizeError(e));
    } finally {
      setSaving(false);
    }
  }

  async function doFillPreview(ruleKey: string) {
    setBusy(true);
    setErr('');
    setFill({ ruleKey, preview: null });
    try {
      setFill({ ruleKey, preview: await api.codeRulesFillPreview(ruleKey) });
    } catch (e) {
      setErr(humanizeError(e));
      setFill(null);
    } finally {
      setBusy(false);
    }
  }

  async function doFill(ruleKey: string) {
    setBusy(true);
    setErr('');
    try {
      const r = await api.codeRulesFill(ruleKey);
      setMsg(`已补 ${r.filled} 条（跳过已有值 ${r.skipped} 条）。`);
      setFill(null);
      await load();
    } catch (e) {
      setErr(humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(view?.rules ?? []),
    [draft, view],
  );

  if (loading) return <div className="page-header"><p>{t('loading')}…</p></div>;
  if (!view) return <div className="page-header"><p className="msg-error">{err || '加载失败'}</p></div>;

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <h1 style={{ margin: 0 }}>代码规则</h1>
          <p className="muted" style={{ margin: '4px 0 0', fontSize: 13 }}>
            编号（学籍号等）怎么生成。改这里 = 改<b>以后所有自动生成的编号</b>；<b>已生成的号不会被追溯修改</b>
            （追溯改号 = 有人登不上系统）。
          </p>
        </div>
        <button className="btn btn-ghost" onClick={() => void load()} disabled={saving}>重新加载</button>
        {canEdit ? (
          <button className="btn btn-primary" onClick={() => void save()} disabled={saving || !dirty}>
            {saving ? '保存中…' : dirty ? '保存' : '已保存'}
          </button>
        ) : null}
      </div>

      {err ? <div className="notice notice-error" style={{ marginBottom: 12 }}>{err}</div> : null}
      {msg ? <div className="notice notice-ok" style={{ marginBottom: 12 }}>{msg}</div> : null}
      {view.conflicts.length ? (
        <div className="notice notice-error" style={{ marginBottom: 12 }}>
          ⚠️ 同一目标字段被多条启用规则占用（生成时不知道用哪条，且不会报错）：
          <ul style={{ margin: '6px 0 0 18px' }}>
            {view.conflicts.map((c) => <li key={c}>{c}</li>)}
          </ul>
        </div>
      ) : null}

      {/* ── 一、规则列表 ───────────────────────────────── */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>目标字段</th>
                <th>规则名</th>
                <th>状态</th>
                <th>现有值</th>
                <th>预览（用真实记录试算）</th>
                <th style={{ width: 190 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {draft.map((r) => (
                <tr key={r.key}>
                  <td>
                    {r.targetField}
                    <div className="muted" style={{ fontSize: 11 }}>{r.targetTable}</div>
                  </td>
                  <td>{r.name}</td>
                  <td>
                    <span className={r.enabled ? 'badge badge-ok' : 'badge'}>{r.enabled ? '启用' : '停用'}</span>
                  </td>
                  <td>{r.existingCount}</td>
                  <td>
                    {r.preview.slice(0, 3).map((p) => (
                      <div key={p.label} style={{ fontSize: 12 }}>
                        <span className="mono">{p.code || '—'}</span>
                        <span className="muted"> · {p.label}</span>
                        {p.reason ? <span className="muted"> · {p.reason}</span> : null}
                      </div>
                    ))}
                  </td>
                  <td>
                    <button className="btn btn-ghost btn-sm" onClick={() => setEditing(editing === r.key ? null : r.key)}>
                      {editing === r.key ? '收起' : '编辑'}
                    </button>{' '}
                    {canEdit && r.enabled ? (
                      <button className="btn btn-ghost btn-sm" onClick={() => void doFillPreview(r.key)} disabled={busy}>
                        批量补号
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── 二、编辑规则 ───────────────────────────────── */}
      {editing ? (() => {
        const r = draft.find((x) => x.key === editing);
        if (!r) return null;
        return (
          <div className="card" style={{ marginBottom: 16 }}>
            <h2 style={{ marginTop: 0, fontSize: 16 }}>编辑规则：{r.name}</h2>

            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 14 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 220 }}>
                <span className="muted" style={{ fontSize: 12 }}>规则名</span>
                <input className="input" value={r.name} disabled={!canEdit}
                  onChange={(e) => patchRule(r.key, { name: e.target.value })} />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 240 }}>
                <span className="muted" style={{ fontSize: 12 }}>目标字段</span>
                <select className="input" value={`${r.targetTable}::${r.targetField}`} disabled={!canEdit}
                  onChange={(e) => {
                    const [tb, fd] = e.target.value.split('::');
                    patchRule(r.key, { targetTable: tb ?? '', targetField: fd ?? '' });
                  }}>
                  {view.meta.targets.map((tg) => (
                    <option key={`${tg.table}::${tg.field}`} value={`${tg.table}::${tg.field}`}>
                      {tg.tableLabel} · {tg.field}
                    </option>
                  ))}
                </select>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 20 }}>
                <input type="checkbox" checked={r.enabled} disabled={!canEdit}
                  onChange={(e) => patchRule(r.key, { enabled: e.target.checked })} />
                <span>启用</span>
              </label>
            </div>

            {/* 段 */}
            <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>段（从上到下拼装）</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {r.segments.map((s, i) => (
                <div key={`${r.key}-${i}`} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px' }}>
                  <span className="muted" style={{ width: 18, fontSize: 12 }}>{i + 1}</span>
                  <select className="input" style={{ width: 130 }} value={s.kind} disabled={!canEdit}
                    onChange={(e) => patchSegment(r.key, i, blankSegment(e.target.value as CodeSegmentKind))}>
                    {view.meta.segmentKinds.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
                  </select>
                  <SegmentFields seg={s} meta={view.meta} fieldValues={view.fieldValues} disabled={!canEdit}
                    onChange={(patch) => patchSegment(r.key, i, patch)} />
                  {canEdit ? (
                    <span style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                      <button className="btn btn-ghost btn-sm" onClick={() => moveSegment(r.key, i, -1)} disabled={i === 0}>↑</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => moveSegment(r.key, i, 1)} disabled={i === r.segments.length - 1}>↓</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => removeSegment(r.key, i)} disabled={r.segments.length <= 1}>×</button>
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
            {canEdit ? (
              <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                {view.meta.segmentKinds.map((k) => (
                  <button key={k.value} className="btn btn-ghost btn-sm" onClick={() => addSegment(r.key, k.value as CodeSegmentKind)}>
                    + {k.label}
                  </button>
                ))}
              </div>
            ) : null}

            {/* 全局选项 */}
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 14 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span className="muted" style={{ fontSize: 12 }}>段间分隔符</span>
                <select className="input" value={r.separator} disabled={!canEdit}
                  onChange={(e) => patchRule(r.key, { separator: e.target.value })}>
                  <option value="">无（用「固定文本」段自己写分隔）</option>
                  <option value="-">-</option><option value="/">/</option><option value=".">.</option>
                </select>
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span className="muted" style={{ fontSize: 12 }}>大小写</span>
                <select className="input" value={r.upperCase} disabled={!canEdit}
                  onChange={(e) => patchRule(r.key, { upperCase: e.target.value as CodeRuleRow['upperCase'] })}>
                  <option value="upper">大写</option><option value="lower">小写</option><option value="keep">保持</option>
                </select>
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span className="muted" style={{ fontSize: 12 }}>撞号策略</span>
                <select className="input" value={r.conflict} disabled={!canEdit}
                  onChange={(e) => patchRule(r.key, { conflict: e.target.value as CodeRuleRow['conflict'] })}>
                  {view.meta.conflicts.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, width: 110 }}>
                <span className="muted" style={{ fontSize: 12 }}>最多重试</span>
                <input type="number" className="input" value={r.conflictRetry} disabled={!canEdit}
                  onChange={(e) => patchRule(r.key, { conflictRetry: Number(e.target.value) })} />
              </label>
            </div>

            {/* 实时预览 */}
            <div style={{ marginTop: 14, background: 'var(--table-head-bg)', border: '1px solid var(--border)', borderRadius: 10, padding: 12 }}>
              <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
                实时预览（服务端算，与真正生成同一份判据）
              </div>
              {r.preview.map((p: CodePreviewItem) => (
                <div key={p.label} style={{ fontSize: 13 }}>
                  <span className="mono" style={{ fontSize: 15 }}>{p.code || '（生成不了）'}</span>
                  <span className="muted"> ← {p.label}</span>
                  {p.reason ? <span style={{ color: 'var(--danger)' }}> · {p.reason}</span> : null}
                </div>
              ))}
              {r.existingSamples.length ? (
                <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                  该字段现有样例：{r.existingSamples.join('、')}
                </div>
              ) : null}
            </div>
          </div>
        );
      })() : null}

      {/* ── 三、批量补号（预检 → 确认）───────────────────── */}
      {fill ? (
        <div className="card">
          <h2 style={{ marginTop: 0, fontSize: 16 }}>批量补号 · 预检（**尚未写入**）</h2>
          {!fill.preview ? <p className="muted">计算中…</p> : (
            <>
              <p style={{ fontSize: 13 }}>
                「{fill.preview.field}」：需要补 <b>{fill.preview.rows.length}</b> 条 ·
                已有值不动 <b>{fill.preview.skipped}</b> 条 · 当前已有 <b>{fill.preview.existingCount}</b> 条有值
              </p>
              {fill.preview.rows.length === 0 ? (
                <p className="muted">没有需要补号的记录。</p>
              ) : (
                <>
                  <div className="data-table-wrap" style={{ maxHeight: 320, overflow: 'auto' }}>
                    <table className="data-table">
                      <thead><tr><th>记录</th><th>将生成</th><th>说明</th></tr></thead>
                      <tbody>
                        {fill.preview.rows.slice(0, 200).map((row) => (
                          <tr key={row.id}>
                            <td>{row.name || row.id}</td>
                            <td className="mono">{row.code || '—'}</td>
                            <td className="muted">{row.reason ?? ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                    <button className="btn" onClick={() => setFill(null)}>取消</button>
                    {canEdit ? (
                      <button className="btn btn-primary" disabled={busy} onClick={() => void doFill(fill.ruleKey)}>
                        {busy ? '写入中…' : `确认补 ${fill.preview.rows.length} 条`}
                      </button>
                    ) : null}
                  </div>
                  <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                    ⚠️ 只补**空值**，绝不覆盖已有值 —— 学籍号是学生与家长的登录凭证，追溯改号会导致登不上。
                  </p>
                </>
              )}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

// ── 段参数编辑 ────────────────────────────────────────────────

function blankSegment(kind: CodeSegmentKind): CodeSegment {
  if (kind === 'date') return { kind: 'date', format: 'year2' };
  if (kind === 'field') return { kind: 'field', field: '', transform: 'raw', map: {}, mapMatch: 'exact' };
  if (kind === 'serial') return { kind: 'serial', digits: 3, start: 1, step: 1, cycle: 'term', scope: 'prefix', scopeField: '' };
  if (kind === 'random') return { kind: 'random', length: 4, charset: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' };
  return { kind: 'text', value: '' };
}

function SegmentFields({
  seg, meta, fieldValues, disabled, onChange,
}: {
  seg: CodeSegment;
  meta: CodeRulesView['meta'];
  fieldValues: CodeRulesView['fieldValues'];
  disabled: boolean;
  onChange: (patch: Partial<CodeSegment>) => void;
}) {
  if (seg.kind === 'text') {
    return (
      <input className="input" style={{ width: 130 }} placeholder="固定文本" value={seg.value} disabled={disabled}
        onChange={(e) => onChange({ value: e.target.value } as Partial<CodeSegment>)} />
    );
  }
  if (seg.kind === 'date') {
    return (
      <select className="input" style={{ width: 190 }} value={seg.format} disabled={disabled}
        onChange={(e) => onChange({ format: e.target.value as never } as Partial<CodeSegment>)}>
        {meta.dateFormats.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
      </select>
    );
  }
  if (seg.kind === 'field') {
    const opts = fieldValues[seg.field] ?? [];
    return (
      <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <select className="input" style={{ width: 150 }} value={seg.field} disabled={disabled}
          onChange={(e) => onChange({ field: e.target.value } as Partial<CodeSegment>)}>
          <option value="">（选字段）</option>
          {meta.fields.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
        <select className="input" style={{ width: 110 }} value={seg.transform} disabled={disabled}
          onChange={(e) => onChange({ transform: e.target.value as never } as Partial<CodeSegment>)}>
          {meta.fieldTransforms.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
        </select>
        <select className="input" style={{ width: 150 }} value={seg.mapMatch} disabled={disabled}
          onChange={(e) => onChange({ mapMatch: e.target.value as never } as Partial<CodeSegment>)}
          title="映射键的匹配方式：字段值是「26秋季」而键是「秋季」时要用「按结尾匹配」">
          {meta.mapMatches.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
        </select>
        <MapEditor map={seg.map} candidates={opts} disabled={disabled}
          onChange={(map) => onChange({ map } as Partial<CodeSegment>)} />
      </span>
    );
  }
  if (seg.kind === 'serial') {
    return (
      <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span className="muted" style={{ fontSize: 12 }}>位数</span>
          <input type="number" className="input" style={{ width: 64 }} value={seg.digits} disabled={disabled}
            onChange={(e) => onChange({ digits: Number(e.target.value) } as Partial<CodeSegment>)} />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span className="muted" style={{ fontSize: 12 }}>起始</span>
          <input type="number" className="input" style={{ width: 72 }} value={seg.start} disabled={disabled}
            onChange={(e) => onChange({ start: Number(e.target.value) } as Partial<CodeSegment>)} />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span className="muted" style={{ fontSize: 12 }}>步长</span>
          <input type="number" className="input" style={{ width: 64 }} value={seg.step} disabled={disabled}
            onChange={(e) => onChange({ step: Number(e.target.value) } as Partial<CodeSegment>)} />
        </label>
        <select className="input" style={{ width: 120 }} value={seg.cycle} disabled={disabled}
          onChange={(e) => onChange({ cycle: e.target.value as never } as Partial<CodeSegment>)}>
          {meta.resetCycles.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
        </select>
        <select className="input" style={{ width: 150 }} value={seg.scope} disabled={disabled}
          onChange={(e) => onChange({ scope: e.target.value as never } as Partial<CodeSegment>)}>
          {meta.resetScopes.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
        </select>
        {seg.scope === 'field' ? (
          <select className="input" style={{ width: 140 }} value={seg.scopeField} disabled={disabled}
            onChange={(e) => onChange({ scopeField: e.target.value } as Partial<CodeSegment>)}>
            <option value="">（选字段）</option>
            {meta.fields.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        ) : null}
      </span>
    );
  }
  return (
    <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <span className="muted" style={{ fontSize: 12 }}>长度</span>
        <input type="number" className="input" style={{ width: 64 }} value={seg.length} disabled={disabled}
          onChange={(e) => onChange({ length: Number(e.target.value) } as Partial<CodeSegment>)} />
      </label>
      <input className="input" style={{ width: 220 }} value={seg.charset} disabled={disabled}
        title="字符集（去掉易混淆的 0/O/1/I）"
        onChange={(e) => onChange({ charset: e.target.value } as Partial<CodeSegment>)} />
    </span>
  );
}

/**
 * 映射编辑：左列是该字段**真实出现过的取值**（带次数），右列填码。
 *
 * 🔴 候选来自真实数据、不是字典 —— 见 `CodeRulesService` 构造函数上的注释
 *   （映射的键必须与记录里存的值逐字一致，而 `26秋季` 这种值任何字典里都没有）。
 */
function MapEditor({
  map, candidates, disabled, onChange,
}: {
  map: Record<string, string>;
  candidates: { value: string; count: number }[];
  disabled: boolean;
  onChange: (map: Record<string, string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const keys = Object.keys(map);
  return (
    <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen((v) => !v)}>
        映射 {keys.length ? `(${keys.length})` : ''}
      </button>
      {open ? (
        <span style={{
          position: 'absolute', top: '100%', left: 0, zIndex: 30, marginTop: 4, width: 340,
          background: 'var(--surface)', border: '1px solid var(--border-strong)', borderRadius: 10,
          padding: 10, boxShadow: 'var(--shadow-card)', display: 'block',
        }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
            该字段真实取值（带出现次数）→ 填成什么
          </div>
          {candidates.length === 0 ? <div className="muted" style={{ fontSize: 12 }}>该字段暂无数据</div> : null}
          {candidates.map((c) => (
            <div key={c.value} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}>
              <span style={{ fontSize: 12, minWidth: 120 }} title={c.value}>
                {c.value} <span className="muted">({c.count})</span>
              </span>
              <input className="input" style={{ width: 90 }} value={map[c.value] ?? ''} disabled={disabled}
                placeholder="码"
                onChange={(e) => {
                  const next = { ...map };
                  if (e.target.value) next[c.value] = e.target.value;
                  else delete next[c.value];
                  onChange(next);
                }} />
            </div>
          ))}
          {keys.filter((k) => !candidates.some((c) => c.value === k)).map((k) => (
            <div key={k} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}>
              <span style={{ fontSize: 12, minWidth: 120 }} title={k}>{k} <span className="muted">(手填)</span></span>
              <input className="input" style={{ width: 90 }} value={map[k] ?? ''} disabled={disabled}
                onChange={(e) => {
                  const next = { ...map };
                  if (e.target.value) next[k] = e.target.value;
                  else delete next[k];
                  onChange(next);
                }} />
            </div>
          ))}
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <input className="input" style={{ width: 120 }} placeholder="键（如 秋季）" disabled={disabled}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                const v = (e.target as HTMLInputElement).value.trim();
                if (v) onChange({ ...map, [v]: '' });
                (e.target as HTMLInputElement).value = '';
              }} />
            <span className="muted" style={{ fontSize: 12, alignSelf: 'center' }}>回车添加一个键</span>
          </div>
        </span>
      ) : null}
    </span>
  );
}
