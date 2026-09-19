'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useTl } from '../lib/useTl';

export interface DeptOption {
  /** 部门 open_department_id（判据与存储都用它，不用部门名） */
  value: string;
  /** 部门名 */
  label: string;
  /** 上级部门 id（一级部门的上级是根「公司」`'0'`，它不在候选里 ⇒ 被当作根节点） */
  parent?: string;
}

/** 三态：未选 / 全选 / 半选（部分子孙被选） */
type CheckState = 'none' | 'all' | 'some';

/**
 * 部门多选树（带复选框 + 级联）。
 *
 * 行为（2026-09-19 按峰哥要求实现）：
 *  - 勾上级 → 整棵子树一起勾上；取消上级 → 整棵子树一起取消
 *  - 取消某个下级 → 上级显示**半选态**（不是全选也不是未选）
 *  - 已选项在下方以胶囊列出，可逐个删
 *
 * 🔴 存的是 **open_department_id**（`od-…`）而不是部门名 —— 判据与筛选都靠它：
 *    · 多值字段的筛选只能走 `contains` 子串匹配，部门名会串台
 *      （「教学」会命中「教学管理中心」），id 唯一且互不为子串
 *    · 免疫部门改名：改名后历史记录依然有效
 *    ⚠️ 根部门「公司」的 id 是字符串 `'0'` —— 单字符做子串匹配会命中一切，
 *       所以 CrudPage 侧的候选**刻意过滤掉它**（要全公司可见请用可见范围的「公开」）。
 */
export default function DepartmentMultiTree({
  options,
  value,
  onChange,
  disabled,
  hint,
}: {
  options: DeptOption[];
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  hint?: string;
}) {
  const tl = useTl();
  // t() 管纯 UI 文案，tl() 管**数据类**文本（部门名：中文既是存储值也是显示文本）—— 别混用
  const t = useTranslations();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const sel = useMemo(() => new Set(value), [value]);

  /** 子节点索引 */
  const childrenMap = useMemo(() => {
    const m = new Map<string, string[]>();
    const ids = new Set(options.map((o) => o.value));
    for (const o of options) {
      // parent 不在候选里（如根 '0'）的当作根节点，不进任何父节点的子列表
      const p = o.parent && ids.has(o.parent) ? o.parent : '';
      if (!p) continue;
      const cur = m.get(p) ?? [];
      cur.push(o.value);
      m.set(p, cur);
    }
    return m;
  }, [options]);

  const roots = useMemo(() => {
    const ids = new Set(options.map((o) => o.value));
    return options.filter((o) => !o.parent || !ids.has(o.parent));
  }, [options]);

  /** 某节点 + 全部子孙（深度优先） */
  const withDescendants = (id: string): string[] => {
    const out: string[] = [id];
    const stack = [...(childrenMap.get(id) ?? [])];
    while (stack.length) {
      const cur = stack.pop() as string;
      out.push(cur);
      stack.push(...(childrenMap.get(cur) ?? []));
    }
    return out;
  };

  const stateOf = (id: string): CheckState => {
    const all = withDescendants(id);
    const on = all.filter((x) => sel.has(x)).length;
    if (on === 0) return 'none';
    return on === all.length ? 'all' : 'some';
  };

  const toggle = (id: string) => {
    if (disabled) return;
    const all = withDescendants(id);
    const next = new Set(sel);
    if (all.every((x) => next.has(x))) all.forEach((x) => next.delete(x));
    else all.forEach((x) => next.add(x));
    onChange([...next]);
  };

  const removeOne = (id: string) => {
    if (disabled) return;
    onChange(value.filter((x) => x !== id));
  };

  const labelOf = (id: string) => options.find((o) => o.value === id)?.label ?? id;

  /** 一行：复选框 + 名称（递归渲染子树） */
  const renderNode = (o: DeptOption, depth: number): React.ReactNode => {
    const st = stateOf(o.value);
    const kids = childrenMap.get(o.value) ?? [];
    const isCollapsed = collapsed.has(o.value);
    return (
      <div key={o.value}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '5px 6px',
            paddingLeft: 6 + depth * 18,
            borderRadius: 'var(--radius-sm)',
            cursor: disabled ? 'not-allowed' : 'pointer',
            opacity: disabled ? 0.7 : 1,
          }}
          onClick={() => toggle(o.value)}
        >
          {kids.length ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setCollapsed((prev) => {
                  const next = new Set(prev);
                  if (next.has(o.value)) next.delete(o.value);
                  else next.add(o.value);
                  return next;
                });
              }}
              style={{
                border: 'none',
                background: 'transparent',
                color: 'var(--fg-tertiary)',
                cursor: 'pointer',
                padding: 0,
                width: 12,
                fontSize: 'var(--font-xs)',
                lineHeight: 1,
              }}
              aria-label={isCollapsed ? t('crud.expand') : t('crud.collapse')}
            >
              {isCollapsed ? '▸' : '▾'}
            </button>
          ) : (
            <span style={{ width: 12, display: 'inline-block' }} />
          )}

          {/* 三态复选框：用自绘方块（全选=勾、半选=横杠、未选=空框），
              比原生 checkbox 的 indeterminate 更好控样式，也便于无障碍标注 */}
          <span
            role="checkbox"
            aria-checked={st === 'all' ? true : st === 'some' ? 'mixed' : false}
            style={{
              width: 14,
              height: 14,
              flex: '0 0 14px',
              borderRadius: 3,
              border: st === 'none' ? '1px solid var(--border-strong)' : '1px solid var(--accent)',
              background: st === 'none' ? 'transparent' : 'var(--accent)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--fg-on-accent)',
              fontSize: 10,
              lineHeight: 1,
            }}
          >
            {st === 'all' ? '✓' : st === 'some' ? '−' : ''}
          </span>

          <span style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-primary)' }}>{tl(o.label)}</span>
        </div>
        {!isCollapsed && kids.length
          ? kids.map((kid) => {
              const child = options.find((x) => x.value === kid);
              return child ? renderNode(child, depth + 1) : null;
            })
          : null}
      </div>
    );
  };

  return (
    <div>
      <div
        style={{
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)',
          background: 'var(--bg-input)',
          padding: 6,
          maxHeight: 300,
          overflowY: 'auto',
        }}
      >
        {roots.length === 0 ? (
          <div style={{ padding: '6px 8px', fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>
            {t('crud.noOptions')}
          </div>
        ) : (
          roots.map((o) => renderNode(o, 0))
        )}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8, alignItems: 'center' }}>
        {value.length === 0 ? (
          <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>{t('crud.noneSelected')}</span>
        ) : (
          value.map((id) => (
            <span
              key={id}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                padding: '2px 6px 2px 8px',
                borderRadius: 'var(--radius-full)',
                background: 'var(--accent-soft)',
                color: 'var(--accent-strong)',
                fontSize: 'var(--font-xs)',
              }}
            >
              {labelOf(id)}
              {disabled ? null : (
                <button
                  type="button"
                  aria-label={t('common.delete')}
                  onClick={() => removeOne(id)}
                  style={{
                    border: 'none',
                    background: 'transparent',
                    color: 'inherit',
                    cursor: 'pointer',
                    padding: 0,
                    lineHeight: 1,
                    fontSize: 'var(--font-sm)',
                  }}
                >
                  ×
                </button>
              )}
            </span>
          ))
        )}
      </div>

      {hint ? (
        <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)', marginTop: 6 }}>{hint}</div>
      ) : null}
    </div>
  );
}
