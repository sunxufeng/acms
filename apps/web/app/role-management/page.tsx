'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useTl } from '../../lib/useTl';
import { api, type RoleManagementPayload } from '../../lib/api';
import {
  groupPermissions,
  PERMISSION_LABELS,
  MODULE_RESOURCES,
  MODULE_ACTION_LABELS,
  DEFAULT_NAV_MENU_CONFIG,
  type NavMenuConfig,
  type Permission,
  type ModuleAction,
  type DataLevel,
  type RoleDef,
} from '@acms/contracts';

/** 矩阵列顺序（与 MODULE_ACTION_LABELS 一致的展示顺序） */
const MATRIX_ACTIONS: ModuleAction[] = [
  'enter',
  'read',
  'create',
  'update',
  'delete',
  'import',
  'export',
  'refresh',
  'transition',
];

const LEVEL_LABELS: Record<string, string> = {
  L1: 'L1（一般）',
  L2: 'L2（内部）',
  L3: 'L3（敏感）',
  L4: 'L4（高度敏感）',
};

/** 数据密级选项：value 是存储值（L1~L4），展示文案由 sidecar 键提供 */
const LEVEL_LABEL_KEYS: Record<string, string> = {
  L1: 'levelL1',
  L2: 'levelL2',
  L3: 'levelL3',
  L4: 'levelL4',
};

interface Draft {
  key: string;
  label: string;
  permissions: string[];
  maxDataLevel: string;
  /** 菜单可见性白名单；undefined = 不限制（按权限点自动显隐） */
  menus?: string[];
  protected?: boolean;
  lockedPermissions?: boolean;
  isNew?: boolean;
}

