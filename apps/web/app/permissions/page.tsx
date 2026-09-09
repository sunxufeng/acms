'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { groupPermissions } from '@acms/contracts';
import { api, type PermissionsPayload } from '../../lib/api';
import { useTl } from '../../lib/useTl';
import { useRoleLabels } from '../../components/RoleLabels';

export default function PermissionsPage() {

  const tl = useTl();
  const { labelOf } = useRoleLabels();
  const [data, setData] = useState<PermissionsPayload | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getPermissions()
      .then((d) => setData(d))
      .catch((e) => setError(e instanceof Error ? e.message : '加载失败'))
      .finally(() => setLoading(false));
  }, []);

  const groups = useMemo(() => (data ? groupPermissions(data.permissions) : []), [data]);
  const myGroups = useMemo(
    () => (data ? groupPermissions(data.myPermissions) : []),
    [data],
  );

  if (loading) return <div className="page"><div className="empty-state"><div className="empty-state-text">{tl('加载中…')}</div></div></div>;
  if (error) return <div className="page"><p className="msg-error">{error}</p></div>;
  if (!data) return null;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">{tl('权限授权')}</h1>
          <p className="page-subtitle">{tl('查看系统权限模型（角色 → 权限矩阵）与当前账号的有效权限。系统权限由角色授予，给用户分配角色即可完成授权。')}</p>
        </div>
        <Link href="/users" className="btn btn-outline">{tl('前往用户管理')}</Link>
        <Link href="/role-management" className="btn btn-primary">{tl('前往角色管理')}</Link>
      </div>

      {/* 我的权限 */}
      <section className="form-fieldset" style={{ marginBottom: 'var(--space-lg)' }}>
        <legend className="form-legend">{tl('我的权限')}</legend>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>{tl('我的角色')}</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
              {(data.myRoles.length ? data.myRoles : ['（无）']).map((r) => (
                <span key={r} className="tag tag-accent">{labelOf(r)}</span>
              ))}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>{tl('数据密级上限')}</div>
            <div style={{ fontSize: 'var(--font-lg)', fontWeight: 700, marginTop: 4 }}>{data.myMaxDataLevel}</div>
          </div>
          <div>
            <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>{tl('有效权限点')}</div>
            <div style={{ fontSize: 'var(--font-lg)', fontWeight: 700, marginTop: 4 }}>{data.myPermissions.length} 个</div>
          </div>
        </div>
        {myGroups.map((g) => (
          <div key={g.domain} style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-secondary)', marginBottom: 6 }}>{g.label}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {g.perms.map((p) => <span key={p} className="tag">{p}</span>)}
            </div>
          </div>
        ))}
      </section>

      {/* 角色权限矩阵 */}
      <section className="form-fieldset">
        <legend className="form-legend">{tl('角色权限矩阵（系统权限基线）')}</legend>
        <p style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-tertiary)', marginTop: 0, marginBottom: 12 }}>
          每一行是一项功能权限，✓ 表示该角色被授予此项权限。角色权限由系统代码维护，通过「用户管理」为用户分配角色来授权。
        </p>
        <div className="data-table-wrap" style={{ overflowX: 'auto' }}>
          <table className="data-table" style={{ minWidth: 900 }}>
            <thead>
              <tr>
                <th style={{ position: 'sticky', left: 0, background: 'var(--bg-elevated)', minWidth: 180 }}>{tl('权限 \ 角色')}</th>
                {data.roles.map((r) => (
                  <th key={r} style={{ textAlign: 'center', minWidth: 84 }}>{labelOf(r)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <GroupRows key={g.domain} group={g} roles={data.roles} matrix={data.matrix} />
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function GroupRows({
  group,
  roles,
  matrix,
}: {
  group: { domain: string; label: string; perms: string[] };
  roles: string[];
  matrix: Record<string, string[]>;
}) {
  return (
    <>
      <tr>
        <td colSpan={roles.length + 1} className="matrix-group">{group.label}</td>
      </tr>
      {group.perms.map((perm) => (
        <tr key={perm}>
          <td style={{ position: 'sticky', left: 0, background: 'var(--bg-elevated)' }}>{perm}</td>
          {roles.map((r) => {
            const has = (matrix[r] ?? []).includes(perm);
            return (
              <td key={r} style={{ textAlign: 'center' }}>
                {has ? <span className="matrix-on">✓</span> : <span className="matrix-off">–</span>}
              </td>
            );
          })}
        </tr>
      ))}
    </>
  );
}
