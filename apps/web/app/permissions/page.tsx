'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { api, type PermissionsPayload } from '../../lib/api';

const DOMAIN_LABELS: Record<string, string> = {
  student: '学生',
  followup: '招生跟进',
  attendance: '考勤',
  billing: '计费',
  partnership: '聘用合作',
  finance: '财务',
  notification: '通知',
  grade: '成绩',
  activity: '实践活动',
  communication: '家校沟通',
  evaluation: '阶段评价',
  alumni: '校友跟进',
  teacher: '教师',
  course: '课程',
  venue: '场地',
  schedule: '排课',
  export: '数据导出',
  admin: '系统管理',
  config: '系统配置',
};

const DOMAIN_ORDER = [
  'student', 'followup', 'attendance', 'billing', 'partnership', 'finance',
  'notification', 'grade', 'activity', 'communication', 'evaluation', 'alumni',
  'teacher', 'course', 'venue', 'schedule', 'export', 'admin', 'config',
];

function groupPerms(perms: string[]): { domain: string; label: string; perms: string[] }[] {
  const m = new Map<string, string[]>();
  for (const p of perms) {
    const dom = p.split(':')[0];
    if (!m.has(dom)) m.set(dom, []);
    m.get(dom)!.push(p);
  }
  return DOMAIN_ORDER.filter((d) => m.has(d)).map((d) => ({ domain: d, label: DOMAIN_LABELS[d] ?? d, perms: m.get(d)! }));
}

export default function PermissionsPage() {
  const [data, setData] = useState<PermissionsPayload | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getPermissions()
      .then((d) => setData(d))
      .catch((e) => setError(e instanceof Error ? e.message : '加载失败'))
      .finally(() => setLoading(false));
  }, []);

  const groups = useMemo(() => (data ? groupPerms(data.permissions) : []), [data]);
  const myGroups = useMemo(
    () => (data ? groupPerms(data.myPermissions) : []),
    [data],
  );

  if (loading) return <div className="page"><div className="empty-state"><div className="empty-state-text">加载中…</div></div></div>;
  if (error) return <div className="page"><p className="msg-error">{error}</p></div>;
  if (!data) return null;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">权限与授权</h1>
          <p className="page-subtitle">查看系统权限模型（角色 → 权限矩阵）与当前账号的有效权限。系统权限由角色授予，给用户分配角色即可完成授权。</p>
        </div>
        <Link href="/users" className="btn btn-outline">前往用户管理</Link>
      </div>

      {/* 我的权限 */}
      <section className="form-fieldset" style={{ marginBottom: 'var(--space-lg)' }}>
        <legend className="form-legend">我的权限</legend>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>我的角色</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
              {(data.myRoles.length ? data.myRoles : ['（无）']).map((r) => (
                <span key={r} className="tag tag-accent">{r}</span>
              ))}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>数据密级上限</div>
            <div style={{ fontSize: 'var(--font-lg)', fontWeight: 700, marginTop: 4 }}>{data.myMaxDataLevel}</div>
          </div>
          <div>
            <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>有效权限点</div>
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
        <legend className="form-legend">角色权限矩阵（系统权限基线）</legend>
        <p style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-tertiary)', marginTop: 0, marginBottom: 12 }}>
          每一行是一项功能权限，✓ 表示该角色被授予此项权限。角色权限由系统代码维护，通过「用户管理」为用户分配角色来授权。
        </p>
        <div className="data-table-wrap" style={{ overflowX: 'auto' }}>
          <table className="data-table" style={{ minWidth: 900 }}>
            <thead>
              <tr>
                <th style={{ position: 'sticky', left: 0, background: 'var(--bg-elevated)', minWidth: 180 }}>权限 \ 角色</th>
                {data.roles.map((r) => (
                  <th key={r} style={{ textAlign: 'center', minWidth: 84 }}>{r}</th>
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