export default function RoleManagementPage() {
  const tl = useTl();
  const t = useTranslations('admin');
  const tc = useTranslations('common');
  const ts = useTranslations('settings');
  const [config, setConfig] = useState<RoleManagementPayload | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [menuConfig, setMenuConfig] = useState<NavMenuConfig | null>(null);
  const [menuQuery, setMenuQuery] = useState('');
  /** 权限分配视图：矩阵（模块×操作）/ 列表（按权限域） */
  const [permView, setPermView] = useState<'matrix' | 'list'>('matrix');
  const [moduleQuery, setModuleQuery] = useState('');
  /** 复制本角色模块权限的目标角色 */
  const [copyTarget, setCopyTarget] = useState('');

  async function load() {
    setLoading(true);
    setError('');
    try {
      const d = await api.getRoleManagement();
      setConfig(d);
      if (!selectedKey && d.roles.length) {
        selectRole(d.roles[0]);
      }
    } catch {
      setError(tc('loadFailed'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function selectRole(r: RoleDef) {
    setSelectedKey(r.key);
    setDraft({
      key: r.key,
      label: r.label,
      permissions: [...r.permissions],
      maxDataLevel: r.maxDataLevel,
      menus: r.menus && r.menus.length ? [...r.menus] : undefined,
      protected: r.protected,
      lockedPermissions: r.lockedPermissions,
      isNew: false,
    });
    setMsg(null);
  }

  const groups = useMemo(
    () => (draft ? groupPermissions(config?.allPermissions ?? []) : []),
    [draft, config],
  );

  // 菜单可见性：菜单清单取自系统菜单配置（与侧边栏同源）
  useEffect(() => {
    api.getMenuConfig().then(setMenuConfig).catch(() => null);
  }, []);

  const menuItems = useMemo(
    () => (menuConfig?.items?.length ? menuConfig.items : DEFAULT_NAV_MENU_CONFIG.items),
    [menuConfig],
  );
  const allMenuKeys = useMemo(() => menuItems.map((i) => i.key), [menuItems]);
  const filteredMenuGroups = useMemo(() => {
    const q = menuQuery.trim().toLowerCase();
    const hit = menuItems.filter(
      (i) => !q || i.label.toLowerCase().includes(q) || i.key.toLowerCase().includes(q),
    );
    const m = new Map<string, typeof menuItems>();
    for (const it of hit) {
      const section = it.section ?? '未分组';
      const list = m.get(section);
      if (list) list.push(it);
      else m.set(section, [it]);
    }
    return [...m.entries()].map(([section, items]) => ({ section, items }));
  }, [menuItems, menuQuery]);

  function togglePerm(p: string) {
    if (!draft || draft.lockedPermissions) return;
    setDraft((prev) => {
      if (!prev) return prev;
      const has = prev.permissions.includes(p);
      return {
        ...prev,
        permissions: has ? prev.permissions.filter((x) => x !== p) : [...prev.permissions, p],
      };
    });
  }

  /** 矩阵单元：切换单个 module:<key>:<action> */
  function toggleModuleAction(key: string, action: ModuleAction, on: boolean) {
    if (!draft || draft.lockedPermissions) return;
    const p = `module:${key}:${action}` as Permission;
    setDraft((prev) => {
      if (!prev) return prev;
      const set = new Set(prev.permissions);
      if (on) set.add(p);
      else set.delete(p);
      return { ...prev, permissions: [...set] };
    });
  }

  /** 矩阵行全选/清空：某模块的全部可用操作 */
  function toggleModuleRow(key: string, actions: readonly ModuleAction[], on: boolean) {
    if (!draft || draft.lockedPermissions) return;
    setDraft((prev) => {
      if (!prev) return prev;
      const set = new Set(prev.permissions);
      for (const a of actions) {
        const p = `module:${key}:${a}` as Permission;
        if (on) set.add(p);
        else set.delete(p);
      }
      return { ...prev, permissions: [...set] };
    });
  }

  /** 矩阵列全选/清空：某操作横跨所有具备该操作的模块 */
  function toggleActionCol(action: ModuleAction, on: boolean) {
    if (!draft || draft.lockedPermissions) return;
    setDraft((prev) => {
      if (!prev) return prev;
      const set = new Set(prev.permissions);
      for (const r of MODULE_RESOURCES) {
        if (!r.actions.includes(action)) continue;
        const p = `module:${r.key}:${action}` as Permission;
        if (on) set.add(p);
        else set.delete(p);
      }
      return { ...prev, permissions: [...set] };
    });
  }

  /** 矩阵批量：all=全选 / clear=清空 / invert=反选（仅作用于 module:* 权限点） */
  function matrixBulk(mode: 'all' | 'clear' | 'invert') {
    if (!draft || draft.lockedPermissions) return;
    setDraft((prev) => {
      if (!prev) return prev;
      const set = new Set(prev.permissions);
      const all = MODULE_RESOURCES.flatMap((r) =>
        r.actions.map((a) => `module:${r.key}:${a}` as Permission),
      );
      if (mode === 'all') all.forEach((p) => set.add(p));
      else if (mode === 'clear') all.forEach((p) => set.delete(p));
      else all.forEach((p) => (set.has(p) ? set.delete(p) : set.add(p)));
      return { ...prev, permissions: [...set] };
    });
  }

  /** 将当前角色的模块权限复制给另一角色（合并，不覆盖其原有其它权限） */
  async function copyMatrixToRole() {
    if (!draft || !copyTarget || copyTarget === draft.key) return;
    const target = config?.roles.find((r) => r.key === copyTarget);
    if (!target) return;
    if (!confirm(`将「${draft.label}」的全部模块权限复制给「${target.label}」？\n（合并模式：仅追加模块权限，不改动其原有其它权限）`)) return;
    const moduleSet = new Set(
      MODULE_RESOURCES.flatMap((r) => r.actions.map((a) => `module:${r.key}:${a}` as Permission)),
    );
    const merged = Array.from(
      new Set([
        ...target.permissions,
        ...draft.permissions.filter((p) => moduleSet.has(p as Permission)),
      ]),
    );
    try {
      const payload = await api.updateRole(target.key, {
        permissions: merged,
        maxDataLevel: target.maxDataLevel,
        menus: target.menus ?? [],
      });
      setConfig(payload);
      setCopyTarget('');
      const saved = payload.roles.find((r) => r.key === draft.key);
      if (saved) selectRole(saved);
      setMsg({ type: 'ok', text: `已复制模块权限给「${target.label}」` });
    } catch {
      setMsg({ type: 'err', text: tc('saveFailed') });
    }
  }

  /** 菜单可见性：undefined 视为「不限制」；勾选第一个菜单时从「全部允许」收敛为白名单 */
  function toggleMenu(key: string) {
    if (!draft || draft.lockedPermissions) return;
    setDraft((prev) => {
      if (!prev) return prev;
      const current = prev.menus ?? allMenuKeys;
      const has = current.includes(key);
      const next = has ? current.filter((x) => x !== key) : [...current, key];
      return { ...prev, menus: next.length === allMenuKeys.length ? undefined : next };
    });
  }

  function toggleMenuSection(keys: string[], on: boolean) {
    if (!draft || draft.lockedPermissions) return;
    setDraft((prev) => {
      if (!prev) return prev;
      const set = new Set(prev.menus ?? allMenuKeys);
      for (const k of keys) {
        if (on) set.add(k);
        else set.delete(k);
      }
      const next = [...set];
      return { ...prev, menus: next.length === allMenuKeys.length ? undefined : next };
    });
  }

  function resetMenus() {
    if (!draft || draft.lockedPermissions) return;
    setDraft((prev) => (prev ? { ...prev, menus: undefined } : prev));
  }

  function toggleDomain(domain: string, perms: string[], on: boolean) {
    if (!draft || draft.lockedPermissions) return;
    setDraft((prev) => {
      if (!prev) return prev;
      const set = new Set(prev.permissions);
      for (const p of perms) {
        if (on) set.add(p);
        else set.delete(p);
      }
      void domain;
      return { ...prev, permissions: [...set] };
    });
  }

  async function handleSave() {
    if (!draft) return;
    setSaving(true);
    setMsg(null);
    try {
      // menus 传空数组 = 清除白名单（恢复按权限点自动显隐）
      const menus = draft.menus ?? [];
      const payload = draft.isNew
        ? await api.createRole({
            key: draft.key,
            label: draft.label,
            permissions: draft.permissions,
            maxDataLevel: draft.maxDataLevel,
            menus,
          })
        : await api.updateRole(draft.key, {
            label: draft.label,
            permissions: draft.permissions,
            maxDataLevel: draft.maxDataLevel,
            menus,
          });
      setConfig(payload);
      setShowCreate(false);
      setNewKey('');
      setNewLabel('');
      const saved = payload.roles.find((r) => r.key === draft.key);
      if (saved) selectRole(saved);
      const synced = payload.syncedRoleOptions;
      const base = draft.isNew ? t('roleCreated') : tc('saved');
      const syncText = synced && synced.length ? t('roleSyncSuffix', { list: synced.join('、') }) : '';
      setMsg({ type: 'ok', text: base + syncText });
    } catch {
      setMsg({ type: 'err', text: tc('saveFailed') });
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!draft || draft.protected) return;
    if (!confirm(t('confirmDeleteRole', { name: draft.label }))) return;
    setSaving(true);
    setMsg(null);
    try {
      await api.deleteRole(draft.key);
      const d = await api.getRoleManagement();
      setConfig(d);
      setSelectedKey(null);
      setDraft(null);
      setMsg({ type: 'ok', text: t('roleDeleted') });
    } catch {
      setMsg({ type: 'err', text: t('deleteFailed') });
    } finally {
      setSaving(false);
    }
  }

  function startCreate() {
    setNewKey('');
    setNewLabel('');
    setShowCreate(true);
  }

  async function confirmCreate() {
    const key = newKey.trim();
    if (!key) {
      setMsg({ type: 'err', text: t('roleKeyRequired') });
      return;
    }
    if (config?.roles.some((r) => r.key === key)) {
      setMsg({ type: 'err', text: t('roleKeyExists') });
      return;
    }
    setDraft({
      key,
      label: newLabel.trim() || key,
      permissions: [],
      maxDataLevel: 'L1',
      isNew: true,
    });
    setSelectedKey(key);
    setShowCreate(false);
    setMsg(null);
  }

  if (loading) return <div className="page"><div className="empty-state"><div className="empty-state-text">{tc('loading')}</div></div></div>;
  if (error) return <div className="page"><p className="msg-error">{error}</p></div>;
  if (!config) return null;

  const dirty =
    draft &&
    (() => {
      const orig = config.roles.find((r) => r.key === draft.key);
      if (draft.isNew) return true;
      if (!orig) return true;
      const origMenus = orig.menus ?? [];
      const draftMenus = draft.menus ?? [];
      const menusChanged =
        origMenus.length !== draftMenus.length ||
        origMenus.some((m) => !draftMenus.includes(m)) ||
        draftMenus.some((m) => !origMenus.includes(m));
      return (
        orig.label !== draft.label ||
        orig.maxDataLevel !== draft.maxDataLevel ||
        menusChanged ||
        orig.permissions.length !== draft.permissions.length ||
        orig.permissions.some((p) => !draft.permissions.includes(p)) ||
        draft.permissions.some((p) => !(orig.permissions as string[]).includes(p))
      );
    })();

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('titleRoleManagement')}</h1>
          <p className="page-subtitle">{t('subtitleRoleManagement')}</p>
        </div>
        <button className="btn btn-primary" onClick={startCreate} disabled={saving}>
          + {t('btnNewRole')}
        </button>
      </div>

      {msg && (
        <div className={msg.type === 'ok' ? 'msg-ok' : 'msg-error'} style={{ marginBottom: 'var(--space-md)' }}>
          {msg.text}
        </div>
      )}

      {showCreate && (
        <section className="form-fieldset" style={{ marginBottom: 'var(--space-lg)' }}>
          <legend className="form-legend">{t('legendNewRole')}</legend>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div className="form-field" style={{ minWidth: 200 }}>
              <label className="form-label">{t('fldRoleKey')}</label>
              <input
                className="input"
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
                placeholder={t('phRoleKey')}
              />
            </div>
            <div className="form-field" style={{ minWidth: 200 }}>
              <label className="form-label">{t('fldDisplayName')}</label>
              <input
                className="input"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder={t('phRoleDisplayName')}
              />
            </div>
            <button className="btn btn-primary" onClick={confirmCreate}>{t('btnNext')}</button>
            <button className="btn btn-outline" onClick={() => setShowCreate(false)}>{tc('cancel')}</button>
          </div>
          <p style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)', marginTop: 8 }}>
            {t('hintNewRole')}
          </p>
        </section>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 'var(--space-lg)', alignItems: 'start' }}>
        {/* 角色列表 */}
        <aside className="card" style={{ padding: 'var(--space-sm)' }}>
          <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)', marginBottom: 8 }}>
            角色（{config.roles.length}）
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {config.roles.map((r) => (
              <button
                key={r.key}
                className={`nav-item${selectedKey === r.key ? ' active' : ''}`}
                style={{ justifyContent: 'space-between', textAlign: 'left' }}
                onClick={() => selectRole(r)}
                disabled={saving}
              >
                <span>{r.label}</span>
                {r.protected && <span className="tag tag-muted" style={{ fontSize: 'var(--font-xs)' }}>{ts('builtIn')}</span>}
              </button>
            ))}
          </div>
        </aside>

        {/* 编辑器 */}
        <section className="card" style={{ padding: 'var(--space-lg)' }}>
          {!draft ? (
            <div className="empty-state"><div className="empty-state-text">{ts('selectRoleToEdit')}</div></div>
          ) : (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 'var(--space-md)' }}>
                <div>
                  <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>{ts('roleKey')}</div>
                  <div style={{ fontWeight: 700 }}>{draft.key}</div>
                </div>
                {draft.protected && (
                  <span className="tag tag-muted">{ts('builtInRoleNoDelete')}</span>
                )}
                {draft.lockedPermissions && (
                  <span className="tag tag-muted">{ts('permissionsLocked')}</span>
                )}
              </div>

              <div style={{ display: 'flex', gap: 'var(--space-lg)', flexWrap: 'wrap', marginBottom: 'var(--space-lg)' }}>
                <div className="form-field" style={{ minWidth: 220 }}>
                  <label className="form-label">{ts('displayName')}</label>
                  <input
                    className="input"
                    value={draft.label}
                    onChange={(e) => setDraft((p) => (p ? { ...p, label: e.target.value } : p))}
                    disabled={saving}
                  />
                </div>
                <div className="form-field" style={{ minWidth: 220 }}>
                  <label className="form-label">{tl('数据密级上限')}</label>
                  <select
                    className="input"
                    value={draft.maxDataLevel}
                    onChange={(e) => setDraft((p) => (p ? { ...p, maxDataLevel: e.target.value } : p))}
                    disabled={saving || !!draft.lockedPermissions}
                  >
                    {(config.dataLevels as DataLevel[]).map((lv) => (
                      <option key={lv} value={lv}>{LEVEL_LABELS[lv] ?? lv}</option>
                    ))}
                  </select>
                </div>
                <div className="form-field" style={{ minWidth: 160, alignSelf: 'flex-end' }}>
                  <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>{ts('grantedPermissions')}</div>
                  <div style={{ fontSize: 'var(--font-lg)', fontWeight: 700 }}>{draft.permissions.length}</div>
                </div>
              </div>

              <div className="form-legend" style={{ marginBottom: 10 }}>{ts('permissionAssignment')}</div>
              {draft.lockedPermissions && (
                <p style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-tertiary)', marginTop: 0, marginBottom: 12 }}>
                  系统管理员拥有全部权限，此处为只读展示。
                </p>
              )}

              <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                <div style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                  <button
                    className={`btn ${permView === 'matrix' ? 'btn-primary' : 'btn-outline'}`}
                    style={{ borderRadius: 0, border: 'none' }}
                    onClick={() => setPermView('matrix')}
                    disabled={saving}
                  >
                    矩阵视图（模块×操作）
                  </button>
                  <button
                    className={`btn ${permView === 'list' ? 'btn-primary' : 'btn-outline'}`}
                    style={{ borderRadius: 0, border: 'none', borderLeft: '1px solid var(--border)' }}
                    onClick={() => setPermView('list')}
                    disabled={saving}
                  >
                    列表视图（按权限域）
                  </button>
                </div>
              </div>

              {permView === 'matrix' ? (
                <>
                  <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                    <input
                      className="input"
                      style={{ maxWidth: 220 }}
                      value={moduleQuery}
                      onChange={(e) => setModuleQuery(e.target.value)}
                      placeholder={tl('搜索模块')}
                      disabled={draft.lockedPermissions}
                    />
                    <button className="btn btn-outline" onClick={() => matrixBulk('all')} disabled={saving || draft.lockedPermissions}>{tl('全选')}</button>
                    <button className="btn btn-outline" onClick={() => matrixBulk('clear')} disabled={saving || draft.lockedPermissions}>{tl('清空')}</button>
                    <button className="btn btn-outline" onClick={() => matrixBulk('invert')} disabled={saving || draft.lockedPermissions}>{tl('反选')}</button>
                    <span style={{ flex: 1 }} />
                    <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>{tl('复制模块权限给')}</span>
                    <select
                      className="input"
                      style={{ maxWidth: 180 }}
                      value={copyTarget}
                      onChange={(e) => setCopyTarget(e.target.value)}
                      disabled={saving || draft.lockedPermissions}
                    >
                      <option value="">{tl('选择角色')}</option>
                      {config.roles.filter((r) => r.key !== draft.key).map((r) => (
                        <option key={r.key} value={r.key}>{r.label}</option>
                      ))}
                    </select>
                    <button
                      className="btn btn-outline"
                      onClick={copyMatrixToRole}
                      disabled={saving || draft.lockedPermissions || !copyTarget}
                    >
                      {tl('复制')}
                    </button>
                  </div>

                  <div className="data-table-wrap" style={{ maxHeight: '56vh', overflow: 'auto' }}>
                    <table className="data-table" style={{ borderCollapse: 'separate', borderSpacing: 0 }}>
                      <thead>
                        <tr>
                          <th style={{ position: 'sticky', left: 0, top: 0, zIndex: 3, background: 'var(--bg-elevated)', minWidth: 150 }}>{tl('模块')}</th>
                          {MATRIX_ACTIONS.map((a) => {
                            const mods = MODULE_RESOURCES.filter((r) => r.actions.includes(a));
                            const allOn = mods.length > 0 && mods.every((r) => draft.permissions.includes(`module:${r.key}:${a}` as Permission));
                            const someOn = mods.some((r) => draft.permissions.includes(`module:${r.key}:${a}` as Permission));
                            return (
                              <th key={a} style={{ textAlign: 'center', position: 'sticky', top: 0, background: 'var(--bg-elevated)', zIndex: 2, minWidth: 76 }}>
                                <div style={{ fontSize: 'var(--font-xs)', fontWeight: 600 }}>{MODULE_ACTION_LABELS[a]}</div>
                                {!draft.lockedPermissions && mods.length > 0 && (
                                  <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, marginTop: 4, cursor: 'pointer' }}>
                                    <input
                                      type="checkbox"
                                      checked={allOn}
                                      ref={(el) => {
                                        if (el) el.indeterminate = !allOn && someOn;
                                      }}
                                      onChange={(e) => toggleActionCol(a, e.target.checked)}
                                    />
                                    <span style={{ fontSize: 10, color: 'var(--fg-tertiary)' }}>全选</span>
                                  </label>
                                )}
                              </th>
                            );
                          })}
                        </tr>
                      </thead>
                      <tbody>
                        {MODULE_RESOURCES.filter((r) => {
                          const q = moduleQuery.trim().toLowerCase();
                          return !q || r.label.toLowerCase().includes(q) || r.key.toLowerCase().includes(q);
                        }).map((r) => {
                          const rowAll = r.actions.every((a) => draft.permissions.includes(`module:${r.key}:${a}` as Permission));
                          const rowSome = r.actions.some((a) => draft.permissions.includes(`module:${r.key}:${a}` as Permission));
                          return (
                            <tr key={r.key}>
                              <td style={{ position: 'sticky', left: 0, background: 'var(--bg-elevated)', fontWeight: 600, whiteSpace: 'nowrap' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                  {!draft.lockedPermissions && r.actions.length > 0 && (
                                    <input
                                      type="checkbox"
                                      checked={rowAll}
                                      ref={(el) => {
                                        if (el) el.indeterminate = !rowAll && rowSome;
                                      }}
                                      onChange={(e) => toggleModuleRow(r.key, r.actions, e.target.checked)}
                                    />
                                  )}
                                  <span>{r.label}</span>
                                  {r.adminOnly && <span className="tag tag-muted" style={{ fontSize: 10 }}>仅管理员</span>}
                                </div>
                              </td>
                              {MATRIX_ACTIONS.map((a) => {
                                const available = r.actions.includes(a);
                                const on = available && draft.permissions.includes(`module:${r.key}:${a}` as Permission);
                                if (!available) {
                                  return (
                                    <td key={a} style={{ textAlign: 'center', color: 'var(--fg-tertiary)', opacity: 0.4 }}>—</td>
                                  );
                                }
                                return (
                                  <td key={a} style={{ textAlign: 'center' }}>
                                    <input
                                      type="checkbox"
                                      checked={on}
                                      disabled={draft.lockedPermissions}
                                      onChange={() => toggleModuleAction(r.key, a, !on)}
                                      title={`${r.label} · ${MODULE_ACTION_LABELS[a]}`}
                                    />
                                  </td>
                                );
                              })}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : (
                <div className="data-table-wrap" style={{ maxHeight: '52vh', overflowY: 'auto' }}>
                  <table className="data-table">
                    <tbody>
                      {groups
                        .map((g) => ({ ...g, perms: g.perms.filter((p) => !p.startsWith('module:')) }))
                        .filter((g) => g.perms.length > 0)
                        .map((g) => {
                          const allOn = g.perms.every((p) => draft.permissions.includes(p));
                          return (
                            <tr key={g.domain}>
                              <td style={{ width: 180, fontWeight: 600, position: 'sticky', left: 0, background: 'var(--bg-elevated)' }}>
                                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: draft.lockedPermissions ? 'default' : 'pointer' }}>
                                  {!draft.lockedPermissions && (
                                    <input
                                      type="checkbox"
                                      checked={allOn}
                                      ref={(el) => {
                                        if (el) el.indeterminate = !allOn && g.perms.some((p) => draft.permissions.includes(p));
                                      }}
                                      onChange={(e) => toggleDomain(g.domain, g.perms, e.target.checked)}
                                    />
                                  )}
                                  {g.label}
                                </label>
                              </td>
                              <td>
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                                  {g.perms.map((p) => {
                                    const on = draft.permissions.includes(p);
                                    return (
                                      <label
                                        key={p}
                                        className="tag"
                                        style={{
                                          cursor: draft.lockedPermissions ? 'default' : 'pointer',
                                          opacity: on ? 1 : 0.55,
                                          borderColor: on ? 'var(--accent)' : undefined,
                                          background: on ? 'var(--accent-soft)' : undefined,
                                        }}
                                      >
                                        <input
                                          type="checkbox"
                                          checked={on}
                                          disabled={draft.lockedPermissions}
                                          onChange={() => togglePerm(p)}
                                          style={{ marginRight: 6 }}
                                        />
                                        {PERMISSION_LABELS[p as Permission] ?? p}
                                      </label>
                                    );
                                  })}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="form-legend" style={{ marginTop: 'var(--space-lg)', marginBottom: 10 }}>
                {tl('菜单可见性')}
              </div>
              <p style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-tertiary)', marginTop: 0, marginBottom: 12 }}>
                {tl('留空 = 按权限点自动显隐；勾选后该角色只能看到所选菜单。此处只做收敛，不会放大权限。')}
              </p>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
                <input
                  className="input"
                  style={{ maxWidth: 220 }}
                  value={menuQuery}
                  onChange={(e) => setMenuQuery(e.target.value)}
                  placeholder={tl('搜索菜单')}
                />
                <span className={draft.menus ? 'tag tag-accent' : 'tag'}>
                  {draft.menus ? `${tl('白名单模式')}：${draft.menus.length} / ${allMenuKeys.length}` : tl('自动模式（不限制）')}
                </span>
                <button
                  className="btn btn-outline"
                  onClick={resetMenus}
                  disabled={saving || !!draft.lockedPermissions || !draft.menus}
                >
                  {tl('恢复自动')}
                </button>
              </div>
              <div className="data-table-wrap" style={{ maxHeight: '40vh', overflowY: 'auto' }}>
                <table className="data-table">
                  <tbody>
                    {filteredMenuGroups.map((g) => {
                      const keys = g.items.map((i) => i.key);
                      const selected = draft.menus ?? allMenuKeys;
                      const allOn = keys.every((k) => selected.includes(k));
                      return (
                        <tr key={g.section}>
                          <td style={{ width: 180, fontWeight: 600, position: 'sticky', left: 0, background: 'var(--bg-elevated)' }}>
                            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: draft.lockedPermissions ? 'default' : 'pointer' }}>
                              {!draft.lockedPermissions && (
                                <input
                                  type="checkbox"
                                  checked={allOn}
                                  ref={(el) => {
                                    if (el) el.indeterminate = !allOn && keys.some((k) => selected.includes(k));
                                  }}
                                  onChange={(e) => toggleMenuSection(keys, e.target.checked)}
                                />
                              )}
                              {g.section}
                            </label>
                          </td>
                          <td>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                              {g.items.map((item) => {
                                const on = selected.includes(item.key);
                                return (
                                  <label
                                    key={item.key}
                                    className="tag"
                                    style={{
                                      cursor: draft.lockedPermissions ? 'default' : 'pointer',
                                      opacity: on ? 1 : 0.55,
                                      borderColor: on ? 'var(--accent)' : undefined,
                                      background: on ? 'var(--accent-soft)' : undefined,
                                    }}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={on}
                                      disabled={draft.lockedPermissions}
                                      onChange={() => toggleMenu(item.key)}
                                      style={{ marginRight: 6 }}
                                    />
                                    {item.label}
                                  </label>
                                );
                              })}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div style={{ display: 'flex', gap: 12, marginTop: 'var(--space-lg)' }}>
                <button className="btn btn-primary" onClick={handleSave} disabled={saving || !dirty}>
                  {saving ? tc('saving') : draft.isNew ? ts('createRole') : tc('save')}
                </button>
                {!draft.protected && (
                  <button className="btn btn-danger" onClick={handleDelete} disabled={saving}>
                    删除角色
                  </button>
                )}
                {dirty && <span className="tag tag-accent">{ts('unsavedChanges')}</span>}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
