'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { api, type DepartmentListResult, type DepartmentNode, type DepartmentStatus } from '../lib/api';

/**
 * 部门架构树（共享组件）。
 *
 * 2026-09-15 从「部门管理」页抽出来，供两个页面共用，避免两份实现：
 * 1. 部门管理页 —— 点部门看员工（右侧成员表）
 * 2. 用户管理页 —— 点部门筛选系统账号（右侧用户列表）
 *
 * 数据来源：`GET /departments`（本地快照，只读）。
 * 传 `data` 就用外部已加载的那份（部门管理页要顺带显示同步时间/部门数，不必重复请求）；
 * 不传则组件自己拉一次（用户管理页）。
 *
 * 人数徽标：默认取部门表的 `member_count`（飞书给的**直属**人数）。
 * 口径不同时用 `countOf` 覆盖 —— 用户管理页要的是「这个部门（含下级）能筛出几个**系统账号**」，
 * 那个数和飞书直属人数不是一回事（例：学术轨直属 1 人，但它下面 3 个中心共有 12 个账号）。
 */

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

export interface DepartmentTreeProps {
  /** 当前选中的部门 id；空串 = 选中「全部」 */
  selectedId: string;
  /** 选中回调。(id, name) —— name 供调用方做展示（如筛选提示条） */
  onSelect: (id: string, name: string) => void;
  /** 外部已加载的数据；不传则组件自行加载 */
  data?: DepartmentListResult | null;
  /** 外部加载态；不传时用组件自身的加载态 */
  loading?: boolean;
  /**
   * 顶部固定一行「全部」（如「全部用户」）的文案。
   * 传了才显示 —— 它代表「不做部门限制」，选中时回调 `onSelect('', label)`。
   */
  allLabel?: string;
  /** 「全部」行右侧的数字 */
  allCount?: number;
  /**
   * 只把这些人算进徽标人数（如用户管理页传「有系统账号的 openId 集合」）。
   * 传了它，徽标 = 该部门**含下级**内满足条件的成员数（与点进去看到的人数一致）；
   * 不传则用部门表的 `member_count`（飞书给的直属人数，部门管理页的口径）。
   */
  countedOpenIds?: Set<string>;
  /** openId → 部门 id 的映射（`GET /departments/member-index`）；与 countedOpenIds 搭配使用 */
  memberIndex?: { departmentId: string; openId: string }[];
  /** 搜索框下方的额外控件（如用户管理页的「含下级部门」勾选） */
  toolbarExtra?: ReactNode;
  /** 卡片外层类名（默认 `card dept-tree-card`） */
  className?: string;
  /** 卡片标题（默认「部门架构」） */
  title?: string;
}

