/** 系统角色（与 Base 用户表「系统角色」多选字段对齐） */
export const ROLES = [
  '系统管理员',
  '校区管理员',
  '教务管理员',
  '财务',
  '教师',
  '班主任',
  '招生顾问',
  '学生',
  '家长',
] as const;

export type Role = (typeof ROLES)[number];

/** 数据密级：L1 公开 → L4 高敏 */
export const DATA_LEVELS = ['L1', 'L2', 'L3', 'L4'] as const;
export type DataLevel = (typeof DATA_LEVELS)[number];

export const DATA_LEVEL_RANK: Record<DataLevel, number> = {
  L1: 1,
  L2: 2,
  L3: 3,
  L4: 4,
};

/** 功能权限点 */
export const PERMISSIONS = [
  'student:read',
  'student:write',
  'student:archive',
  'followup:read',
  'followup:write',
  'attendance:read',
  'attendance:write',
  'attendance:approve',
  'billing:read',
  'billing:write',
  'billing:confirm',
  'billing:settle',
  'partnership:read',
  'partnership:write',
  'finance:read',
  'finance:approve',
  'notification:read',
  'notification:write',
  'notification:send',
  'grade:read',
  'grade:write',
  'activity:read',
  'activity:write',
  'communication:read',
  'communication:write',
  'evaluation:read',
  'evaluation:write',
  'alumni:read',
  'alumni:write',
  'teacher:read',
  'teacher:write',
  'teacher:archive',
  'course:read',
  'course:write',
  'venue:read',
  'venue:write',
  'schedule:read',
  'schedule:write',
  'export:run',
  'admin:user',
  'admin:audit',
  'config:read',
  'config:write',
] as const;

export type Permission = (typeof PERMISSIONS)[number];
