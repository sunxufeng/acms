'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { api, type FieldLevelCatalog, type FieldLevelPreview } from '../../lib/api';
import { useTl } from '../../lib/useTl';

/**
 * 数据密级（后台管理 · 仅系统管理员）
 *
 * 这一页管的是**字段级密级**：用户的有效密级低于某字段的密级时，该字段在
 * 列表 / 详情 / 导出里被打码（L4 全隐藏 ●●●，其余部分打码 138****8899），
 * 写库时还会剔除 —— 防止把打码值写回真实数据（见 shared/field-mask.ts）。
 *
 * ⚠️ 与「角色管理 · 数据范围」不是一回事，别混：
 *     · 数据范围（学生档案）管的是**整条记录**可见不可见；
 *     · 本页管的是**记录里的某个字段**要不要打码。
 *    两者叠加生效，且判据都在后端（前端只负责展示与保存）。
 *
 * 字段候选从后端 `acms_fields` 真实元数据来，**不让手打字段名** ——
 * 手打必错，且字段改名后密级会静默失效（谁也不会发现某字段不再打码）。
 */

/** 密级档位（与后端 FieldLevel.level 一致，1–4，0 = 不控制） */
const LEVEL_OPTIONS: { value: number; zh: string; en: string }[] = [
  { value: 0, zh: '不控制', en: 'Not controlled' },
  { value: 1, zh: 'L1 · 一般', en: 'L1 · Public' },
  { value: 2, zh: 'L2 · 内部', en: 'L2 · Internal' },
  { value: 3, zh: 'L3 · 敏感（部分打码）', en: 'L3 · Sensitive (partial mask)' },
  { value: 4, zh: 'L4 · 高度敏感（完全隐藏）', en: 'L4 · Highly sensitive (hidden)' },
];

/** 用户表「数据密级上限」的取值 → 引擎值（与用户管理页 LEVEL_OPTS 一致） */
const USER_LEVEL_KEY: Record<string, string> = {
  一般: 'L1',
  内部: 'L2',
  敏感: 'L3',
  高度敏感: 'L4',
  L4: 'L4',
};

const keyOf = (module: string, field: string) => `${module}|${field}`;

