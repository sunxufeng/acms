'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, type DepartmentListResult, type DepartmentNode, type DepartmentSyncProgress } from '../../lib/api';
import { useTranslations } from 'next-intl';

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
  const color = tone === 'running' ? 'var(--accent)' : tone === 'error' ? 'var(--danger)' : 'var(--success)';
  const bg =
    tone === 'running' ? 'var(--accent-muted)' : tone === 'error' ? 'var(--danger-muted)' : 'var(--success-muted)';
  return (
    <div
      className="mb-4 rounded-lg border px-4 py-3 text-sm"
      style={{ borderColor: color, background: bg, color: 'var(--fg)' }}
    >
      <div className="font-medium">{title}</div>
      {detail && <div className="mt-1 text-xs" style={{ color: 'var(--fg-tertiary)' }}>{detail}</div>}
    </div>
  );
}

/** 状态徽标 */
function StatusBadge({ status, t }: { status: DepartmentNode['status']; t: (k: string, v?: Record<string, string | number>) => string }) {
  if (status === 'disabled') {
    return (
      <span className="ml-2 rounded px-1.5 py-0.5 text-xs" style={{ background: 'var(--warning-muted)', color: 'var(--warning)' }}>
        {t('statusDisabled')}
      </span>
    );
  }
  if (status === 'invalid') {
    return (
      <span className="ml-2 rounded px-1.5 py-0.5 text-xs" style={{ background: 'var(--danger-muted)', color: 'var(--danger)' }}>
        {t('statusInvalid')}
      </span>
    );
  }
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
      // 默认展开全部
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

  // 构建树：过滤掉 status='invalid'（已删除不展示），按 parent 分组，根节点 = parent 为空或父不在集合内
  const { roots, childrenMap, depthOf } = useMemo(() => {
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
    // 计算深度（用于搜索时扁平展示缩进）
    const depth: Record<string, number> = {};
    const walk = (n: DepartmentNode, d: number) => {
      depth[n.open_department_id] = d;
      for (const c of cMap.get(n.open_department_id) ?? []) walk(c, d + 1);
    };
    for (const r of rootNodes) walk(r, 0);
    return { roots: rootNodes, childrenMap: cMap, depthOf: depth };
  }, [data]);

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

  const renderNode = (n: DepartmentNode, depth: number): ReactNode => {
    const kids = childrenMap.get(n.open_department_id) ?? [];
    const isOpen = expanded.has(n.open_department_id);
    return (
      <div key={n.open_department_id}>
        <div
          className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-[var(--bg-subtle)]"
          style={{ paddingLeft: depth * 18 + 8 }}
        >
          {kids.length > 0 ? (
            <button
              onClick={() => toggle(n.open_department_id)}
              className="w-4 shrink-0 text-xs text-[var(--fg-tertiary)]"
              aria-label={isOpen ? 'collapse' : 'expand'}
            >
              {isOpen ? '▾' : '▸'}
            </button>
          ) : (
            <span className="w-4 shrink-0" />
          )}
          <span className="font-medium">{n.name}</span>
          <StatusBadge status={n.status} t={t} />
          <span className="ml-auto text-xs" style={{ color: 'var(--fg-tertiary)' }}>
            {t('memberCount', { count: n.member_count })}
          </span>
        </div>
        {isOpen && kids.map((c) => renderNode(c, depth + 1))}
      </div>
    );
  };

  return (
    <div className="mx-auto max-w-4xl px-4 py-6">
      <div className="mb-1 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">{t('title')}</h1>
          <p className="text-sm" style={{ color: 'var(--fg-tertiary)' }}>{t('subtitle')}</p>
        </div>
        <button
          onClick={() => void startSync()}
          disabled={sync?.running}
          className="rounded-md px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          style={{ background: 'var(--accent)' }}
        >
          {sync?.running ? t('syncing') : t('syncNow')}
        </button>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-3 text-xs" style={{ color: 'var(--fg-tertiary)' }}>
        <span>
          {data ? t('total', { count: data.items.filter((n) => n.status !== 'invalid').length }) : ''}
        </span>
        <span>
          {data?.lastSyncedAt
            ? t('lastSynced', { time: fmtTime(data.lastSyncedAt) })
            : t('neverSynced')}
        </span>
        {!hasQuery && (
          <span className="ml-auto flex gap-2">
            <button className="hover:underline" onClick={() => setExpanded(new Set((data?.items ?? []).map((n) => n.open_department_id)))}>
              {t('expandAll')}
            </button>
            <button className="hover:underline" onClick={() => setExpanded(new Set())}>
              {t('collapseAll')}
            </button>
          </span>
        )}
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

      <div className="mb-4 rounded-lg border px-3 py-2 text-xs" style={{ borderColor: 'var(--border)', background: 'var(--bg-subtle)', color: 'var(--fg-tertiary)' }}>
        {t('readOnlyHint')}
      </div>

      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('searchPlaceholder')}
        className="mb-3 w-full rounded-md border px-3 py-2 text-sm"
        style={{ borderColor: 'var(--border)', background: 'var(--bg)', color: 'var(--fg)' }}
      />

      <div className="rounded-lg border" style={{ borderColor: 'var(--border)' }}>
        {loading && !data ? (
          <div className="p-6 text-center text-sm" style={{ color: 'var(--fg-tertiary)' }}>…</div>
        ) : hasQuery ? (
          matched.length === 0 ? (
            <div className="p-6 text-center text-sm" style={{ color: 'var(--fg-tertiary)' }}>{t('empty')}</div>
          ) : (
            matched.map((n) => (
              <div
                key={n.open_department_id}
                className="flex items-center gap-2 rounded px-2 py-1.5"
                style={{ paddingLeft: (depthOf[n.open_department_id] ?? 0) * 18 + 8 }}
              >
                <span className="font-medium">{n.name}</span>
                <StatusBadge status={n.status} t={t} />
                <span className="ml-auto text-xs" style={{ color: 'var(--fg-tertiary)' }}>
                  {t('memberCount', { count: n.member_count })}
                </span>
              </div>
            ))
          )
        ) : roots.length === 0 ? (
          <div className="p-6 text-center text-sm" style={{ color: 'var(--fg-tertiary)' }}>{t('empty')}</div>
        ) : (
          roots.map((r) => renderNode(r, 0))
        )}
      </div>
    </div>
  );
}
