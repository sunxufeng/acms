'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { type NavMenuGroup, type NavMenuGroupConfig } from '@acms/contracts';
import { api } from '../../lib/api';
import { useTranslations } from 'next-intl';

export default function MenuGroupsSettingsPage() {

  const __lT = useTranslations('labels'); const tl = ((k: string, v?: any) => { const __r = __lT(k as any, v); return (__r === k || __r.startsWith('labels.')) ? k : __r; }) as any;  const [groups, setGroups] = useState<NavMenuGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2600);
  }

  useEffect(() => {
    api
      .getMenuGroups()
      .then((d) => {
        if (Array.isArray(d?.items)) setGroups(d.items);
      })
      .catch((err) => showToast(`加载失败：${err instanceof Error ? err.message : '未知错误'}`))
      .finally(() => setLoading(false));
  }, []);

  function update(idx: number, patch: Partial<NavMenuGroup>) {
    setGroups((prev) => {
      const list = prev.slice();
      list[idx] = { ...list[idx], ...patch };
      return list;
    });
  }

  function remove(idx: number) {
    if (!confirm('确定删除该菜单分组吗？该分组下的菜单项「分组」将变为旧分组（需在菜单管理中重新指定）。')) return;
    setGroups((prev) => prev.filter((_, i) => i !== idx));
  }

  function add() {
    setGroups((prev) => [
      ...prev,
      { key: `group_${Date.now()}`, label: '新分组', enLabel: '', order: (prev.length + 1) * 10 },
    ]);
  }

  function move(idx: number, dir: -1 | 1) {
    const next = idx + dir;
    if (next < 0 || next >= groups.length) return;
    setGroups((prev) => {
      const list = prev.slice();
      const tmp = list[idx];
      list[idx] = list[next];
      list[next] = tmp;
      return list;
    });
  }

  async function handleSave() {
    setSaving(true);
    try {
      // 以当前顺序重排 order，保证展示顺序
      const normalized = groups
        .map((g, i) => ({ ...g, order: (i + 1) * 10 }))
        .sort((a, b) => a.order - b.order);
      await api.updateMenuGroups({ items: normalized } as NavMenuGroupConfig);
      setGroups(normalized);
      showToast('保存成功，刷新页面后分组顺序生效');
    } catch (err) {
      showToast(`保存失败：${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div style={{ padding: 40, color: 'var(--fg-secondary)' }}>{tl('加载中…')}</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div className="page-title">{tl('菜单分组')}</div>
          <div className="page-subtitle">
            维护侧边栏菜单的分组（section）展示顺序与名称。分组 key 对应菜单项中的「分组」字段，保存后刷新页面生效。
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <Link href="/menu-settings" className="btn btn-outline">
            返回菜单管理
          </Link>
          <button type="button" className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? '保存中…' : '保存分组'}
          </button>
        </div>
      </div>

      <div
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          padding: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ color: 'var(--fg-secondary)', borderBottom: '1px solid var(--border)' }}>
                <th style={{ textAlign: 'left', padding: '8px 10px', width: 60 }}>{tl('顺序')}</th>
                <th style={{ textAlign: 'left', padding: '8px 10px', minWidth: 160 }}>{tl('分组名称')}</th>
                <th style={{ textAlign: 'left', padding: '8px 10px', minWidth: 160 }}>{tl('英文名称')}</th>
                <th style={{ textAlign: 'left', padding: '8px 10px', minWidth: 200 }}>{tl('分组标识 (key)')}</th>
                <th style={{ textAlign: 'center', padding: '8px 10px', width: 140 }}>{tl('操作')}</th>
              </tr>
            </thead>
            <tbody>
              {groups.length === 0 && (
                <tr>
                  <td colSpan={4} style={{ padding: '14px 10px', color: 'var(--fg-secondary)', textAlign: 'center' }}>
                    暂无自定义分组，点击下方「+ 添加分组」。
                  </td>
                </tr>
              )}
              {groups.map((g, idx) => (
                <tr key={g.key} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '6px 10px', color: 'var(--fg-tertiary)' }}>{idx + 1}</td>
                  <td style={{ padding: '6px 10px' }}>
                    <input
                      className="input"
                      value={g.label}
                      onChange={(e) => update(idx, { label: e.target.value })}
                      style={{ minWidth: 140 }}
                    />
                  </td>
                  <td style={{ padding: '6px 10px' }}>
                    <input
                      className="input"
                      value={g.enLabel || ''}
                      placeholder={tl('英文显示名')}
                      onChange={(e) => update(idx, { enLabel: e.target.value || undefined })}
                      style={{ minWidth: 140 }}
                    />
                  </td>
                  <td style={{ padding: '6px 10px', color: 'var(--fg-secondary)' }}>{g.key}</td>
                  <td style={{ padding: '6px 10px', textAlign: 'center' }}>
                    <div style={{ display: 'flex', gap: 4, justifyContent: 'center' }}>
                      <button type="button" className="btn btn-sm btn-icon" title={tl('上移')} onClick={() => move(idx, -1)}>
                        ↑
                      </button>
                      <button type="button" className="btn btn-sm btn-icon" title={tl('下移')} onClick={() => move(idx, 1)}>
                        ↓
                      </button>
                      <button type="button" className="btn btn-sm btn-danger" title={tl('删除')} onClick={() => remove(idx)}>
                        ×
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button type="button" className="btn btn-outline" onClick={add} style={{ alignSelf: 'flex-start' }}>
          + 添加分组
        </button>
      </div>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
