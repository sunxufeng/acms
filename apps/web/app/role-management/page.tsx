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
  moduleByMenuKey,
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

/**
 * 矩阵行（2026-09-17「菜单并入矩阵」）。
 *
 * 行 = **菜单项**（与侧边栏同源），通过 key 同名或 `MENU_KEY_ALIASES` 别名找到对应模块资源。
 * 这样「能不能进」（原独立表格）与「进去能做什么」就落在同一张表上，不必两处手工保持一致。
 *
 * 三行类型：
 *  - `moduleKey` 有值（71 项）→ 「进入菜单」列写 `module:<moduleKey>:enter`，其余列写模块声明的动作
 *  - `moduleKey` 无值但有 `legacyPerm`（如 system-monitor → `admin:monitor`）→ 「进入菜单」列写该权限点
 *  - 两者都没有（14 项 `adminOnly`，只有系统管理员可见）→ 该列显示「仅管理员」，不可勾
 */
interface MatrixRow {
  /** 行键 = 菜单 key */
  key: string;
  label: string;
  section: string;
  /** 对应模块 key（无对应时为 undefined） */
  moduleKey?: string;
  /** 模块声明的动作，**已剔除 enter**（enter 单独占「进入菜单」列） */
  actions: readonly ModuleAction[];
  /** 无模块资源但有独立权限点时，用它当「进入菜单」的判据 */
  legacyPerm?: string;
  adminOnly: boolean;
}

interface Draft {
  key: string;
  label: string;
  permissions: string[];
  maxDataLevel: string;
  /** 菜单可见性白名单；undefined = 不限制（按权限点自动显隐） */
  menus?: string[];
  /** 学生档案数据范围（undefined = 不限制）；维度：当前年级 / 当前状态 */
  dataScope?: { 当前年级?: string[]; 当前状态?: string[] };
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
  /** 权限分配视图：矩阵（菜单×操作）/ 列表（按模块）—— 两者同一集合，只是呈现不同 */
  const [permView, setPermView] = useState<'matrix' | 'list'>('matrix');
  /** 学生范围候选值（实际数据值 + 人数 + 交叉计数），进页面拉一次 */
  const [scopeOpts, setScopeOpts] = useState<{
    dims: { dim: string; values: { value: string; count: number }[] }[];
    cross: { 当前年级: string; 当前状态: string; count: number }[];
    total: number;
  } | null>(null);
  const [moduleQuery, setModuleQuery] = useState('');
  /** 复制本角色模块权限的目标角色（权限矩阵里的「复制模块权限给」—— 并入既有角色，不新建） */
  const [copyTarget, setCopyTarget] = useState('');
  /**
   * 「复制此角色」的源角色 key（null = 普通新建）。
   *
   * ⚠️ 与上面的 copyTarget 是**两件事**，别混：
   *   - copyTarget     → 把本角色的 module:* 权限**并入**另一个已存在的角色（不新建）
   *   - copySourceKey  → 以某个角色为模板**新建**一个角色（本功能）
   */
  const [copySourceKey, setCopySourceKey] = useState<string | null>(null);

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
      dataScope: r.dataScope ? JSON.parse(JSON.stringify(r.dataScope)) : undefined,
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

