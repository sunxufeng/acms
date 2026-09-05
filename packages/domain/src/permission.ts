import {
  DATA_LEVEL_RANK,
  type DataLevel,
  type Permission,
  type Role,
} from '@acms/contracts';

/**
 * RBAC：角色 → 权限点。键为 Base 系统用户表「系统角色」实际选项（与 ROLES 一致）。
 * 导出供权限矩阵 UI / 接口使用。admin:user 仅授予系统管理员，避免普通管理员互删。
 */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
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
    'export:run', 'admin:user', 'admin:studentUser', 'admin:audit', 'config:read', 'config:write',
    // AI 域
    'ai:chat', 'ai:config', 'ai:automation', 'ai:admin',
    // 邮件自动归档
    'mail:read', 'mail:write',
    // 得到大脑（Get笔记）知识库
    'getnote:read', 'getnote:write',
  ],
  院级管理: [
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
    'export:run', 'admin:audit', 'config:read', 'config:write',
    'ai:chat',
    // 邮件自动归档（院级管理可配置账户并查看归档）
    'mail:read', 'mail:write',
    // 得到大脑（Get笔记）知识库
    'getnote:read', 'getnote:write',
  ],
  教务: [
    'student:read', 'student:write', 'student:archive',
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
    'export:run', 'config:read', 'config:write',
    'ai:chat',
    // 邮件自动归档：教务可查看归档
    'mail:read',
    // 得到大脑（Get笔记）知识库
    'getnote:read', 'getnote:write',
  ],
  财务: [
    'student:read', 'export:run',
    'billing:read', 'billing:write', 'billing:confirm', 'billing:settle',
    'partnership:read', 'partnership:write',
    'finance:read', 'finance:approve',
    'notification:read',
    'ai:chat',
  ],
  教师本人: [
    'student:read',
    'attendance:read', 'attendance:write',
    'grade:read', 'grade:write',
    'activity:read', 'activity:write',
    'evaluation:read', 'evaluation:write',
    'ai:chat',
    // 得到大脑（Get笔记）知识库
    'getnote:read', 'getnote:write',
  ],
  学生事务: [
    'student:read',
    'followup:read', 'followup:write',
    'attendance:read', 'attendance:write',
    'grade:read',
    'activity:read',
    'communication:read', 'communication:write',
    'evaluation:read', 'evaluation:write',
    'ai:chat',
    // 邮件自动归档：学生事务可查看归档
    'mail:read',
    // 得到大脑（Get笔记）知识库
    'getnote:read', 'getnote:write',
  ],
  招生: [
    'student:read', 'student:write', 'followup:read', 'followup:write',
    'ai:chat',
    // 招生人员：配置本人邮箱账户并查看归档
    'mail:read', 'mail:write',
    // 得到大脑（Get笔记）知识库
    'getnote:read', 'getnote:write',
  ],
  HR行政: [
    'student:read',
    'teacher:read', 'teacher:write', 'teacher:archive',
    'course:read', 'course:write',
    'venue:read', 'venue:write',
    'schedule:read', 'schedule:write',
    'notification:read', 'notification:write', 'notification:send',
    'alumni:read', 'alumni:write',
    'config:read', 'config:write',
    'ai:chat',
    // 得到大脑（Get笔记）：只读
    'getnote:read',
  ],
  审计: [
    'student:read', 'followup:read', 'attendance:read', 'billing:read',
    'partnership:read', 'finance:read', 'notification:read',
    'grade:read', 'activity:read', 'communication:read', 'evaluation:read',
    'alumni:read', 'teacher:read',
    'course:read', 'venue:read', 'schedule:read',
    'export:run', 'admin:audit', 'config:read',
    'ai:chat',
    // 得到大脑（Get笔记）：只读
    'getnote:read',
  ],
  // 微信小程序学生端：仅本人数据（门户只读 + 打卡写）。不授予 student:write/archive，
  // 避免越权修改其他学生档案；打卡写仅校验 attendance:write。
  student: [
    'student:read',
    'attendance:read', 'attendance:write',
  ],
  // 家长 H5：仅可查看所绑定子女的考勤/档案摘要，并提交通知反馈（反馈写由专用端点处理，不需 communication:write）。
  parent: [
    'student:read',
    'attendance:read',
  ],
};

