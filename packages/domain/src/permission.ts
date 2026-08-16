import {
  DATA_LEVEL_RANK,
  type DataLevel,
  type Permission,
  type Role,
} from '@acms/contracts';

/** RBAC：角色 → 权限点（M0 基线，后续按 BR 业务规则细化） */
const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
    系统管理员: [
    'student:read', 'student:write', 'student:archive',
    'followup:read', 'followup:write',
    'attendance:read', 'attendance:write', 'attendance:approve',
    'billing:read', 'billing:write', 'billing:confirm', 'billing:settle',
    'partnership:read', 'partnership:write',
    'finance:read', 'finance:approve',
    'notification:read', 'notification:write', 'notification:send',
    'grade:read', 'grade:write',
    'activity:read', 'activity:write',
    'communication:read', 'communication:write',
    'evaluation:read', 'evaluation:write',
    'alumni:read', 'alumni:write',
    'teacher:read', 'teacher:write', 'teacher:archive',
    'course:read', 'course:write',
    'venue:read', 'venue:write',
    'schedule:read', 'schedule:write',
    'export:run', 'admin:user', 'admin:audit',
  ],
  校区管理员: [
    'student:read', 'student:write', 'student:archive',
    'followup:read', 'followup:write',
    'attendance:read', 'attendance:write', 'attendance:approve',
    'billing:read', 'billing:write', 'billing:confirm',
    'partnership:read', 'partnership:write',
    'finance:read', 'finance:approve',
    'notification:read', 'notification:write', 'notification:send',
    'grade:read', 'grade:write',
    'activity:read', 'activity:write',
    'communication:read', 'communication:write',
    'evaluation:read', 'evaluation:write',
    'alumni:read', 'alumni:write',
    'teacher:read', 'teacher:write', 'teacher:archive',
    'course:read', 'course:write',
    'venue:read', 'venue:write',
    'schedule:read', 'schedule:write',
    'export:run', 'admin:audit',
  ],
  教务管理员: [
    'student:read',
    'attendance:read', 'attendance:write', 'attendance:approve',
    'billing:read', 'billing:write', 'billing:confirm',
    'notification:read', 'notification:write', 'notification:send',
    'grade:read', 'grade:write',
    'activity:read', 'activity:write',
    'evaluation:read', 'evaluation:write',
    'teacher:read', 'teacher:write',
    'course:read', 'course:write',
    'venue:read', 'venue:write',
    'schedule:read', 'schedule:write',
    'export:run',
  ],
  财务: ['student:read', 'export:run', 'billing:read', 'billing:write', 'billing:confirm', 'billing:settle', 'partnership:read', 'partnership:write', 'finance:read', 'finance:approve', 'notification:read'],
  教师: [
    'student:read',
    'attendance:read', 'attendance:write',
    'grade:read', 'grade:write',
    'activity:read', 'activity:write',
    'evaluation:read', 'evaluation:write',
  ],
  班主任: [
    'student:read',
    'followup:read', 'followup:write',
    'attendance:read', 'attendance:write',
    'grade:read',
    'activity:read',
    'communication:read', 'communication:write',
    'evaluation:read', 'evaluation:write',
  ],
  招生顾问: ['student:read', 'student:write', 'followup:read', 'followup:write'],
  学生: ['grade:read', 'attendance:read', 'activity:read', 'evaluation:read'],
  家长: ['grade:read', 'attendance:read', 'activity:read'],
};

/** 角色 → 默认数据密级上限 */
const ROLE_MAX_LEVEL: Record<Role, DataLevel> = {
  系统管理员: 'L4',
  校区管理员: 'L4',
  教务管理员: 'L3',
  财务: 'L3',
  教师: 'L2',
  班主任: 'L3',
  招生顾问: 'L2',
  学生: 'L2',
  家长: 'L2',
};

export interface Principal {
  roles: readonly string[];
  campuses: readonly string[];
  /** 用户级密级上限（来自用户表「数据密级上限」字段），缺省取角色最小上限 */
  maxDataLevel?: string;
}

export interface ResourceScope {
  campus?: string;
  dataLevel?: string;
}

function isRole(v: string): v is Role {
  return Object.prototype.hasOwnProperty.call(ROLE_PERMISSIONS, v);
}

/** 多角色取并集 */
export function permissionsOf(principal: Principal): Set<Permission> {
  const set = new Set<Permission>();
  for (const r of principal.roles) {
    if (isRole(r)) for (const p of ROLE_PERMISSIONS[r]) set.add(p);
  }
  return set;
}

export function hasPermission(principal: Principal, permission: Permission): boolean {
  return permissionsOf(principal).has(permission);
}

/** 多角色密级上限取最高 */
export function maxDataLevelOf(principal: Principal): DataLevel {
  if (principal.maxDataLevel && principal.maxDataLevel in DATA_LEVEL_RANK) {
    return principal.maxDataLevel as DataLevel;
  }
  let best: DataLevel = 'L1';
  for (const r of principal.roles) {
    if (isRole(r) && DATA_LEVEL_RANK[ROLE_MAX_LEVEL[r]] > DATA_LEVEL_RANK[best]) {
      best = ROLE_MAX_LEVEL[r];
    }
  }
  return best;
}

export interface AuthzDecision {
  allowed: boolean;
  reason?: 'missing-permission' | 'campus-mismatch' | 'data-level-exceeded';
}

/** ABAC：权限点 + 校区 + 密级 三重检查（路由级调用入口） */
export function authorize(
  principal: Principal,
  permission: Permission,
  resource?: ResourceScope,
): AuthzDecision {
  if (!hasPermission(principal, permission)) {
    return { allowed: false, reason: 'missing-permission' };
  }
  if (resource?.campus && principal.campuses.length > 0 && !principal.campuses.includes(resource.campus)) {
    return { allowed: false, reason: 'campus-mismatch' };
  }
  if (resource?.dataLevel) {
    const limit = maxDataLevelOf(principal);
    const lvl = resource.dataLevel;
    const need = (lvl in DATA_LEVEL_RANK ? lvl : 'L4') as DataLevel;
    if (DATA_LEVEL_RANK[need] > DATA_LEVEL_RANK[limit]) {
      return { allowed: false, reason: 'data-level-exceeded' };
    }
  }
  return { allowed: true };
}