  /**
   * 兼容权限点（legacy）：没有 `module:` 前缀的旧权限点，按「权限域」分组。
   *
   * 为什么还留着：仍有自建接口在用它们鉴权（`getnote:*`、`ai*` 系列共 30+ 处），
   * 存量角色也持有这些权限点。列表视图改成「按模块罗列」后，把它们收进折叠区，
   * 保证能力不丢、又不干扰主流程。
   */
  const legacyGroups = useMemo(
    () =>
      groups
        .map((g) => ({ ...g, perms: g.perms.filter((x) => !x.startsWith('module:')) }))
        .filter((g) => g.perms.length > 0),
    [groups],
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

  /**
   * 矩阵行清单：菜单项 → 模块（同名优先，其次别名）。
   *
   * ⚠️ 覆盖面核对（新增菜单/模块时照这个查）：
   *   菜单 76 项 = 71 项能对上模块 + 5 项无模块资源（`impersonate` / `api-tokens` /
   *   `impersonateLogs` / `system-monitor` / `aiDocs`，全为 adminOnly 或走独立权限点）；
   *   71 个模块**全部**有对应菜单 ⇒ 矩阵不会漏掉任何模块。
   */
  const matrixRows = useMemo<MatrixRow[]>(() => {
    return menuItems.map((it) => {
      const mod = moduleByMenuKey(it.key);
      return {
        key: it.key,
        label: it.label,
        section: it.section ?? '未分组',
        moduleKey: mod?.key,
        actions: (mod?.actions ?? []).filter((a) => a !== 'enter'),
        legacyPerm: mod ? undefined : it.perm,
        adminOnly: it.adminOnly === true,
      };
    });
  }, [menuItems]);

  /** 矩阵行按菜单分组（section）聚合，渲染时按组输出分区表头 */
  const matrixGroups = useMemo(() => {
    const q = moduleQuery.trim().toLowerCase();
    const hit = matrixRows.filter(
      (r) => !q || r.label.toLowerCase().includes(q) || r.key.toLowerCase().includes(q),
    );
    const m = new Map<string, MatrixRow[]>();
    for (const r of hit) {
      const list = m.get(r.section);
      if (list) list.push(r);
      else m.set(r.section, [r]);
    }
    return [...m.entries()].map(([section, rows]) => ({ section, rows }));
  }, [matrixRows, moduleQuery]);

  /**
   * 某一行「进入菜单」对应的权限点（无则 undefined）。
   * 有模块用 `module:<key>:enter`；无模块但配了独立权限点（如 `admin:monitor`）就用它；
   * 两者都没有 ⇒ adminOnly 项，不需要授权。
   */
  function rowEnterPerm(r: MatrixRow): Permission | undefined {
    if (r.moduleKey) return `module:${r.moduleKey}:enter` as Permission;
    return r.legacyPerm as Permission | undefined;
  }

  /** 把某个权限点设为指定状态（`<字段>__has` 那类 toggle 写法在批量场景下不可靠，统一用显式赋值） */
  function setPerm(p: Permission | undefined, on: boolean) {
    if (!p || !draft || draft.lockedPermissions) return;
    setDraft((prev) => {
      if (!prev) return prev;
      const set = new Set(prev.permissions);
      if (on) set.add(p);
      else set.delete(p);
      return { ...prev, permissions: [...set] };
    });
  }

  /** 某行全部**可配**权限点（进入菜单 + 该模块声明的动作）——行全选/半选都用它算 */
  function rowPerms(r: MatrixRow): Permission[] {
    const out: Permission[] = [];
    const enterP = rowEnterPerm(r);
    if (enterP) out.push(enterP);
    for (const a of r.actions) {
      if (r.moduleKey) out.push(`module:${r.moduleKey}:${a}` as Permission);
    }
    return out;
  }

  /** 行全选/清空：一次处理「进入菜单」与全部动作（adminOnly 行没有可配项，返回空数组） */
  function toggleRowAll(r: MatrixRow, on: boolean) {
    if (!draft || draft.lockedPermissions) return;
    const perms = rowPerms(r);
    if (!perms.length) return;
    setDraft((prev) => {
      if (!prev) return prev;
      const set = new Set(prev.permissions);
      for (const p of perms) {
        if (on) set.add(p);
        else set.delete(p);
      }
      return { ...prev, permissions: [...set] };
    });
  }

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

  /** 拉一次候选值（实际数据值 + 人数 + 两维交叉计数） */
  useEffect(() => {
    let alive = true;
    api
      .studentScopeOptions()
      .then((r) => {
        if (alive) setScopeOpts(r);
      })
      .catch(() => {
        if (alive) setScopeOpts(null);
      });
    return () => {
      alive = false;
    };
  }, []);

  /** 勾选/取消某个维度的某个值；两个维度都空时收敛为 undefined（= 不限制） */
  function toggleScopeDim(dim: '当前年级' | '当前状态', value: string) {
    if (!draft || draft.lockedPermissions) return;
    setDraft((prev) => {
      if (!prev) return prev;
      const cur = prev.dataScope?.[dim] ?? [];
      const next = cur.includes(value) ? cur.filter((x) => x !== value) : [...cur, value];
      const scope = { ...(prev.dataScope ?? {}) };
      if (next.length) scope[dim] = next;
      else delete scope[dim];
      const empty = !scope.当前年级?.length && !scope.当前状态?.length;
      return { ...prev, dataScope: empty ? undefined : scope };
    });
  }

  /**
   * 预览：按当前 draft 的范围算「可见学生数」。
   * 用后端给的「当前年级 × 当前状态」**交叉计数**精确算 —— 两个维度是 AND，不能把各维度人数相加。
   * 未配置的维度视为不限制（该维度全部算命中）。
   */
  const scopePreview = useMemo(() => {
    if (!scopeOpts) return null;
    const g = draft?.dataScope?.当前年级 ?? [];
    const s = draft?.dataScope?.当前状态 ?? [];
    if (!g.length && !s.length) return scopeOpts.total;
    return scopeOpts.cross
      .filter((r) => (!g.length || g.includes(r.当前年级)) && (!s.length || s.includes(r.当前状态)))
      .reduce((sum, r) => sum + r.count, 0);
  }, [scopeOpts, draft?.dataScope]);

  async function handleSave() {
    if (!draft) return;
    setSaving(true);
    setMsg(null);
    try {
      // menus 传空数组 = 清除白名单（恢复按权限点自动显隐）
      const menus = draft.menus ?? [];
      // dataScope 传 null 表示清空（= 不限制）—— 后端把「全空」当删除处理
      const dataScope = draft.dataScope ?? null;
      const payload = draft.isNew
        ? await api.createRole({
            key: draft.key,
            label: draft.label,
            permissions: draft.permissions,
            maxDataLevel: draft.maxDataLevel,
            menus,
            dataScope,
          })
        : await api.updateRole(draft.key, {
            label: draft.label,
            permissions: draft.permissions,
            maxDataLevel: draft.maxDataLevel,
            menus,
            dataScope,
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

  /** 生成不冲突的角色 key：已存在则追加 2、3… */
  function uniqueKey(base: string): string {
    const existing = new Set((config?.roles ?? []).map((r) => r.key));
    if (!existing.has(base)) return base;
    for (let i = 2; i < 1000; i++) {
      const cand = `${base}${i}`;
      if (!existing.has(cand)) return cand;
    }
    return `${base}-${Date.now()}`;
  }

  function startCreate() {
    setNewKey('');
    setNewLabel('');
    setCopySourceKey(null);
    setShowCreate(true);
  }

  /**
   * 「复制此角色」：以 r 为模板创建新角色。
   *
   * 只做两件事 —— 预填 key/展示名、记住源角色；真正的继承发生在 confirmCreate。
   * 这样用户在落库前仍可在编辑器里改动，且中途可放弃（不会留下半成品角色）。
   */
  function startCopy(r: RoleDef) {
    setCopySourceKey(r.key);
    setNewKey(uniqueKey(`${r.key}-副本`));
    setNewLabel(`${r.label}（副本）`);
    setShowCreate(true);
    setMsg(null);
    // 表单在页面顶部，编辑器很长时点了按钮要能看见
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
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
    /**
     * 复制模式：把源角色的四项配置整体带过来 ——
     *   权限点 / 菜单可见性白名单 / 数据密级上限 / 学生档案数据范围。
     *
     * 🔴 刻意**不继承** protected（内置）与 lockedPermissions（权限集锁定）：
     *    副本必须是「可编辑、可删除」的普通角色，否则复制「系统管理员」
     *    会得到一个连权限都改不动的角色，等于白复制。
     */
    const src = copySourceKey ? (config?.roles ?? []).find((r) => r.key === copySourceKey) : null;
    setDraft({
      key,
      label: newLabel.trim() || key,
      permissions: src ? [...src.permissions] : [],
      maxDataLevel: src ? src.maxDataLevel : 'L1',
      menus: src?.menus?.length ? [...src.menus] : undefined,
      dataScope: src?.dataScope ? JSON.parse(JSON.stringify(src.dataScope)) : undefined,
      isNew: true,
    });
    setSelectedKey(key);
    setShowCreate(false);
    // 继承只发生一次 —— 清掉源，避免之后点「新建角色」时误继承
    setCopySourceKey(null);
    setMsg(null);
  }

  if (loading) return <div className="page"><div className="empty-state"><div className="empty-state-text">{tc('loading')}</div></div></div>;
  if (error) return <div className="page"><p className="msg-error">{error}</p></div>;
  if (!config) return null;

  /** 复制模式下当前选中的源角色（null = 普通新建） */
  const copySource = copySourceKey
    ? ((config?.roles ?? []).find((r) => r.key === copySourceKey) ?? null)
    : null;
  /** 编辑器当前展示的角色对应的列表项（新建时没有） */
  const editingRole = draft && !draft.isNew ? ((config.roles ?? []).find((r) => r.key === draft.key) ?? null) : null;

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
          <legend className="form-legend">{copySource ? t('legendCopyRole') : t('legendNewRole')}</legend>
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
            <button className="btn btn-primary" onClick={confirmCreate}>
              {copySource ? t('btnCreateCopy') : t('btnNext')}
            </button>
            <button
              className="btn btn-outline"
              onClick={() => {
                setShowCreate(false);
                setCopySourceKey(null);
              }}
            >
              {tc('cancel')}
            </button>
          </div>
          {copySource ? (
            <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)', marginTop: 10, lineHeight: 1.8 }}>
              <div>{t('copySourceInfo', { name: copySource.label, perms: copySource.permissions.length })}</div>
              <div>
                {t('copyWillBring', {
                  perms: copySource.permissions.length,
                  menus: (copySource.menus ?? []).length,
                  level: copySource.maxDataLevel,
                  scope: copySource.dataScope ? t('copyScopeYes') : t('copyScopeNo'),
                })}
              </div>
              <div>{t('copyNotBring')}</div>
            </div>
          ) : (
            <p style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)', marginTop: 8 }}>
              {t('hintNewRole')}
            </p>
          )}
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
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  {draft.protected && (
                    <span className="tag tag-muted">{ts('builtInRoleNoDelete')}</span>
                  )}
                  {draft.lockedPermissions && (
                    <span className="tag tag-muted">{ts('permissionsLocked')}</span>
                  )}
                  {/* 复制此角色：以当前角色为模板新建一个角色（可编辑、可删除）。
                      仅对已保存的角色显示 —— 新建态还没落库，没有可复制的"源"。 */}
                  {editingRole && (
                    <button
                      className="btn btn-outline btn-sm"
                      onClick={() => startCopy(editingRole)}
                      disabled={saving}
                      title={t('btnCopyRoleHint')}
                    >
                      {t('btnCopyRole')}
                    </button>
                  )}
                </div>
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

              {/* ① 权限分配（操作层）。
                  ⚠️ 2026-09-17 起「菜单可见性」并入矩阵：矩阵的行就是菜单项，
                  第一列「进入菜单」即原菜单表的「能否进入该页」，不再需要两张表手工对齐。
                  原菜单白名单（额外收敛层）移到下方折叠区，能力与存量数据都保留。
                  先定「能进哪些页面」、再定「进去能做什么」，仍是从粗到细的顺序。 */}
              {/* ② 权限分配（操作层）：具体能做什么。上移到下面的间距由这里带，
                  否则会与上面「菜单可见性」的表格贴在一起。 */}
              <div
                className="form-legend"
                style={{ marginTop: 'var(--space-lg)', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}
              >
                <span
                  style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    width: 15, height: 15, borderRadius: '50%', flex: '0 0 auto',
                    background: 'var(--accent-soft)', color: 'var(--accent)',
                    fontSize: 10, fontWeight: 700, letterSpacing: 0,
                  }}
                >
                  1
                </span>
                {ts('permissionAssignment')}
              </div>
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
                    矩阵视图（菜单×操作）
                  </button>
                  <button
                    className={`btn ${permView === 'list' ? 'btn-primary' : 'btn-outline'}`}
                    style={{ borderRadius: 0, border: 'none', borderLeft: '1px solid var(--border)' }}
                    onClick={() => setPermView('list')}
                    disabled={saving}
                  >
                    列表视图（按模块）
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
                      placeholder={tl('搜索菜单')}
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
                          <th style={{ position: 'sticky', left: 0, top: 0, zIndex: 3, background: 'var(--bg-elevated)', minWidth: 200 }}>
                            {tl('菜单')}
                          </th>
                          {MATRIX_ACTIONS.map((a) => {
                            // 列全选只对「模块声明过该动作」的行生效；「进入菜单」列因含
                            // legacy 权限点（system-monitor 等）语义不齐，不提供列全选。
                            const mods = MODULE_RESOURCES.filter((r) => r.actions.includes(a));
                            const allOn = mods.length > 0 && mods.every((r) => draft.permissions.includes(`module:${r.key}:${a}` as Permission));
                            const someOn = mods.some((r) => draft.permissions.includes(`module:${r.key}:${a}` as Permission));
                            return (
                              <th key={a} style={{ textAlign: 'center', position: 'sticky', top: 0, background: 'var(--bg-elevated)', zIndex: 2, minWidth: 76 }}>
                                <div style={{ fontSize: 'var(--font-xs)', fontWeight: 600 }}>{MODULE_ACTION_LABELS[a]}</div>
                                {!draft.lockedPermissions && mods.length > 0 && a !== 'enter' && (
                                  <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, marginTop: 4, cursor: 'pointer' }}>
                                    <input
                                      type="checkbox"
                                      checked={allOn}
                                      ref={(el) => {
                                        if (el) el.indeterminate = !allOn && someOn;
                                      }}
                                      onChange={(e) => toggleActionCol(a, e.target.checked)}
                                    />
                                    <span style={{ fontSize: 10, color: 'var(--fg-tertiary)' }}>{tl('全选')}</span>
                                  </label>
                                )}
                              </th>
                            );
                          })}
                        </tr>
                      </thead>
                      {matrixGroups.map((g) => (
                        <tbody key={g.section}>
                          <tr>
                            <td
                              colSpan={MATRIX_ACTIONS.length + 1}
                              style={{
                                background: 'var(--bg-secondary)',
                                fontWeight: 600,
                                fontSize: 'var(--font-sm)',
                                position: 'sticky',
                                left: 0,
                              }}
                            >
                              {g.section}
                            </td>
                          </tr>
                          {g.rows.map((r) => {
                            const enterP = rowEnterPerm(r);
                            const perms = rowPerms(r);
                            const rowAll = perms.length > 0 && perms.every((x) => draft.permissions.includes(x));
                            const rowSome = perms.some((x) => draft.permissions.includes(x));
                            return (
                              <tr key={r.key}>
                                <td style={{ position: 'sticky', left: 0, background: 'var(--bg-elevated)', fontWeight: 600, whiteSpace: 'nowrap' }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    {!draft.lockedPermissions && perms.length > 0 && (
                                      <input
                                        type="checkbox"
                                        checked={rowAll}
                                        ref={(el) => {
                                          if (el) el.indeterminate = !rowAll && rowSome;
                                        }}
                                        onChange={(e) => toggleRowAll(r, e.target.checked)}
                                        title={tl('整行全选')}
                                      />
                                    )}
                                    <span>{r.label}</span>
                                    {r.adminOnly && <span className="tag tag-muted" style={{ fontSize: 10 }}>{tl('仅管理员')}</span>}
                                  </div>
                                </td>
                                {MATRIX_ACTIONS.map((a) => {
                                  if (a === 'enter') {
                                    // 「进入菜单」：有模块 → module:<key>:enter；
                                    // 无模块但有独立权限点（admin:monitor / ai:chat）→ 用它；
                                    // 都没有 → adminOnly 项，只有系统管理员可见，没有可配的权限点。
                                    if (!enterP) {
                                      return (
                                        <td key={a} style={{ textAlign: 'center', color: 'var(--fg-tertiary)', opacity: 0.4 }} title={tl('仅管理员可见，无需授权')}>
                                          —
                                        </td>
                                      );
                                    }
                                    return (
                                      <td key={a} style={{ textAlign: 'center' }}>
                                        <input
                                          type="checkbox"
                                          checked={draft.permissions.includes(enterP)}
                                          disabled={draft.lockedPermissions}
                                          onChange={(e) => setPerm(enterP, e.target.checked)}
                                          title={`${r.label} · ${MODULE_ACTION_LABELS[a]}`}
                                        />
                                      </td>
                                    );
                                  }
                                  const available = r.actions.includes(a);
                                  if (!available) {
                                    return (
                                      <td key={a} style={{ textAlign: 'center', color: 'var(--fg-tertiary)', opacity: 0.4 }}>—</td>
                                    );
                                  }
                                  const p = `module:${r.moduleKey}:${a}` as Permission;
                                  const on = draft.permissions.includes(p);
                                  return (
                                    <td key={a} style={{ textAlign: 'center' }}>
                                      <input
                                        type="checkbox"
                                        checked={on}
                                        disabled={draft.lockedPermissions}
                                        onChange={(e) => setPerm(p, e.target.checked)}
                                        title={`${r.label} · ${MODULE_ACTION_LABELS[a]}`}
                                      />
                                    </td>
                                  );
                                })}
                              </tr>
                            );
                          })}
                        </tbody>
                      ))}
                    </table>
                  </div>
                </>
              ) : (
                <>
                <div className="data-table-wrap" style={{ maxHeight: '52vh', overflowY: 'auto' }}>
                  <table className="data-table">
                    {matrixGroups.map((g) => (
                      <tbody key={g.section}>
                        <tr>
                          <td colSpan={2} style={{ background: 'var(--bg-secondary)', fontWeight: 600, fontSize: 'var(--font-sm)' }}>
                            {g.section}
                          </td>
                        </tr>
                        {g.rows.map((r) => {
                          const enterP = rowEnterPerm(r);
                          const perms = rowPerms(r);
                          const allOn = perms.length > 0 && perms.every((x) => draft.permissions.includes(x));
                          const someOn = perms.some((x) => draft.permissions.includes(x));
                          return (
                            <tr key={r.key}>
                              <td style={{ width: 200, fontWeight: 600, whiteSpace: 'nowrap' }}>
                                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: draft.lockedPermissions || !perms.length ? 'default' : 'pointer' }}>
                                  {!draft.lockedPermissions && perms.length > 0 && (
                                    <input
                                      type="checkbox"
                                      checked={allOn}
                                      ref={(el) => {
                                        if (el) el.indeterminate = !allOn && someOn;
                                      }}
                                      onChange={(e) => toggleRowAll(r, e.target.checked)}
                                    />
                                  )}
                                  <span>{r.label}</span>
                                  {r.adminOnly && <span className="tag tag-muted" style={{ fontSize: 10 }}>{tl('仅管理员')}</span>}
                                </label>
                              </td>
                              <td>
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                                  {enterP && (
                                    <label
                                      className="tag"
                                      style={{
                                        cursor: draft.lockedPermissions ? 'default' : 'pointer',
                                        opacity: draft.permissions.includes(enterP) ? 1 : 0.55,
                                        borderColor: draft.permissions.includes(enterP) ? 'var(--accent)' : undefined,
                                        background: draft.permissions.includes(enterP) ? 'var(--accent-soft)' : undefined,
                                      }}
                                    >
                                      <input
                                        type="checkbox"
                                        checked={draft.permissions.includes(enterP)}
                                        disabled={draft.lockedPermissions}
                                        onChange={(e) => setPerm(enterP, e.target.checked)}
                                        style={{ marginRight: 6 }}
                                      />
                                      {MODULE_ACTION_LABELS.enter}
                                    </label>
                                  )}
                                  {r.moduleKey &&
                                    r.actions.map((a) => {
                                      const perm = `module:${r.moduleKey}:${a}` as Permission;
                                      const on = draft.permissions.includes(perm);
                                      return (
                                        <label
                                          key={a}
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
                                            onChange={(e) => setPerm(perm, e.target.checked)}
                                            style={{ marginRight: 6 }}
                                          />
                                          {MODULE_ACTION_LABELS[a]}
                                        </label>
                                      );
                                    })}
                                  {!enterP && !r.moduleKey && (
                                    <span style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-tertiary)' }}>
                                      {tl('仅管理员可见，无需授权')}
                                    </span>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    ))}
                  </table>
                </div>
                <details style={{ marginTop: 12 }}>
                  <summary style={{ cursor: 'pointer', fontSize: 'var(--font-sm)', color: 'var(--fg-secondary)' }}>
                    {tl('兼容权限点（无模块归属的旧权限点）')}
                  </summary>
                  <p style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-tertiary)', margin: '8px 0' }}>
                    {tl('这些权限点没有模块归属，仍被部分自建接口使用（知识库、智能助手等）。没有特殊需要不必改动。')}
                  </p>
                  <div className="data-table-wrap" style={{ maxHeight: '36vh', overflowY: 'auto' }}>
                    <table className="data-table">
                      <tbody>
                        {legacyGroups.map((g) => {
                          const allOn = g.perms.every((x) => draft.permissions.includes(x));
                          return (
                            <tr key={g.domain}>
                              <td style={{ width: 200, fontWeight: 600 }}>
                                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: draft.lockedPermissions ? 'default' : 'pointer' }}>
                                  {!draft.lockedPermissions && (
                                    <input
                                      type="checkbox"
                                      checked={allOn}
                                      ref={(el) => {
                                        if (el) el.indeterminate = !allOn && g.perms.some((x) => draft.permissions.includes(x));
                                      }}
                                      onChange={(e) => toggleDomain(g.domain, g.perms, e.target.checked)}
                                    />
                                  )}
                                  {g.label}
                                </label>
                              </td>
                              <td>
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                                  {g.perms.map((x) => {
                                    const on = draft.permissions.includes(x);
                                    return (
                                      <label
                                        key={x}
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
                                          onChange={() => togglePerm(x)}
                                          style={{ marginRight: 6 }}
                                        />
                                        {PERMISSION_LABELS[x as Permission] ?? x}
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
                </details>
                </>
              )}

              {/*
                「菜单白名单」——**额外收敛层**，语义与「进入菜单」不同，所以保留：
                · 「进入菜单」= 权限点（必需条件），决定"能不能进"
                · 白名单 = 在此之上的收敛，且**只有该角色的所有角色都配了白名单才生效**
                  （多角色取并集，见 packages/domain 的 menusOf）
                留空 = 自动模式（按权限点显隐）。收进折叠区避免与矩阵重复打扰。
              */}
              <details style={{ marginTop: 14 }}>
                <summary style={{ cursor: 'pointer', fontSize: 'var(--font-sm)', color: 'var(--fg-secondary)' }}>
                  {tl('高级：菜单白名单（额外收敛）')}
                  {draft.menus ? `（${tl('当前已配')} ${draft.menus.length} / ${allMenuKeys.length}）` : `（${tl('自动模式（不限制）')}）`}
                </summary>
                <p style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-tertiary)', margin: '8px 0 10px' }}>
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
                  <button className="btn btn-outline" onClick={resetMenus} disabled={saving || !!draft.lockedPermissions || !draft.menus}>
                    {tl('恢复自动')}
                  </button>
                </div>
                <div className="data-table-wrap" style={{ maxHeight: '32vh', overflowY: 'auto' }}>
                  <table className="data-table">
                    <tbody>
                      {filteredMenuGroups.map((g) => {
                        const keys = g.items.map((i) => i.key);
                        const selected = draft.menus ?? allMenuKeys;
                        const allOn = keys.every((k) => selected.includes(k));
                        return (
                          <tr key={g.section}>
                            <td style={{ width: 180, fontWeight: 600 }}>
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
              </details>

              {/* ② 数据范围（2026-09-15）：决定该角色能看到哪些学生的档案。
                  空 = 不限制（默认态，因此上线不改变任何人的可见范围）；
                  维度之间 AND、同一维度内 OR；多角色取并集（见 student-scope.ts）。 */}
              <div
                className="form-legend"
                style={{ marginTop: 'var(--space-lg)', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}
              >
                <span
                  style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    width: 15, height: 15, borderRadius: '50%', flex: '0 0 auto',
                    background: 'var(--accent-soft)', color: 'var(--accent)',
                    fontSize: 10, fontWeight: 700, letterSpacing: 0,
                  }}
                >
                  2
                </span>
                {tl('数据范围')}
              </div>
              <p style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-tertiary)', marginTop: 0, marginBottom: 12 }}>
                {tl('决定该角色能查看哪些学生的档案。两个维度都留空 = 不限制（看全部）；维度之间同时满足，同一维度勾选多个是满足任一。')}
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {(scopeOpts?.dims ?? []).map((d) => (
                  <div
                    key={d.dim}
                    style={{ display: 'grid', gridTemplateColumns: '78px minmax(0,1fr)', gap: 10, alignItems: 'start' }}
                  >
                    <div style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-secondary)', paddingTop: 4 }}>{d.dim}</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      {d.values.map((v) => {
                        const dim = d.dim as '当前年级' | '当前状态';
                        const on = (draft.dataScope?.[dim] ?? []).includes(v.value);
                        return (
                          <label
                            key={v.value}
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
                              onChange={() => toggleScopeDim(dim, v.value)}
                              style={{ marginRight: 6 }}
                            />
                            {v.value}
                            <span style={{ marginLeft: 6, fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>
                              {v.count}
                            </span>
                          </label>
                        );
                      })}
                      {d.values.length === 0 && (
                        <span style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-tertiary)' }}>
                          {tl('暂无可选值（学生表里该字段还没有数据）')}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-secondary)' }}>{tl('按当前配置可见')}</span>
                <span style={{ fontSize: 'var(--font-lg)', fontWeight: 700 }}>
                  {scopePreview === null ? '—' : scopePreview}
                </span>
                <span style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-secondary)' }}>{tl('个学生')}</span>
                {draft.lockedPermissions && (
                  <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>
                    {tl('系统管理员不受数据范围限制，此处仅作展示')}
                  </span>
                )}
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
