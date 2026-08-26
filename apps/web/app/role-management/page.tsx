'use client';

import { useEffect, useMemo, useState } from 'react';
import { api, type RoleManagementPayload } from '../../lib/api';
import { DOMAIN_LABELS, PERMISSION_LABELS, type Permission, type DataLevel, type RoleDef } from '@acms/contracts';

const DOMAIN_ORDER = [
  'student', 'followup', 'attendance', 'billing', 'partnership', 'finance',
  'notification', 'grade', 'activity', 'communication', 'evaluation', 'alumni',
  'teacher', 'course', 'venue', 'schedule', 'export', 'admin', 'config', 'ai',
];

const LEVEL_LABELS: Record<string, string> = {
  L1: 'L1（一般）',
  L2: 'L2（内部）',
  L3: 'L3（敏感）',
  L4: 'L4（高度敏感）',
};

function groupPerms(perms: string[]): { domain: string; label: string; perms: string[] }[] {
  const m = new Map<string, string[]>();
  for (const p of perms) {
    const dom = p.split(':')[0];
    if (!m.has(dom)) m.set(dom, []);
    m.get(dom)!.push(p);
  }
  return DOMAIN_ORDER.filter((d) => m.has(d)).map((d) => ({
    domain: d,
    label: DOMAIN_LABELS[d] ?? d,
    perms: m.get(d)!,
  }));
}

interface Draft {
  key: string;
  label: string;
  permissions: string[];
  maxDataLevel: string;
  protected?: boolean;
  lockedPermissions?: boolean;
  isNew?: boolean;
}

