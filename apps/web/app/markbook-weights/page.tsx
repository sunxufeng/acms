'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { api } from '../../lib/api';
import { usePermissions } from '../../lib/permissions';

/**
 * 成绩类型权重（教学管理）—— 2026-09-20 从「逐条录表单」改成**批量配置**。
 *
 * 它是权重的**第二层**：某一行的权重 = `成绩册列.列权重` × 本表 `班级 × 考核类型` 的权重。
 * 用它的场景是「整类统一调」：让「期末」这类整体比「作业」重，不必逐列去改。
 *
 * 🔴 为什么换成批量向导：原来是一张一条地建（选班 → 选类型 → 填权重 → 保存 ×N），
 * 一个班 7 个考核类型就要点 20 多次，而且**容易漏**（漏一个类型 = 那一类按缺省权重算，不报错）。
 * 现在的动线：选班 → 选考核类型组 → 勾选类型 → 「统一填为 N」→ 保存。
 *
 * 🔴 三个必须写在页面上的事实（否则会静默配错）：
 *  1. **实际匹配用的是「班级」文本**，不是「教学班」。服务端 `configsOf` 拿
 *     `normClass(权重.班级) === 成绩册当前班级` 匹配（班级 = 学生档案的「当前年级」）。
 *     只填「教学班」不填「班级」⇒ 权重**静默不生效**（总评看着就是没加权）。
 *  2. **不需要凑成 100**：汇总口径是「分母 = 实际参与项的权重和」（自归一化）。
 *     写成 40/30/20/10 更好读，但不凑 100 也不会算错。
 *  3. **考核类型名是逐字匹配的键**：候选必须来自「考核类型」表（不是字典，也不是手打），
 *     两份名单会漂移 ⇒ 改名后权重静默不生效。
 *
 * ⚠️ 停用考核类型组里的类型不进候选 —— 那是我们刚上的规则（停用 = 不许再选）。
 */

interface Group {
  id: string;
  组名称: string;
  状态?: string;
  排序?: number | string;
}

interface TypeRow {
  name: string;
  /** 类型表上的缺省权重（本班没配时按它算） */
  defaultWeight: number | null;
  color: string;
  counted: boolean;
}

interface ExistingRow {
  id: string;
  类型: string;
  权重: number | null;
}

