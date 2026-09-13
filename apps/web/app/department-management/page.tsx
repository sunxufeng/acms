'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  api,
  type DepartmentListResult,
  type DepartmentMemberResult,
  type DepartmentNode,
  type DepartmentStatus,
  type DepartmentSyncProgress,
} from '../../lib/api';
import { useTranslations } from 'next-intl';

/**
 * 部门管理（组织管理）。
 *
 * 2026-09-13 改造（用户反馈）：
 * 1. 页面此前是自绘 Tailwind 树、与全站风格不一致 → 全面改用标准类
 *    （.page-content / .page-header / .card / .form-input / .data-table / .empty-state）。
 * 2. 树最上层「公司」（根部门）不显示 → 根因在后端：飞书部门列表接口
 *    （parent_department_id=0&fetch_child=true）只返回**根的子孙**、不含根自身，
 *    一级部门的 parent='0' 在集合里找不到，全被当成了并列的根。
 *    现在同步时补一条 id='0'、parent='' 的根部门记录，这里照常建树即可。
 * 3. 点击部门看不到员工 → 新增「部门成员」快照表 + GET /departments/:id/members，
 *    右侧展示该部门员工（默认含子部门，因为飞书只给直属成员）。
 */

/** 提示条：同步进度三态（running / ok / error） */
function Banner({
  tone,
  title,
  detail,
}: {
  tone: 'running' | 'ok' | 'error';
  title: string;
  detail?: string;
}) {
  const cls = tone === 'running' ? 'notice notice-info' : tone === 'error' ? 'notice notice-error' : 'notice notice-ok';
  return (
    <div className={cls}>
      <div className="notice-title">{title}</div>
      {detail && <div className="notice-detail">{detail}</div>}
    </div>
  );
}

/** 部门状态徽标（停用/已删除才显示，正常不打标） */
function StatusBadge({
  status,
  t,
}: {
  status: DepartmentStatus;
  t: (k: string, v?: Record<string, string | number>) => string;
}) {
  if (status === 'disabled') return <span className="dept-status dept-status-inactive">{t('statusDisabled')}</span>;
  if (status === 'invalid') return <span className="dept-status dept-status-resigned">{t('statusInvalid')}</span>;
  return null;
}