export default function RoleManagementPage() {
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

  async function load() {
    setLoading(true);
    setError('');
    try {
      const d = await api.getRoleManagement();
      setConfig(d);
      if (!selectedKey && d.roles.length) {
        selectRole(d.roles[0]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
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
      protected: r.protected,
      lockedPermissions: r.lockedPermissions,
      isNew: false,
    });
    setMsg(null);
  }

  const groups = useMemo(
    () => (draft ? groupPerms(config?.allPermissions ?? []) : []),
    [draft, config],
  );

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
      const payload = draft.isNew
        ? await api.createRole({
            key: draft.key,
            label: draft.label,
            permissions: draft.permissions,
            maxDataLevel: draft.maxDataLevel,
          })
        : await api.updateRole(draft.key, {
            label: draft.label,
            permissions: draft.permissions,
            maxDataLevel: draft.maxDataLevel,
          });
      setConfig(payload);
      setShowCreate(false);
      setNewKey('');
      setNewLabel('');
      const saved = payload.roles.find((r) => r.key === draft.key);
      if (saved) selectRole(saved);
      setMsg({ type: 'ok', text: draft.isNew ? '角色已创建' : '已保存' });
    } catch (e) {
      setMsg({ type: 'err', text: e instanceof Error ? e.message : '保存失败' });
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!draft || draft.protected) return;
    if (!confirm(`确定删除角色「${draft.label}」？删除后该角色不再授予任何权限。`)) return;
    setSaving(true);
    setMsg(null);
    try {
      await api.deleteRole(draft.key);
      const d = await api.getRoleManagement();
      setConfig(d);
      setSelectedKey(null);
      setDraft(null);
      setMsg({ type: 'ok', text: '角色已删除' });
    } catch (e) {
      setMsg({ type: 'err', text: e instanceof Error ? e.message : '删除失败' });
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
      setMsg({ type: 'err', text: '请填写角色标识' });
      return;
    }
    if (config?.roles.some((r) => r.key === key)) {
      setMsg({ type: 'err', text: '角色标识已存在' });
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

  if (loading) return <div className="page"><div className="empty-state"><div className="empty-state-text">加载中…</div></div></div>;
  if (error) return <div className="page"><p className="msg-error">{error}</p></div>;
  if (!config) return null;

  const dirty =
    draft &&
    (() => {
      const orig = config.roles.find((r) => r.key === draft.key);
      if (draft.isNew) return true;
      if (!orig) return true;
      return (
        orig.label !== draft.label ||
        orig.maxDataLevel !== draft.maxDataLevel ||
        orig.permissions.length !== draft.permissions.length ||
        orig.permissions.some((p) => !draft.permissions.includes(p)) ||
        draft.permissions.some((p) => !(orig.permissions as string[]).includes(p))
      );
    })();

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">角色管理</h1>
          <p className="page-subtitle">
            管理系统的角色，以及每个角色被授予的具体权限。修改会即时生效并热更新鉴权引擎。
            「系统管理员」权限集锁定不可改，内置角色不可删除。
          </p>
        </div>
        <button className="btn btn-primary" onClick={startCreate} disabled={saving}>
          + 新建角色
        </button>
      </div>

      {msg && (
        <div className={msg.type === 'ok' ? 'msg-ok' : 'msg-error'} style={{ marginBottom: 'var(--space-md)' }}>
          {msg.text}
        </div>
      )}

      {showCreate && (
        <section className="form-fieldset" style={{ marginBottom: 'var(--space-lg)' }}>
          <legend className="form-legend">新建角色</legend>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div className="form-field" style={{ minWidth: 200 }}>
              <label className="form-label">角色标识（key）</label>
              <input
                className="input"
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
                placeholder="如 班主任 / ClassTeacher"
              />
            </div>
            <div className="form-field" style={{ minWidth: 200 }}>
              <label className="form-label">展示名</label>
              <input
                className="input"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="留空则等同标识"
              />
            </div>
            <button className="btn btn-primary" onClick={confirmCreate}>下一步</button>
            <button className="btn btn-outline" onClick={() => setShowCreate(false)}>取消</button>
          </div>
          <p style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)', marginTop: 8 }}>
            提示：新建角色默认无任何权限，请在右侧勾选后保存；角色标识需与飞书「系统用户表-系统角色」字段选项一致才能分配给用户。
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
                {r.protected && <span className="tag tag-muted" style={{ fontSize: 'var(--font-xs)' }}>内置</span>}
              </button>
            ))}
          </div>
        </aside>

        {/* 编辑器 */}
        <section className="card" style={{ padding: 'var(--space-lg)' }}>
          {!draft ? (
            <div className="empty-state"><div className="empty-state-text">请选择左侧角色进行编辑</div></div>
          ) : (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 'var(--space-md)' }}>
                <div>
                  <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>角色标识</div>
                  <div style={{ fontWeight: 700 }}>{draft.key}</div>
                </div>
                {draft.protected && (
                  <span className="tag tag-muted">内置角色（不可删除）</span>
                )}
                {draft.lockedPermissions && (
                  <span className="tag tag-muted">权限集锁定</span>
                )}
              </div>

              <div style={{ display: 'flex', gap: 'var(--space-lg)', flexWrap: 'wrap', marginBottom: 'var(--space-lg)' }}>
                <div className="form-field" style={{ minWidth: 220 }}>
                  <label className="form-label">展示名</label>
                  <input
                    className="input"
                    value={draft.label}
                    onChange={(e) => setDraft((p) => (p ? { ...p, label: e.target.value } : p))}
                    disabled={saving}
                  />
                </div>
                <div className="form-field" style={{ minWidth: 220 }}>
                  <label className="form-label">数据密级上限</label>
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
                  <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>已授予权限点</div>
                  <div style={{ fontSize: 'var(--font-lg)', fontWeight: 700 }}>{draft.permissions.length}</div>
                </div>
              </div>

              <div className="form-legend" style={{ marginBottom: 10 }}>权限分配（按业务域分组）</div>
              {draft.lockedPermissions && (
                <p style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-tertiary)', marginTop: 0, marginBottom: 12 }}>
                  系统管理员拥有全部权限，此处为只读展示。
                </p>
              )}
              <div className="data-table-wrap" style={{ maxHeight: '52vh', overflowY: 'auto' }}>
                <table className="data-table">
                  <tbody>
                    {groups.map((g) => {
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

              <div style={{ display: 'flex', gap: 12, marginTop: 'var(--space-lg)' }}>
                <button className="btn btn-primary" onClick={handleSave} disabled={saving || !dirty}>
                  {saving ? '保存中…' : draft.isNew ? '创建角色' : '保存'}
                </button>
                {!draft.protected && (
                  <button className="btn btn-danger" onClick={handleDelete} disabled={saving}>
                    删除角色
                  </button>
                )}
                {dirty && <span className="tag tag-accent">有未保存修改</span>}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