export default function DepartmentTree({
  selectedId,
  onSelect,
  data,
  loading,
  allLabel,
  allCount,
  toolbarExtra,
  className,
  title,
  countedOpenIds,
  memberIndex,
}: DepartmentTreeProps) {
  const t = useTranslations('departments');
  const [own, setOwn] = useState<DepartmentListResult | null>(null);
  const [ownLoading, setOwnLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const src = data ?? own;
  const busy = loading ?? ownLoading;

  /** 外部没给数据就自己拉一次（部门管理页传了 data，这里不会触发请求） */
  useEffect(() => {
    if (data) return;
    let alive = true;
    setOwnLoading(true);
    api
      .listDepartments()
      .then((r) => {
        if (alive) setOwn(r);
      })
      .catch(() => {
        if (alive) setOwn(null);
      })
      .finally(() => {
        if (alive) setOwnLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [data]);

  // 建树：过滤 status='invalid'（已删除不展示），按 parent 分组，根节点 = 无父或父不在集合内
  const { roots, childrenMap, depthOf } = useMemo(() => {
    const valid = (src?.items ?? []).filter((n) => n.status !== 'invalid');
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
    const depth: Record<string, number> = {};
    const walk = (n: DepartmentNode, d: number) => {
      depth[n.open_department_id] = d;
      for (const c of cMap.get(n.open_department_id) ?? []) walk(c, d + 1);
    };
    for (const r of rootNodes) walk(r, 0);
    return { roots: rootNodes, childrenMap: cMap, depthOf: depth };
  }, [src]);

  /** 数据变化后默认展开全部（部门层级不深，全展开比逐层点开好用） */
  useEffect(() => {
    if (!src) return;
    setExpanded(new Set(src.items.map((n) => n.open_department_id)));
  }, [src]);

  const hasQuery = query.trim().length > 0;
  const matched = useMemo(() => {
    if (!hasQuery) return [];
    const q = query.trim().toLowerCase();
    return (src?.items ?? [])
      .filter((n) => n.status !== 'invalid' && n.name.toLowerCase().includes(q))
      .sort(
        (a, b) =>
          (depthOf[a.open_department_id] ?? 0) - (depthOf[b.open_department_id] ?? 0) || b.order - a.order,
      );
  }, [hasQuery, query, src, depthOf]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /**
   * 徽标人数：给了 countedOpenIds 就按「该部门含下级、且算得上人头的成员」去重统计，
   * 否则回退部门表的 member_count。结果按部门缓存，避免每次渲染重算整棵树。
   */
  const badgeOf = useMemo(() => {
    if (!countedOpenIds) return (n: DepartmentNode) => n.member_count;
    const byDept = new Map<string, string[]>();
    for (const r of memberIndex ?? []) {
      const arr = byDept.get(r.departmentId);
      if (arr) arr.push(r.openId);
      else byDept.set(r.departmentId, [r.openId]);
    }
    const memo = new Map<string, number>();
    return (n: DepartmentNode): number => {
      const hit = memo.get(n.open_department_id);
      if (hit !== undefined) return hit;
      const seen = new Set<string>();
      const walk = (x: string) => {
        for (const oid of byDept.get(x) ?? []) if (countedOpenIds.has(oid)) seen.add(oid);
        for (const c of childrenMap.get(x) ?? []) walk(c.open_department_id);
      };
      walk(n.open_department_id);
      memo.set(n.open_department_id, seen.size);
      return seen.size;
    };
  }, [countedOpenIds, memberIndex, childrenMap]);

  /** 一行：caret（有子节点才可折叠）+ 名称 + 人数 */
  const row = (n: DepartmentNode, depth: number, opts: { caret: boolean; padLeft?: number }) => {
    const kids = childrenMap.get(n.open_department_id) ?? [];
    const isOpen = expanded.has(n.open_department_id);
    const active = selectedId === n.open_department_id;
    const padLeft = opts.padLeft ?? depth * 14 + 6;
    return (
      <div
        key={n.open_department_id}
        className={`dept-row${active ? ' dept-row-active' : ''}`}
        style={{ paddingLeft: padLeft }}
      >
        {opts.caret && kids.length > 0 ? (
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
        <button
          type="button"
          className="dept-name"
          onClick={() => onSelect(n.open_department_id, n.name)}
          title={n.name}
        >
          <span className="dept-name-text">{n.name}</span>
          <StatusBadge status={n.status} t={t} />
        </button>
        <span className="dept-count">{badgeOf(n)}</span>
      </div>
    );
  };

  const renderNode = (n: DepartmentNode, depth: number): ReactNode => {
    const kids = childrenMap.get(n.open_department_id) ?? [];
    const isOpen = expanded.has(n.open_department_id);
    return (
      <div key={n.open_department_id}>
        {row(n, depth, { caret: true })}
        {isOpen && kids.map((c) => renderNode(c, depth + 1))}
      </div>
    );
  };

  return (
    <div className={className ?? 'card dept-tree-card'}>
      <div className="dept-card-head">
        <span className="dept-card-title">{title ?? t('treeTitle')}</span>
        <span className="dept-card-meta">
          <button
            type="button"
            className="link-btn"
            onClick={() => setExpanded(new Set((src?.items ?? []).map((n) => n.open_department_id)))}
          >
            {t('expandAll')}
          </button>
          <span style={{ color: 'var(--fg-tertiary)' }}> / </span>
          <button type="button" className="link-btn" onClick={() => setExpanded(new Set())}>
            {t('collapseAll')}
          </button>
        </span>
      </div>

      <div className="dept-tree-tools">
        <input
          className="form-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('searchPlaceholder')}
        />
      </div>
      {toolbarExtra ? <div className="dept-tree-tools">{toolbarExtra}</div> : null}

      <div className="dept-tree">
        {allLabel ? (
          <>
            <div className={`dept-row${selectedId === '' ? ' dept-row-active' : ''}`} style={{ paddingLeft: 6 }}>
              <span className="dept-caret" />
              <button type="button" className="dept-name" onClick={() => onSelect('', allLabel)}>
                <span className="dept-name-text">{allLabel}</span>
              </button>
              {allCount === undefined ? null : <span className="dept-count">{allCount}</span>}
            </div>
            <div style={{ height: 1, background: 'var(--border)', margin: '6px 6px' }} />
          </>
        ) : null}

        {busy && !src ? (
          <div className="dept-loading">…</div>
        ) : hasQuery ? (
          matched.length === 0 ? (
            <div className="dept-loading">{t('empty')}</div>
          ) : (
            matched.map((n) => row(n, 0, { caret: false }))
          )
        ) : roots.length === 0 ? (
          <div className="dept-loading">{t('empty')}</div>
        ) : (
          roots.map((r) => renderNode(r, 0))
        )}
      </div>
    </div>
  );
}