/** 角色 → 默认数据密级上限（引擎等级 L1–L4） */
export const ROLE_MAX_LEVEL: Record<Role, DataLevel> = {
  系统管理员: 'L4',
  院级管理: 'L4',
  教务: 'L3',
  财务: 'L3',
  教师本人: 'L2',
  学生事务: 'L3',
  招生: 'L2',
  HR行政: 'L3',
  审计: 'L4',
  student: 'L1',
  parent: 'L1',
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

/**
 * 运行时可覆盖的角色权限矩阵。默认回退到硬编码 ROLE_PERMISSIONS / ROLE_MAX_LEVEL；
 * 一旦通过 loadRolePermissionConfig 加载了系统配置（角色管理功能持久化的值），
 * 引擎即以配置为唯一事实来源（config 中不存在的角色不再授予任何权限）。
 */
let effectiveRolePermissions: Record<string, Permission[]> | null = null;
let effectiveMaxLevel: Record<string, DataLevel> | null = null;

export interface RolePermissionSeed {
  key: string;
  permissions: Permission[];
  maxDataLevel: DataLevel;
}

/** 用系统配置覆盖角色权限矩阵（角色管理保存 / 应用启动时调用） */
export function loadRolePermissionConfig(roles: RolePermissionSeed[]): void {
  const pm: Record<string, Permission[]> = {};
  const ml: Record<string, DataLevel> = {};
  for (const r of roles) {
    pm[r.key] = [...r.permissions];
    ml[r.key] = r.maxDataLevel;
  }
  effectiveRolePermissions = pm;
  effectiveMaxLevel = ml;
}

function permsForRole(role: string): Permission[] {
  if (effectiveRolePermissions) return effectiveRolePermissions[role] ?? [];
  if (role in ROLE_PERMISSIONS) return [...ROLE_PERMISSIONS[role as Role]];
  return [];
}

function levelForRole(role: string): DataLevel {
  if (effectiveMaxLevel) return effectiveMaxLevel[role] ?? 'L1';
  if (role in ROLE_MAX_LEVEL) return ROLE_MAX_LEVEL[role as Role];
  return 'L1';
}

/** 有效角色 → 权限矩阵（已加载配置则按配置，否则按硬编码默认） */
export function getRolePermissionMatrix(): Record<string, Permission[]> {
  const out: Record<string, Permission[]> = {};
  const keys = new Set<string>([
    ...Object.keys(ROLE_PERMISSIONS),
    ...(effectiveRolePermissions ? Object.keys(effectiveRolePermissions) : []),
  ]);
  for (const k of keys) out[k] = permsForRole(k);
  return out;
}

/** 有效角色清单（含配置中新增的自定义角色） */
export function getRoleList(): string[] {
  return Object.keys(getRolePermissionMatrix());
}

/** 多角色取并集 */
export function permissionsOf(principal: Principal): Set<Permission> {
  const set = new Set<Permission>();
  for (const r of principal.roles) {
    for (const p of permsForRole(r)) set.add(p);
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
    const l = levelForRole(r);
    if (DATA_LEVEL_RANK[l] > DATA_LEVEL_RANK[best]) best = l;
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
  // 组织级角色（系统/院级管理）视角不受单校区限制，可看全组织数据
  const isOrgWide = principal.roles.some((r) => r === '系统管理员' || r === '院级管理');
  if (!isOrgWide && resource?.campus) {
    // 校区可能是多选字段（数组），统一按集合交集判断
    const resCampuses = Array.isArray(resource.campus) ? resource.campus : [resource.campus];
    if (
      principal.campuses.length > 0 &&
      !resCampuses.some((c) => principal.campuses.includes(c))
    ) {
      return { allowed: false, reason: 'campus-mismatch' };
    }
  }
  if (resource?.dataLevel) {
    const limit = maxDataLevelOf(principal);
    const levels = Array.isArray(resource.dataLevel) ? resource.dataLevel : [resource.dataLevel];
    const need = Math.max(
      ...levels.map((l) => DATA_LEVEL_RANK[l in DATA_LEVEL_RANK ? (l as DataLevel) : 'L4']),
    );
    if (need > DATA_LEVEL_RANK[limit]) {
      return { allowed: false, reason: 'data-level-exceeded' };
    }
  }
  return { allowed: true };
}
