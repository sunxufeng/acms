'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { DEFAULT_NAV_MENU_CONFIG, type NavMenuConfig, type NavMenuItem } from '@acms/contracts';
import { api } from '../../lib/api';

const ICON_NAMES = [
  'dashboard',
  'students',
  'admissions',
  'courses',
  'schedule',
  'teachers',
  'notifications',
  'chat',
  'config',
  'bot',
  'skill',
  'clock',
  'chart',
  'billing',
  'audit',
  'system',
  'integration',
  'userGroup',
  'shield',
  'dictionary',
  'reports',
  'settings',
];

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
    href: '/',
    icon: 'settings',
    section: '后台管理',
    parentKey: null,
    order: 100,
    adminOnly: false,
    disabled: false,
  };
}

export default function MenuSettingsPage() {
  const [items, setItems] = useState<NavMenuItem[]>(DEFAULT_NAV_MENU_CONFIG.items);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    api
      .getMenuConfig()
      .then((d) => {
        if (Array.isArray(d?.items)) {
          setItems(d.items);
        }
      })
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
    if (!confirm('确定删除该菜单项吗？')) return;
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

  async function handleSave() {
    setSaving(true);
    try {
      // 自动同步 order 为当前顺序
      const normalized = items.map((it, i) => ({ ...it, order: (i + 1) * 10 }));
      await api.updateMenuConfig({ items: normalized });
      setItems(normalized);
      setToast('保存成功，刷新页面后菜单生效');
      setTimeout(() => setToast(null), 2500);
    } catch (err) {
      setToast(`保存失败：${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setSaving(false);
    }
  }

  function handleReset() {
    if (confirm('确定恢复为默认菜单吗？未保存的修改将丢失。')) {
      setItems(DEFAULT_NAV_MENU_CONFIG.items);
    }
  }

  if (loading) {
    return <div style={{ padding: 40, color: 'var(--fg-secondary)' }}>加载中…</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div className="page-title">菜单管理</div>
          <div className="page-subtitle">编辑导航菜单的分组、上下级关系、名称、图标与权限，保存后刷新页面生效。</div>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <Link href="/homepage-settings" className="btn btn-outline">
            返回首页管理
          </Link>
          <button type="button" className="btn btn-outline" onClick={handleReset}>
            恢复默认
          </button>
          <button type="button" className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? '保存中…' : '保存菜单'}
          </button>
        </div>
      </div>

      <Section title="菜单项列表">
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ color: 'var(--fg-secondary)', borderBottom: '1px solid var(--border)' }}>
                <th style={{ textAlign: 'left', padding: '8px 10px', width: 40 }}>#</th>
                <th style={{ textAlign: 'left', padding: '8px 10px', minWidth: 120 }}>名称</th>
                <th style={{ textAlign: 'left', padding: '8px 10px', minWidth: 120 }}>路径 (href)</th>
                <th style={{ textAlign: 'left', padding: '8px 10px', minWidth: 100 }}>图标</th>
                <th style={{ textAlign: 'left', padding: '8px 10px', minWidth: 100 }}>分组</th>
                <th style={{ textAlign: 'left', padding: '8px 10px', minWidth: 120 }}>父级菜单</th>
                <th style={{ textAlign: 'left', padding: '8px 10px', minWidth: 80 }}>权限</th>
                <th style={{ textAlign: 'center', padding: '8px 10px', width: 120 }}>选项</th>
                <th style={{ textAlign: 'center', padding: '8px 10px', width: 100 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, idx) => (
                <tr key={it.key} style={{ borderBottom: '1px solid var(--border)' }}>
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
                      value={it.href}
                      onChange={(e) => updateItem(idx, { href: e.target.value })}
                      style={{ minWidth: 100 }}
                    />
                  </td>
                  <td style={{ padding: '6px 10px' }}>
                    <select
                      className="input"
                      value={it.icon}
                      onChange={(e) => updateItem(idx, { icon: e.target.value })}
                    >
                      {ICON_NAMES.map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td style={{ padding: '6px 10px' }}>
                    <input
                      className="input"
                      value={it.section || ''}
                      onChange={(e) => updateItem(idx, { section: e.target.value || null })}
                      placeholder="分组"
                      style={{ minWidth: 80 }}
                    />
                  </td>
                  <td style={{ padding: '6px 10px' }}>
                    <select
                      className="input"
                      value={it.parentKey || ''}
                      onChange={(e) => updateItem(idx, { parentKey: e.target.value || null })}
                    >
                      <option value="">顶层菜单</option>
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
                      placeholder="权限标识"
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
                      <button type="button" className="btn btn-sm btn-icon" title="上移" onClick={() => moveItem(idx, -1)}>
                        ↑
                      </button>
                      <button type="button" className="btn btn-sm btn-icon" title="下移" onClick={() => moveItem(idx, 1)}>
                        ↓
                      </button>
                      <button type="button" className="btn btn-sm btn-danger" title="删除" onClick={() => removeItem(idx)}>
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
