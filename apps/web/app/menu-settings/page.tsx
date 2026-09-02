'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  DEFAULT_NAV_MENU_CONFIG,
  ICON_NAMES,
  type NavMenuConfig,
  type NavMenuItem,
  type NavMenuGroupConfig,
} from '@acms/contracts';
import { api } from '../../lib/api';
import { ICONS } from '../../components/AppShell';
import { useTl } from '../../lib/useTl';
import { useTranslations } from 'next-intl';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 12,
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--fg)' }}>{title}</div>
      {children}
    </div>
  );
}

function emptyItem(): NavMenuItem {
  return {
    key: `menu_${Date.now()}`,
    label: '新菜单',
    enLabel: '',
    href: '/',
    icon: 'settings',
    section: '后台管理',
    parentKey: null,
    order: 100,
    adminOnly: false,
    disabled: false,
  };
}

/** 图标选择器：按钮展示当前图标预览，展开为图标网格，支持搜索 */
function IconPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const tl = useTl();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const Current = ICONS[value] ?? ICONS['settings'];
  const list = ICON_NAMES.filter((n) => n.includes(q.trim().toLowerCase()));
  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        className="input"
        onClick={() => setOpen((o) => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 96, cursor: 'pointer' }}
      >
        <span style={{ display: 'inline-flex', width: 16, height: 16, color: 'var(--accent)' }}><Current /></span>
        <span style={{ fontSize: 12, color: 'var(--fg-secondary)' }}>{value}</span>
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            zIndex: 50,
            top: 'calc(100% + 4px)',
            left: 0,
            width: 280,
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 12,
            padding: 10,
            boxShadow: 'var(--shadow-lg)',
          }}
        >
          <input
            className="input"
            placeholder={tl('搜索图标…')}
            value={q}
            autoFocus
            onChange={(e) => setQ(e.target.value)}
            style={{ marginBottom: 8, width: '100%' }}
          />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 6, maxHeight: 220, overflowY: 'auto' }}>
            {list.map((name) => {
              const C = ICONS[name] ?? ICONS['settings'];
              const active = name === value;
              return (
                <button
                  key={name}
                  type="button"
                  title={name}
                  onClick={() => { onChange(name); setOpen(false); setQ(''); }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    height: 34,
                    borderRadius: 8,
                    border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                    background: active ? 'var(--accent-soft)' : 'transparent',
                    color: active ? 'var(--accent)' : 'var(--fg)',
                    cursor: 'pointer',
                  }}
                >
                  <span style={{ display: 'inline-flex', width: 18, height: 18 }}><C /></span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export default function MenuSettingsPage() {

  const tl = useTl();
  const ts = useTranslations('settings');
  const tc = useTranslations('common');
  const [items, setItems] = useState<NavMenuItem[]>(DEFAULT_NAV_MENU_CONFIG.items);
  const [groups, setGroups] = useState<NavMenuGroupConfig['items']>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // 拖拽排序状态
  const [dragRow, setDragRow] = useState<number | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  useEffect(() => {
    Promise.all([
      api.getMenuConfig().then((d) => {
        if (Array.isArray(d?.items)) setItems(d.items);
      }),
      api.getMenuGroups().then((g) => {
        if (Array.isArray(g?.items)) setGroups(g.items);
      }),
    ])
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const topKeys = useMemo(
    () => items.filter((it) => !it.parentKey).map((it) => ({ key: it.key, label: it.label })),
    [items],
  );

  function updateItem(idx: number, patch: Partial<NavMenuItem>) {
    setItems((prev) => {
      const list = prev.slice();
      list[idx] = { ...list[idx], ...patch };
      return list;
    });
  }

  function removeItem(idx: number) {
    if (!confirm(ts('confirmDeleteMenuItem'))) return;
    const target = items[idx];
    setItems((prev) => {
      // 同时删除以该菜单为父级的子菜单
      const list = prev.filter((it, i) => i !== idx && it.parentKey !== target.key);
      return list;
    });
  }

  function addItem() {
    setItems((prev) => [...prev, emptyItem()]);
  }

  function moveItem(idx: number, dir: -1 | 1) {
    const nextIdx = idx + dir;
    if (nextIdx < 0 || nextIdx >= items.length) return;
    setItems((prev) => {
      const list = prev.slice();
      const tmp = list[idx];
      list[idx] = list[nextIdx];
      list[nextIdx] = tmp;
      return list;
    });
  }

  // 拖拽排序：把 from 位置的项移动到 to 位置
  function reorderByDrag(from: number, to: number) {
    if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return;
    setItems((prev) => {
      const list = prev.slice();
      const [moved] = list.splice(from, 1);
      list.splice(to, 0, moved);
      return list;
    });
  }

  function handleDragStart(e: React.DragEvent, idx: number) {
    setDragIndex(idx);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(idx));
  }

  function handleDragOver(e: React.DragEvent, idx: number) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (overIndex !== idx) setOverIndex(idx);
  }

  function handleDrop(e: React.DragEvent, idx: number) {
    e.preventDefault();
    if (dragIndex !== null) reorderByDrag(dragIndex, idx);
    setDragIndex(null);
    setOverIndex(null);
    setDragRow(null);
  }

  function handleDragEnd() {
    setDragIndex(null);
    setOverIndex(null);
    setDragRow(null);
  }

  async function handleSave() {
    setSaving(true);
    try {
      // 自动同步 order 为当前顺序
      const normalized = items.map((it, i) => ({ ...it, order: (i + 1) * 10 }));
      await api.updateMenuConfig({ items: normalized });
      setItems(normalized);
      setToast(ts('saveSuccessRefreshMenu'));
      setTimeout(() => setToast(null), 2500);
    } catch (err) {
      setToast(ts('saveFailedMsg', { msg: err instanceof Error ? err.message : ts('unknownError') }));
    } finally {
      setSaving(false);
    }
  }

  function handleReset() {
    if (confirm(ts('confirmResetMenu'))) {
      setItems(DEFAULT_NAV_MENU_CONFIG.items);
    }
  }

  if (loading) {
    return <div style={{ padding: 40, color: 'var(--fg-secondary)' }}>{tl('加载中…')}</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div className="page-title">{tl('菜单管理')}</div>
          <div className="page-subtitle">{tl('编辑导航菜单的分组、上下级关系、名称、图标与权限，保存后刷新页面生效。')}</div>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <Link href="/homepage-settings" className="btn btn-outline">
            返回登录页配置
          </Link>
          <button type="button" className="btn btn-outline" onClick={handleReset}>
            恢复默认
          </button>
          <button type="button" className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? tc('saving') : ts('saveMenu')}
          </button>
        </div>
      </div>

      <Section title={tl('菜单项列表')}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ color: 'var(--fg-secondary)', borderBottom: '1px solid var(--border)' }}>
                <th style={{ textAlign: 'center', padding: '8px 6px', width: 36 }} title={tl('拖动排序')}>⠿</th>
                <th style={{ textAlign: 'left', padding: '8px 10px', width: 40 }}>#</th>
                <th style={{ textAlign: 'left', padding: '8px 10px', minWidth: 120 }}>{tl('名称')}</th>
                <th style={{ textAlign: 'left', padding: '8px 10px', minWidth: 120 }}>{tl('英文名称')}</th>
                <th style={{ textAlign: 'left', padding: '8px 10px', minWidth: 120 }}>{tl('路径 (href)')}</th>
                <th style={{ textAlign: 'left', padding: '8px 10px', minWidth: 100 }}>{tl('图标')}</th>
                <th style={{ textAlign: 'left', padding: '8px 10px', minWidth: 100 }}>{tl('分组')}</th>
                <th style={{ textAlign: 'left', padding: '8px 10px', minWidth: 120 }}>{tl('父级菜单')}</th>
                <th style={{ textAlign: 'left', padding: '8px 10px', minWidth: 80 }}>{tl('权限')}</th>
                <th style={{ textAlign: 'center', padding: '8px 10px', width: 120 }}>{tl('选项')}</th>
                <th style={{ textAlign: 'center', padding: '8px 10px', width: 100 }}>{tl('操作')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, idx) => (
                <tr
                  key={it.key}
                  draggable={idx === dragRow}
                  onDragStart={(e) => handleDragStart(e, idx)}
                  onDragOver={(e) => handleDragOver(e, idx)}
                  onDrop={(e) => handleDrop(e, idx)}
                  onDragEnd={handleDragEnd}
                  style={{
                    borderBottom: '1px solid var(--border)',
                    background:
                      overIndex === idx && dragIndex !== null && dragIndex !== idx
                        ? 'var(--accent-soft)'
                        : dragIndex === idx
                          ? 'var(--accent-muted)'
                          : 'transparent',
                    cursor: idx === dragRow ? 'grabbing' : 'default',
                  }}
                >
                  <td style={{ padding: '6px 6px', textAlign: 'center' }}>
                    <span
                      title={tl('按住拖动排序')}
                      onMouseDown={() => setDragRow(idx)}
                      style={{
                        cursor: 'grab',
                        display: 'inline-block',
                        color: 'var(--fg-tertiary)',
                        fontSize: 16,
                        lineHeight: 1,
                        userSelect: 'none',
                      }}
                    >
                      ⠿
                    </span>
                  </td>
                  <td style={{ padding: '6px 10px', color: 'var(--fg-tertiary)' }}>{idx + 1}</td>
                  <td style={{ padding: '6px 10px' }}>
                    <input
                      className="input"
                      value={it.label}
                      onChange={(e) => updateItem(idx, { label: e.target.value })}
                      style={{ minWidth: 100 }}
                    />
                  </td>
                  <td style={{ padding: '6px 10px' }}>
                    <input
                      className="input"
                      value={it.enLabel || ''}
                      placeholder={tl('英文显示名')}
                      onChange={(e) => updateItem(idx, { enLabel: e.target.value || undefined })}
                      style={{ minWidth: 100 }}
                    />
                  </td>
                  <td style={{ padding: '6px 10px' }}>
                    <input
                      className="input"
                      value={it.href}
                      onChange={(e) => updateItem(idx, { href: e.target.value })}
                      style={{ minWidth: 100 }}
                    />
                  </td>
                  <td style={{ padding: '6px 10px' }}>
                    <IconPicker value={it.icon} onChange={(v) => updateItem(idx, { icon: v })} />
                  </td>
                  <td style={{ padding: '6px 10px' }}>
                    <select
                      className="input"
                      value={it.section || ''}
                      onChange={(e) => updateItem(idx, { section: e.target.value || null })}
                      style={{ minWidth: 90 }}
                    >
                      {groups.length === 0 && <option value="">{tl('（无分组）')}</option>}
                      {groups.map((g) => (
                        <option key={g.key} value={g.label}>
                          {g.label}
                        </option>
                      ))}
                      {groups.length > 0 && it.section && !groups.some((g) => g.label === it.section) && (
                        <option value={it.section}>{it.section}（旧）</option>
                      )}
                    </select>
                  </td>
                  <td style={{ padding: '6px 10px' }}>
                    <select
                      className="input"
                      value={it.parentKey || ''}
                      onChange={(e) => updateItem(idx, { parentKey: e.target.value || null })}
                    >
                      <option value="">{tl('顶层菜单')}</option>
                      {topKeys
                        .filter((p) => p.key !== it.key)
                        .map((p) => (
                          <option key={p.key} value={p.key}>
                            {p.label}
                          </option>
                        ))}
                    </select>
                  </td>
                  <td style={{ padding: '6px 10px' }}>
                    <input
                      className="input"
                      value={it.perm || ''}
                      onChange={(e) => updateItem(idx, { perm: e.target.value || undefined })}
                      placeholder={tl('权限标识')}
                      style={{ minWidth: 80 }}
                    />
                  </td>
                  <td style={{ padding: '6px 10px' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--fg-secondary)', fontSize: 12, cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={!!it.adminOnly}
                          onChange={(e) => updateItem(idx, { adminOnly: e.target.checked })}
                        />
                        仅管理员
                      </label>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--fg-secondary)', fontSize: 12, cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={!!it.disabled}
                          onChange={(e) => updateItem(idx, { disabled: e.target.checked })}
                        />
                        敬请期待
                      </label>
                    </div>
                  </td>
                  <td style={{ padding: '6px 10px', textAlign: 'center' }}>
                    <div style={{ display: 'flex', gap: 4, justifyContent: 'center' }}>
                      <button type="button" className="btn btn-sm btn-icon" title={tl('上移')} onClick={() => moveItem(idx, -1)}>
                        ↑
                      </button>
                      <button type="button" className="btn btn-sm btn-icon" title={tl('下移')} onClick={() => moveItem(idx, 1)}>
                        ↓
                      </button>
                      <button type="button" className="btn btn-sm btn-danger" title={tl('删除')} onClick={() => removeItem(idx)}>
                        ×
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button type="button" className="btn btn-outline" onClick={addItem} style={{ alignSelf: 'flex-start' }}>
          + 添加菜单项
        </button>
      </Section>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
