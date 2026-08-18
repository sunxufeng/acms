import { describe, expect, it } from 'vitest';
import { authorize, hasPermission, maxDataLevelOf, permissionsOf } from '../src/permission.js';
import { ROLES, PERMISSIONS, type Role } from '@acms/contracts';

const p = (...roles: string[]) => ({ roles, campuses: [] as string[] });

describe('RBAC 矩阵', () => {
  it('9 个角色 × 全部权限点无异常，矩阵可全枚举', () => {
    for (const r of ROLES) {
      const set = permissionsOf(p(r));
      expect(set.size, `${r} 应至少有一个权限`).toBeGreaterThan(0);
    }
  });

  it('系统管理员拥有全部权限', () => {
    expect(permissionsOf(p('系统管理员')).size).toBe(PERMISSIONS.length);
  });

  it('教师本人只能读学生档案与本人教学相关，不能写档案', () => {
    expect(hasPermission(p('教师本人'), 'grade:read')).toBe(true);
    expect(hasPermission(p('教师本人'), 'attendance:read')).toBe(true);
    expect(hasPermission(p('教师本人'), 'student:read')).toBe(true);
    expect(hasPermission(p('教师本人'), 'student:write')).toBe(false);
    expect(hasPermission(p('教师本人'), 'admin:user')).toBe(false);
  });

  it('招生角色权限是 院级管理 子集（院级管理具备全部业务权限）', () => {
    const sup = permissionsOf(p('院级管理'));
    const adm = permissionsOf(p('招生'));
    for (const x of adm) expect(sup.has(x), `招生不应多出 ${x}`).toBe(true);
  });

  it('财务只能读档案与导出', () => {
    expect(hasPermission(p('财务'), 'student:read')).toBe(true);
    expect(hasPermission(p('财务'), 'grade:read')).toBe(false);
    expect(hasPermission(p('财务'), 'export:run')).toBe(true);
  });

  it('多角色权限取并集', () => {
    expect(hasPermission(p('教师本人', '学生事务'), 'followup:write')).toBe(true);
    expect(hasPermission(p('教师本人'), 'followup:write')).toBe(false);
  });

  it('未知角色不授任何权限', () => {
    expect(permissionsOf(p('超管', '')).size).toBe(0);
  });
});

describe('ABAC 密级与校区', () => {
  it('角色默认密级上限：系统管理员 L4、教师本人 L2、财务 L3', () => {
    expect(maxDataLevelOf(p('系统管理员'))).toBe('L4');
    expect(maxDataLevelOf(p('教师本人'))).toBe('L2');
    expect(maxDataLevelOf(p('财务'))).toBe('L3');
  });

  it('用户级密级上限覆盖角色默认', () => {
    expect(maxDataLevelOf({ roles: ['教师本人'], campuses: [], maxDataLevel: 'L3' })).toBe('L3');
  });

  it('L3 记录对 L2 上限用户拒绝', () => {
    const d = authorize(p('教师本人'), 'grade:read', { dataLevel: 'L3' });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('data-level-exceeded');
  });

  it('校区不匹配拒绝', () => {
    const d = authorize({ roles: ['院级管理'], campuses: ['虹桥校区'] }, 'student:read', {
      campus: '浦东校区',
    });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('campus-mismatch');
  });

  it('校区为空视为不限（全校区管理员）', () => {
    expect(authorize(p('系统管理员'), 'student:read', { campus: '任意校区' }).allowed).toBe(true);
  });

  it('权限缺失优先于密级判断', () => {
    const d = authorize(p('财务'), 'student:write', { dataLevel: 'L4' });
    expect(d.reason).toBe('missing-permission');
  });

  it('多角色密级取最高（教师本人+学生事务 → L3）', () => {
    expect(maxDataLevelOf(p('教师本人', '学生事务'))).toBe('L3');
  });

  it('Base 中文密级可与引擎等级混合排名（内部≈L2）', () => {
    // 学生/教师表使用中文密级选项，authorize 应能正确比较
    expect(authorize(p('财务'), 'grade:read', { dataLevel: '内部' }).allowed).toBe(false);
    expect(authorize(p('院级管理'), 'grade:read', { dataLevel: '内部' }).allowed).toBe(true);
  });
});