const num = (v: unknown): number | null => {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export default function MarkbookWeightsPage() {
  const t = useTranslations('teaching');
  const perms = usePermissions();
  const canUpdate = perms.includes('module:markbookWeights:update');
  const canCreate = perms.includes('module:markbookWeights:create');
  const canDelete = perms.includes('module:markbookWeights:delete');

  const [classes, setClasses] = useState<string[]>([]);
  const [cls, setCls] = useState('');

  const [groups, setGroups] = useState<Group[]>([]);
  const [groupId, setGroupId] = useState('');

  const [types, setTypes] = useState<TypeRow[]>([]);
  const [existing, setExisting] = useState<ExistingRow[]>([]);

  /** 勾选的类型名。默认**全选** —— 最常见的意图就是「给这一组统一权重」 */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** 每个类型的输入框值（字符串，空 = 不写这一项） */
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [bulk, setBulk] = useState('');

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error' | 'info'; text: string } | null>(null);

  // ── 班级候选（字典「当前年级」，与成绩册分组、学生档案同一份名单）────────────
  useEffect(() => {
    let alive = true;
    api
      .dictionaries()
      .then((d) => {
        if (alive) setClasses(d['当前年级'] ?? []);
      })
      .catch(() => {
        if (alive) setClasses([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  // ── 考核类型组（停用的组不可选：那是我们刚上的规则）────────────────────────
  useEffect(() => {
    let alive = true;
    api
      .examTypeGroups.list({ pageSize: '200' })
      .then((r) => {
        if (!alive) return;
        const items: Group[] = (r?.items ?? [])
          .map((g) => ({
            id: String((g as { id?: string }).id ?? ''),
            组名称: String(g['组名称'] ?? ''),
            状态: String(g['状态'] ?? ''),
            排序: g['排序'] as number | string | undefined,
          }))
          .filter((g) => g.id);
        items.sort(
          (a, b) => (num(a.排序) ?? 0) - (num(b.排序) ?? 0) || a.组名称.localeCompare(b.组名称, 'zh-CN'),
        );
        setGroups(items);
        // 默认落在第一个**启用**的组（全是停用就选第一个，否则右侧空空如也）
        const first = items.find((g) => g.状态 !== '停用') ?? items[0];
        if (first) setGroupId(first.id);
      })
      .catch(() => {
        if (alive) setGroups([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  const loadExisting = useCallback(async (c: string) => {
    if (!c) {
      setExisting([]);
      return;
    }
    try {
      const r = await api.markbookWeights.list({ 班级: c, pageSize: '200' });
      setExisting(
        (r?.items ?? [])
          .map((w) => ({
            id: String((w as { id?: string }).id ?? ''),
            类型: String(w['类型'] ?? ''),
            权重: num(w['权重']),
          }))
          .filter((w) => w.id && w.类型),
      );
    } catch {
      setExisting([]);
    }
  }, []);

  useEffect(() => {
    void loadExisting(cls);
  }, [cls, loadExisting]);

  /**
   * 拉「当前组下的考核类型」。
   *
   * 用 `/exam-types`（带 `所属考核类型组__contains`）而不是 `/markbook/type-options`：
   * 后者只给名称、且会过滤掉停用组 —— 这里需要缺省权重/颜色来做展示，
   * 而「停用组不可选」由上面组下拉里就禁用了（更早一步，更清楚）。
   */
  useEffect(() => {
    if (!groupId) {
      setTypes([]);
      return;
    }
    let alive = true;
    setLoading(true);
    api
      .examTypes.list({ pageSize: '200', 所属考核类型组__contains: groupId })
      .then((r) => {
        if (!alive) return;
        const rows: TypeRow[] = (r?.items ?? [])
          .map((x) => ({
            name: String(x['类型名称'] ?? '').trim(),
            defaultWeight: num(x['缺省权重']),
            color: String(x['颜色'] ?? '').trim(),
            counted: String(x['计入总评'] ?? '是') !== '否',
          }))
          .filter((x) => x.name)
          .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
        setTypes(rows);
        // 换组：默认全选，并把已有权重带进输入框（空 = 未配置）
        setSelected(new Set(rows.map((x) => x.name)));
      })
      .catch(() => {
        if (alive) setTypes([]);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [groupId]);

  /** 已有权重：类型 → 记录 */
  const existingByType = useMemo(() => {
    const m = new Map<string, ExistingRow>();
    for (const e of existing) m.set(e.类型, e);
    return m;
  }, [existing]);

  /** 输入框里没值时显示已有/缺省，让用户知道「现在实际按多少算」 */
  const effectiveOf = (name: string): string => {
    const d = draft[name];
    if (d !== undefined && d !== '') return d;
    const own = existingByType.get(name)?.权重;
    if (own != null) return String(own);
    const def = types.find((x) => x.name === name)?.defaultWeight;
    return def != null ? String(def) : '';
  };

  const applyBulk = () => {
    const v = bulk.trim();
    if (!v) {
      setMsg({ kind: 'error', text: t('wizErrBulkEmpty') });
      return;
    }
    if (!Number.isFinite(Number(v)) || Number(v) <= 0) {
      setMsg({ kind: 'error', text: t('wizErrBulkNumber') });
      return;
    }
    setDraft((d) => {
      const next = { ...d };
      for (const n of selected) next[n] = v;
      return next;
    });
    setMsg({ kind: 'info', text: t('wizBulkFilled', { count: selected.size, value: v }) });
  };

  const save = async () => {
    if (!cls) {
      setMsg({ kind: 'error', text: t('wizNeedClass') });
      return;
    }
    const picked = types.filter((x) => selected.has(x.name));
    const todo = picked
      .map((x) => ({ type: x.name, value: num(draft[x.name] ?? effectiveOf(x.name)) }))
      .filter((x) => x.value != null && x.value > 0);
    if (!todo.length) {
      setMsg({ kind: 'error', text: t('wizErrNothing') });
      return;
    }
    if (!canUpdate || (!canCreate && todo.some((x) => !existingByType.has(x.type)))) {
      setMsg({ kind: 'error', text: t('noEditPerm') });
      return;
    }
    setBusy(true);
    setMsg({ kind: 'info', text: t('wizSaving') });
    let created = 0;
    let updated = 0;
    const failed: string[] = [];
    // 串行：避免同一班级并发写同一张表时出现「读-改-写」互相覆盖
    for (const item of todo) {
      try {
        const has = existingByType.get(item.type);
        if (has) {
          await api.markbookWeights.update(has.id, { 班级: cls, 类型: item.type, 权重: item.value });
          updated += 1;
        } else {
          await api.markbookWeights.create({ 班级: cls, 类型: item.type, 权重: item.value });
          created += 1;
        }
      } catch {
        failed.push(item.type);
      }
    }
    setBusy(false);
    await loadExisting(cls);
    setMsg(
      failed.length
        ? { kind: 'error', text: t('wizSavedPartial', { created, updated, failed: failed.join('、') }) }
        : { kind: 'ok', text: t('wizSaved', { created, updated }) },
    );
  };

  const remove = async (e: ExistingRow) => {
    if (!canDelete) return;
    if (!window.confirm(t('wizConfirmDelete', { type: e.类型 }))) return;
    setBusy(true);
    try {
      await api.markbookWeights.archive(e.id);
      await loadExisting(cls);
      setMsg({ kind: 'ok', text: t('wizDeleted', { type: e.类型 }) });
    } catch (err) {
      setMsg({ kind: 'error', text: String((err as { message?: string })?.message ?? err) });
    } finally {
      setBusy(false);
    }
  };

  const activeGroup = groups.find((g) => g.id === groupId);

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('titleWeights')}</h1>
          <p className="page-subtitle">{t('subtitleWeights')}</p>
        </div>
      </div>

      {/* ── ① 选班级 + 选考核类型组 ───────────────────────────────── */}
      <div className="card" style={{ padding: '16px 18px', marginBottom: 14 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-end' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 180 }}>
            <span style={{ fontSize: 'var(--font-sm)', fontWeight: 600 }}>{t('wizClass')}</span>
            <select
              className="form-input"
              value={cls}
              onChange={(e) => {
                setCls(e.target.value);
                setMsg(null);
              }}
            >
              <option value="">{t('wizPickClass')}</option>
              {classes.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <span className="muted" style={{ fontSize: 'var(--font-xs)' }}>
              {t('hintWeightClass')}
            </span>
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 180 }}>
            <span style={{ fontSize: 'var(--font-sm)', fontWeight: 600 }}>{t('wizGroup')}</span>
            <select
              className="form-input"
              value={groupId}
              disabled={!cls || groups.length === 0}
              onChange={(e) => {
                setGroupId(e.target.value);
                setDraft({});
                setMsg(null);
              }}
            >
              <option value="">{t('wizPickGroup')}</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id} disabled={g.状态 === '停用'}>
                  {g.组名称 || t('unnamedGroup')}
                  {g.状态 === '停用' ? `（${t('colStatusStop')}）` : ''}
                </option>
              ))}
            </select>
            <span className="muted" style={{ fontSize: 'var(--font-xs)' }}>
              {t('wizGroupHint')}
            </span>
          </label>
        </div>
      </div>

      {!cls ? (
        <div className="card" style={{ padding: '28px 18px', textAlign: 'center', color: 'var(--fg-secondary)' }}>
          {t('wizNeedClassStep')}
        </div>
      ) : !groupId ? (
        <div className="card" style={{ padding: '28px 18px', textAlign: 'center', color: 'var(--fg-secondary)' }}>
          {t('wizNeedGroupStep')}
        </div>
      ) : loading ? (
        <div className="dept-loading">{t('wizLoading')}</div>
      ) : types.length === 0 ? (
        <div className="card" style={{ padding: '28px 18px', textAlign: 'center', color: 'var(--fg-secondary)' }}>
          {t('wizNoTypes')}
        </div>
      ) : (
        <>
          {/* ── ② 批量操作条 ─────────────────────────────────────── */}
          <div className="card" style={{ padding: '12px 18px', marginBottom: 14 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => setSelected(new Set(types.map((x) => x.name)))}
              >
                {t('wizSelectAll')}
              </button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSelected(new Set())}>
                {t('wizClear')}
              </button>
              <span className="muted" style={{ fontSize: 'var(--font-xs)' }}>
                {t('wizSelectedCount', { count: selected.size, total: types.length })}
              </span>
              <span style={{ flex: 1 }} />
              <input
                className="form-input"
                style={{ width: 110 }}
                inputMode="decimal"
                placeholder={t('wizBulkPlaceholder')}
                value={bulk}
                onChange={(e) => setBulk(e.target.value)}
              />
              <button type="button" className="btn btn-sm" disabled={busy || !selected.size} onClick={applyBulk}>
                {t('wizBulkApply')}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={busy || !selected.size}
                onClick={() => void save()}
              >
                {busy ? t('wizSaving') : t('wizSave', { count: selected.size })}
              </button>
            </div>
            <div className="muted" style={{ fontSize: 'var(--font-xs)', marginTop: 8 }}>
              {t('wizBulkHint')}
            </div>
          </div>

          {/* ── ③ 类型勾选表 ─────────────────────────────────────── */}
          <div className="card" style={{ padding: '6px 10px', marginBottom: 14 }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: 42 }} />
                  <th>{t('colWeightType')}</th>
                  <th style={{ width: 150 }}>{t('colWeightValue')}</th>
                  <th style={{ width: 190 }}>{t('wizCurrent')}</th>
                </tr>
              </thead>
              <tbody>
                {types.map((x) => {
                  const on = selected.has(x.name);
                  const has = existingByType.get(x.name);
                  return (
                    <tr
                      key={x.name}
                      onClick={() => {
                        setSelected((s) => {
                          const n = new Set(s);
                          if (n.has(x.name)) n.delete(x.name);
                          else n.add(x.name);
                          return n;
                        });
                      }}
                      style={{ cursor: 'pointer', opacity: on ? 1 : 0.55 }}
                    >
                      <td onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" checked={on} onChange={() => undefined} />
                      </td>
                      <td>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                          {x.color ? (
                            <span
                              style={{
                                width: 10,
                                height: 10,
                                borderRadius: 3,
                                background: x.color,
                                display: 'inline-block',
                              }}
                            />
                          ) : null}
                          <span style={{ fontWeight: 600 }}>{x.name}</span>
                          {x.counted ? null : <span className="muted" style={{ fontSize: 11 }}>· {t('wizNotCounted')}</span>}
                        </span>
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <input
                          className="form-input"
                          inputMode="decimal"
                          placeholder={t('wizUnset')}
                          value={effectiveOf(x.name)}
                          onChange={(e) => {
                            const v = e.target.value;
                            setDraft((d) => ({ ...d, [x.name]: v }));
                            // 改了值就顺势勾上：手都伸到这一行了，多半是要写它
                            setSelected((s) => {
                              const n = new Set(s);
                              n.add(x.name);
                              return n;
                            });
                          }}
                        />
                      </td>
                      <td className="muted" style={{ fontSize: 'var(--font-xs)' }}>
                        {has
                          ? t('wizConfigured', { value: has.权重 ?? '—' })
                          : t('wizUsingDefault', { value: x.defaultWeight ?? 1 })}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* ── ④ 该班已配置的权重 ───────────────────────────────────── */}
      <div className="card" style={{ padding: '14px 18px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <span style={{ fontSize: 'var(--font-sm)', fontWeight: 600 }}>
            {cls ? t('wizExistingOf', { cls }) : t('wizExisting')}
          </span>
          <span className="muted" style={{ fontSize: 'var(--font-xs)' }}>
            {t('wizExistingHint')}
          </span>
        </div>
        {existing.length === 0 ? (
          <div className="muted" style={{ fontSize: 'var(--font-xs)', padding: '10px 0' }}>
            {t('wizNoExisting')}
          </div>
        ) : (
          <table className="data-table" style={{ marginTop: 8 }}>
            <thead>
              <tr>
                <th>{t('colWeightType')}</th>
                <th style={{ width: 120 }}>{t('colWeightValue')}</th>
                <th style={{ width: 90 }} />
              </tr>
            </thead>
            <tbody>
              {existing.map((e) => (
                <tr key={e.id}>
                  <td>{e.类型}</td>
                  <td>{e.权重 ?? '—'}</td>
                  <td>
                    {canDelete ? (
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        disabled={busy}
                        onClick={() => void remove(e)}
                      >
                        {t('delete')}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {activeGroup?.状态 === '停用' ? (
        <div className="notice notice-info" style={{ marginTop: 12 }}>
          {t('wizGroupStoppedHint')}
        </div>
      ) : null}

      {msg ? (
        <div
          className={`notice ${msg.kind === 'ok' ? 'notice-ok' : msg.kind === 'error' ? 'notice-error' : 'notice-info'}`}
          style={{ marginTop: 12 }}
        >
          {msg.text}
        </div>
      ) : null}
    </div>
  );
}