export default function DataLevelsPage() {
  const tl = useTl();
  const t = useTranslations('admin');
  const tc = useTranslations('common');

  const [catalog, setCatalog] = useState<FieldLevelCatalog | null>(null);
  const [draft, setDraft] = useState<Record<string, number>>({});
  const [baseline, setBaseline] = useState<Record<string, number>>({});
  const [users, setUsers] = useState<Record<string, unknown>[]>([]);
  const [openModules, setOpenModules] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);

  /* 预览 */
  const [previewModule, setPreviewModule] = useState('');
  const [previewLevel, setPreviewLevel] = useState('L1');
  const [preview, setPreview] = useState<FieldLevelPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError('');
      try {
        const c = await api.fieldLevelCatalog();
        setCatalog(c);
        const base: Record<string, number> = {};
        for (const l of c.controlled) base[keyOf(l.module, l.field)] = l.level;
        setBaseline(base);
        setDraft({ ...base });
        setOpenModules(Object.fromEntries(c.modules.map((m) => [m.key, true])));
        if (c.modules[0]) setPreviewModule(c.modules[0].key);
      } catch (e) {
        setError((e as Error).message || tl('加载失败'));
      } finally {
        setLoading(false);
      }
    })();
    // 🔴 依赖必须为空数组：字段目录与语言无关，只在进页面时取一次。
    //    曾经写的是 `[tl]`，而 `useTl()` 当时每次 render 都返回新函数 ⇒ effect 每轮都重跑
    //    ⇒ 一堆 setState ⇒ 再 render ⇒ **无限循环**（页面持续闪烁，且每圈发一次接口：
    //    生产实测同一秒 49 次请求）。`useTl` 已改为身份稳定，这里再收紧成 `[]`
    //    作为第二道保险 —— 即使以后有人把不稳定值放进依赖，也不会把这一页拖进循环。
    //    ⚠️ 注意 `tl` 内部走 ref 读最新 labels，所以闭包里拿到"旧"引用也仍会输出当前语言。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const page = await api.listUsers({ pageSize: '200' });
        setUsers((page.items ?? []) as Record<string, unknown>[]);
      } catch {
        /* 用户一览是辅助信息，取不到不影响配置密级 */
      }
    })();
  }, []);

  /** 按用户密级分组统计（让人一眼看出「L3/L4 字段对多少人打码」） */
  const userStats = useMemo(() => {
    const m = new Map<string, number>();
    for (const u of users) {
      const raw = String(u['数据密级上限'] ?? '').trim();
      const key = USER_LEVEL_KEY[raw] ?? 'L1';
      m.set(key, (m.get(key) ?? 0) + 1);
    }
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [users]);

  /** 变更清单（保存前必须让人看清影响，密级改动是静默生效的） */
  const diff = useMemo(() => {
    const added: string[] = [];
    const raised: string[] = [];
    const lowered: string[] = [];
    const removed: string[] = [];
    const allKeys = new Set([...Object.keys(baseline), ...Object.keys(draft)]);
    for (const k of allKeys) {
      const b = baseline[k] ?? 0;
      const d = draft[k] ?? 0;
      if (b === d) continue;
      const label = k.replace('|', ' / ');
      if (b === 0) added.push(label);
      else if (d === 0) removed.push(label);
      else if (d > b) raised.push(`${label}（L${b} → L${d}）`);
      else lowered.push(`${label}（L${b} → ${d}）`);
    }
    return { added, raised, lowered, removed, total: added.length + raised.length + lowered.length + removed.length };
  }, [baseline, draft]);

  const dirty = diff.total > 0;

  const setLevel = (module: string, field: string, level: number) => {
    setDraft((prev) => {
      const next = { ...prev };
      const k = keyOf(module, field);
      if (level === 0) delete next[k];
      else next[k] = level;
      return next;
    });
  };

  async function doSave() {
    setSaving(true);
    setMsg('');
    setError('');
    try {
      const levels = Object.entries(draft).map(([k, level]) => {
        const [module, field] = k.split('|');
        return { module: module ?? '', field: field ?? '', level };
      });
      await api.saveFieldLevels(levels);
      setBaseline({ ...draft });
      setConfirmOpen(false);
      setMsg(tc('saved'));
    } catch (e) {
      setError((e as Error).message || tl('保存失败'));
      setConfirmOpen(false);
    } finally {
      setSaving(false);
    }
  }

  async function runPreview(module: string, level: string) {
    setPreviewLoading(true);
    setPreview(null);
    try {
      setPreview(await api.fieldLevelPreview(module, level));
    } catch (e) {
      setError((e as Error).message || tl('预览失败'));
    } finally {
      setPreviewLoading(false);
    }
  }

  const controlledCount = Object.keys(draft).length;

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1 className="page-title">{tl('数据密级')}</h1>
          <p className="page-subtitle">
            {tl('配置哪些字段在密级不足时被打码或隐藏。用户的有效密级取「用户表 · 数据密级上限」；密码级不足时，该字段在列表、详情、导出里都会被脱敏，且不会被写回真实数据。')}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-secondary)' }}>
            {tl('受控字段')} <strong>{controlledCount}</strong>
          </span>
          <button className="btn btn-primary" disabled={!dirty || saving} onClick={() => setConfirmOpen(true)}>
            {saving ? tc('saving') : tl('保存')}
          </button>
        </div>
      </div>

      {error && (
        <div className="alert alert-danger" style={{ marginBottom: 'var(--space-md)' }}>
          {error}
        </div>
      )}
      {msg && (
        <div className="alert alert-success" style={{ marginBottom: 'var(--space-md)' }}>
          {msg}
        </div>
      )}

      {/* ① 用户密级一览：决定谁能看到受控字段 */}
      <div className="card" style={{ marginBottom: 'var(--space-lg)' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8 }}>
          <h2 style={{ fontSize: 15, fontWeight: 500, margin: 0 }}>{tl('用户密级分布')}</h2>
          <span style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-tertiary)' }}>
            {tl('共')} {users.length} {tl('个账号；密级低于字段密级的人，看到的是打码值')}
          </span>
        </div>
        {userStats.length === 0 ? (
          <div style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-tertiary)' }}>{tl('（读不到用户列表，不影响下方配置）')}</div>
        ) : (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {userStats.map(([level, n]) => (
              <span key={level} className="tag" style={{ padding: '4px 10px' }}>
                {level} · {n} {tl('人')}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* ② 字段密级（按模块分组） */}
      {loading ? (
        <div style={{ color: 'var(--fg-tertiary)', fontSize: 'var(--font-sm)' }}>{tl('加载中')}</div>
      ) : (
        (catalog?.modules ?? []).map((m) => {
          const controlledInModule = m.fields.filter((f) => (draft[keyOf(m.key, f.name)] ?? 0) > 0).length;
          const open = openModules[m.key] !== false;
          return (
            <div className="card" key={m.key} style={{ marginBottom: 'var(--space-md)' }}>
              <div
                style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}
                onClick={() => setOpenModules((p) => ({ ...p, [m.key]: !open }))}
              >
                <span style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-tertiary)' }}>{open ? '▾' : '▸'}</span>
                <strong style={{ fontSize: 14, fontWeight: 500 }}>{m.label}</strong>
                <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>{m.tableName} · {m.fields.length} {tl('个可选字段')}</span>
                <span style={{ fontSize: 'var(--font-xs)', color: controlledInModule ? 'var(--accent)' : 'var(--fg-tertiary)' }}>
                  {tl('已配')} {controlledInModule}
                </span>
                <button
                  type="button"
                  className="btn btn-sm"
                  style={{ marginLeft: 'auto' }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setPreviewModule(m.key);
                    runPreview(m.key, previewLevel);
                  }}
                >
                  {tl('预览打码效果')}
                </button>
              </div>

              {open && (
                <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 8 }}>
                  {m.fields.length === 0 && (
                    <div style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-tertiary)' }}>
                      {tl('该表还没有字段元数据（未初始化过）')}
                    </div>
                  )}
                  {m.fields.map((f) => {
                    const cur = draft[keyOf(m.key, f.name)] ?? 0;
                    return (
                      <label
                        key={f.name}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          padding: '4px 8px',
                          borderRadius: 8,
                          border: `1px solid ${cur > 0 ? 'var(--accent-soft)' : 'var(--border)'}`,
                          background: cur > 0 ? 'var(--accent-muted)' : undefined,
                        }}
                      >
                        <span
                          style={{ flex: 1, minWidth: 0, fontSize: 'var(--font-sm)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                          title={f.name}
                        >
                          {f.name}
                        </span>
                        <select
                          className="input"
                          style={{ width: 150, fontSize: 'var(--font-xs)' }}
                          value={cur}
                          onChange={(e) => setLevel(m.key, f.name, Number(e.target.value))}
                        >
                          {LEVEL_OPTIONS.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.zh}
                            </option>
                          ))}
                        </select>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })
      )}

      {/* ③ 预览：拿真实记录看打码效果（密级配错是静默的，必须能先看一眼） */}
      <div className="card" style={{ marginBottom: 'var(--space-lg)' }}>
        <h2 style={{ fontSize: 15, fontWeight: 500, margin: '0 0 8px' }}>{tl('打码预览')}</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
          <select className="input" style={{ width: 180 }} value={previewModule} onChange={(e) => setPreviewModule(e.target.value)}>
            {(catalog?.modules ?? []).map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
          </select>
          <span style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-secondary)' }}>{tl('模拟用户密级')}</span>
          <select className="input" style={{ width: 120 }} value={previewLevel} onChange={(e) => setPreviewLevel(e.target.value)}>
            {['L1', 'L2', 'L3', 'L4'].map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
          <button className="btn btn-sm" disabled={!previewModule || previewLoading} onClick={() => runPreview(previewModule, previewLevel)}>
            {previewLoading ? tl('预览中') : tl('看效果')}
          </button>
          <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>
            {tl('取该模块一条真实记录，按上面的密级跑一遍脱敏；不显示未受控字段')}
          </span>
        </div>
        {preview && (
          <table className="table" style={{ fontSize: 'var(--font-sm)' }}>
            <thead>
              <tr>
                <th>{tl('字段')}</th>
                <th style={{ width: 60 }}>{tl('密级')}</th>
                <th>{tl('原值')}</th>
                <th>{tl('该密级用户看到')}</th>
              </tr>
            </thead>
            <tbody>
              {preview.controlled.length === 0 && (
                <tr>
                  <td colSpan={4} style={{ color: 'var(--fg-tertiary)' }}>
                    {preview.found ? tl('该模块还没有受控字段') : tl('该模块暂时取不到记录（表为空或无字段元数据）')}
                  </td>
                </tr>
              )}
              {preview.controlled.map((c) => (
                <tr key={c.field}>
                  <td>{c.field}</td>
                  <td>L{c.level}</td>
                  <td style={{ color: 'var(--fg-secondary)' }}>{c.before || '—'}</td>
                  <td style={{ fontWeight: c.after !== c.before ? 500 : 400 }}>{c.after || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* 保存前确认：列出每一项变更，避免"点保存时并不知道自己改了什么" */}
      {confirmOpen && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(0,0,0,0.35)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 50,
          }}
        >
          <div className="card" style={{ maxWidth: 620, width: '92%', maxHeight: '80vh', overflow: 'auto' }}>
            <h2 style={{ fontSize: 15, fontWeight: 500, margin: '0 0 8px' }}>{tl('确认保存字段密级')}</h2>
            <p style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-secondary)', marginTop: 0 }}>
              {tl('保存后立即对全站生效（列表、详情、导出、写库剔除）。共')} {diff.total} {tl('项变更：')}
            </p>
            {diff.added.length > 0 && (
              <div style={{ fontSize: 'var(--font-sm)', marginBottom: 6 }}>
                <strong>{tl('新增受控')}（{diff.added.length}）</strong>：{diff.added.join('、')}
              </div>
            )}
            {diff.raised.length > 0 && (
              <div style={{ fontSize: 'var(--font-sm)', marginBottom: 6 }}>
                <strong>{tl('收紧')}（{diff.raised.length}）</strong>：{diff.raised.join('、')}
              </div>
            )}
            {diff.lowered.length > 0 && (
              <div style={{ fontSize: 'var(--font-sm)', marginBottom: 6 }}>
                <strong>{tl('放宽')}（{diff.lowered.length}）</strong>：{diff.lowered.join('、')}
              </div>
            )}
            {diff.removed.length > 0 && (
              <div style={{ fontSize: 'var(--font-sm)', marginBottom: 6 }}>
                <strong>{tl('取消受控')}（{diff.removed.length}）</strong>：{diff.removed.join('、')}
              </div>
            )}
            <div style={{ display: 'flex', gap: 12, marginTop: 'var(--space-md)' }}>
              <button className="btn btn-primary" disabled={saving} onClick={doSave}>
                {saving ? tc('saving') : tc('confirm')}
              </button>
              <button className="btn" disabled={saving} onClick={() => setConfirmOpen(false)}>
                {tc('cancel')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