function fmtTime(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function DepartmentManagementPage() {
  const t = useTranslations('departments');

  const [data, setData] = useState<DepartmentListResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [sync, setSync] = useState<DepartmentSyncProgress | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /** 当前选中的部门（右侧员工列表据此加载） */
  const [selectedId, setSelectedId] = useState('');
  /** 是否含子部门 —— 默认开：飞书按部门取人只给直属成员，不含下级的话点「公司」永远是空的 */
  const [includeSub, setIncludeSub] = useState(true);
  const [members, setMembers] = useState<DepartmentMemberResult | null>(null);
  const [memberLoading, setMemberLoading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);
  useEffect(() => stopPolling, [stopPolling]);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.listDepartments();
      setData(r);
      // 默认展开全部（部门层级不深，全展开比逐层点开好用）
      setExpanded(new Set(r.items.map((n) => n.open_department_id)));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** 立即同步飞书部门：POST 立即返回，后台跑，这里轮询进度 */
  const startSync = useCallback(async () => {
    stopPolling();
    const first = await api.syncDepartments();
    setSync(first);
    if (!first.running) {
      await reload();
      return;
    }
    timerRef.current = setInterval(async () => {
      try {
        const p = await api.getDepartmentSyncStatus();
        setSync(p);
        if (!p.running) {
          stopPolling();
          await reload();
        }
      } catch {
        stopPolling();
      }
    }, 2000);
  }, [stopPolling, reload]);

  // 构建树：过滤掉 status='invalid'（已删除不展示），按 parent 分组，根节点 = 无父或父不在集合内
  const { roots, childrenMap, depthOf, validCount } = useMemo(() => {
    const valid = (data?.items ?? []).filter((n) => n.status !== 'invalid');
    const byId = new Map(valid.map((n) => [n.open_department_id, n]));
    const cMap = new Map<string, DepartmentNode[]>();
    const rootNodes: DepartmentNode[] = [];
    for (const n of valid) {
      const parent = n.parent_department_id && byId.has(n.parent_department_id) ? n.parent_department_id : '';
      if (!parent) rootNodes.push(n);
      else {
        if (!cMap.has(parent)) cMap.set(parent, []);
        cMap.get(parent)!.push(n);
      }
    }
    const sortByOrder = (arr: DepartmentNode[]) => arr.sort((a, b) => b.order - a.order);
    sortByOrder(rootNodes);
    for (const arr of cMap.values()) sortByOrder(arr);
    // 深度（搜索平铺时用于缩进）
    const depth: Record<string, number> = {};
    const walk = (n: DepartmentNode, d: number) => {
      depth[n.open_department_id] = d;
      for (const c of cMap.get(n.open_department_id) ?? []) walk(c, d + 1);
    };
    for (const r of rootNodes) walk(r, 0);
    return { roots: rootNodes, childrenMap: cMap, depthOf: depth, validCount: valid.length };
  }, [data]);

  /** 数据变化后决定默认选中：优先根部门（id='0' = 公司），否则第一个根 */
  useEffect(() => {
    if (!data) return;
    setSelectedId((cur) => {
      const valid = data.items.filter((n) => n.status !== 'invalid');
      if (cur && valid.some((n) => n.open_department_id === cur)) return cur;
      const root =
        valid.find((n) => n.open_department_id === '0') ||
        valid.find((n) => !n.parent_department_id || !valid.some((m) => m.open_department_id === n.parent_department_id));
      return root ? root.open_department_id : '';
    });
  }, [data]);

  const loadMembers = useCallback(async (id: string, sub: boolean) => {
    if (!id) {
      setMembers(null);
      return;
    }
    setMemberLoading(true);
    try {
      setMembers(await api.listDepartmentMembers(id, sub));
    } catch {
      setMembers(null);
    } finally {
      setMemberLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadMembers(selectedId, includeSub);
  }, [selectedId, includeSub, loadMembers]);

  const hasQuery = query.trim().length > 0;
  const matched = useMemo(() => {
    if (!hasQuery) return [];
    const q = query.trim().toLowerCase();
    return (data?.items ?? [])
      .filter((n) => n.status !== 'invalid' && n.name.toLowerCase().includes(q))
      .sort((a, b) => (depthOf[a.open_department_id] ?? 0) - (depthOf[b.open_department_id] ?? 0) || b.order - a.order);
  }, [hasQuery, query, data, depthOf]);

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectedNode = useMemo(
    () => (data?.items ?? []).find((n) => n.open_department_id === selectedId) ?? null,
    [data, selectedId],
  );

  const renderNode = (n: DepartmentNode, depth: number): ReactNode => {
    const kids = childrenMap.get(n.open_department_id) ?? [];
    const isOpen = expanded.has(n.open_department_id);
    const active = selectedId === n.open_department_id;
    return (
      <div key={n.open_department_id}>
        <div className={`dept-row${active ? ' dept-row-active' : ''}`} style={{ paddingLeft: depth * 14 + 6 }}>
          {kids.length > 0 ? (
            <button
              type="button"
              className="dept-caret"
              onClick={() => toggle(n.open_department_id)}
              aria-label={isOpen ? t('collapseAll') : t('expandAll')}
            >
              {isOpen ? '▾' : '▸'}
            </button>
          ) : (
            <span className="dept-caret" />
          )}
          <button type="button" className="dept-name" onClick={() => setSelectedId(n.open_department_id)} title={n.name}>
            <span className="dept-name-text">{n.name}</span>
            <StatusBadge status={n.status} t={t} />
          </button>
          <span className="dept-count">{n.member_count}</span>
        </div>
        {isOpen && kids.map((c) => renderNode(c, depth + 1))}
      </div>
    );
  };

  return (
    <div className="page">
      <div className="page-content">
        <div className="page-header page-header-row">
          <div>
            <div className="page-eyebrow">{t('eyebrow')}</div>
            <h1 className="page-title">{t('title')}</h1>
            <p className="page-subtitle">{t('subtitle')}</p>
          </div>
          <div className="page-header-actions">
            <button className="btn btn-primary" onClick={() => void startSync()} disabled={sync?.running}>
              {sync?.running ? t('syncing') : t('syncNow')}
            </button>
          </div>
        </div>

        {sync && (
          <Banner
            tone={sync.running ? 'running' : sync.error ? 'error' : 'ok'}
            title={sync.running ? t('syncing') : sync.error ? t('syncFailed') : t('syncDone')}
            detail={
              sync.error
                ? t('syncError', { msg: sync.error })
                : sync.result || (sync.running ? `已处理 ${sync.stored} / 拉取 ${sync.fetched}` : '')
            }
          />
        )}

        <div className="dept-meta-line">
          <span>{data ? t('total', { count: validCount }) : ''}</span>
          <span>
            {data?.lastSyncedAt ? t('lastSynced', { time: fmtTime(data.lastSyncedAt) }) : t('neverSynced')}
          </span>
          <span className="dept-meta-hint">{t('readOnlyHint')}</span>
        </div>

        <div className="dept-layout">
          <div className="card dept-tree-card">
            <div className="dept-card-head">
              <span className="dept-card-title">{t('treeTitle')}</span>
              <span className="dept-card-meta">
                {t('expandAll')} / {t('collapseAll')}
              </span>
            </div>
            <div className="dept-tree-tools">
              <input
                className="form-input"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('searchPlaceholder')}
              />
              <div className="dept-tree-ops">
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => setExpanded(new Set((data?.items ?? []).map((n) => n.open_department_id)))}
                >
                  {t('expandAll')}
                </button>
                <button type="button" className="link-btn" onClick={() => setExpanded(new Set())}>
                  {t('collapseAll')}
                </button>
              </div>
            </div>
            <div className="dept-tree">
              {loading && !data ? (
                <div className="dept-loading">…</div>
              ) : hasQuery ? (
                matched.length === 0 ? (
                  <div className="dept-loading">{t('empty')}</div>
                ) : (
                  matched.map((n) => (
                    <div
                      key={n.open_department_id}
                      className={`dept-row${selectedId === n.open_department_id ? ' dept-row-active' : ''}`}
                      style={{ paddingLeft: (depthOf[n.open_department_id] ?? 0) * 14 + 6 }}
                    >
                      <span className="dept-caret" />
                      <button
                        type="button"
                        className="dept-name"
                        onClick={() => setSelectedId(n.open_department_id)}
                        title={n.name}
                      >
                        <span className="dept-name-text">{n.name}</span>
                        <StatusBadge status={n.status} t={t} />
                      </button>
                      <span className="dept-count">{n.member_count}</span>
                    </div>
                  ))
                )
              ) : roots.length === 0 ? (
                <div className="dept-loading">{t('empty')}</div>
              ) : (
                roots.map((r) => renderNode(r, 0))
              )}
            </div>
          </div>

          <div className="card dept-main-card">
            <div className="dept-card-head">
              <span className="dept-card-title">{selectedNode ? selectedNode.name : t('pickDept')}</span>
              <label className="dept-sub-toggle">
                <input type="checkbox" checked={includeSub} onChange={(e) => setIncludeSub(e.target.checked)} />
                <span>{t('includeSub')}</span>
              </label>
              <span className="dept-card-meta">
                {members ? t('employeeCount', { count: members.total }) : ''}
                {members?.synced_at ? ` · ${t('memberSyncedAt', { time: fmtTime(members.synced_at) })}` : ''}
              </span>
            </div>

            {!selectedId ? (
              <div className="empty-state">
                <div className="empty-state-icon">🏢</div>
                <div className="empty-state-text">{t('pickDept')}</div>
              </div>
            ) : memberLoading ? (
              <div className="dept-loading">{t('loading')}</div>
            ) : !members || members.items.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-icon">👥</div>
                <div className="empty-state-text">{t('employeeEmpty')}</div>
                <div className="empty-state-text">{t('memberSyncHint')}</div>
              </div>
            ) : (
              <div className="data-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>{t('colName')}</th>
                      <th>{t('colUserId')}</th>
                      <th>{t('colDept')}</th>
                      <th>{t('colStatus')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {members.items.map((m) => (
                      <tr key={`${m.open_department_id}__${m.open_id}`}>
                        <td>
                          <div className="dept-emp-name">{m.name}</div>
                          {m.en_name ? <div className="dept-emp-sub">{m.en_name}</div> : null}
                        </td>
                        <td>{m.user_id || '—'}</td>
                        <td>{m.department_name || '—'}</td>
                        <td>
                          <span
                            className={
                              m.status === 'resigned'
                                ? 'dept-status dept-status-resigned'
                                : m.status === 'inactive'
                                  ? 'dept-status dept-status-inactive'
                                  : 'dept-status dept-status-ok'
                            }
                          >
                            {m.status === 'resigned'
                              ? t('statusResigned')
                              : m.status === 'inactive'
                                ? t('statusInactive')
                                : t('empActive')}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
