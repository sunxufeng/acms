/** 系统角色（与 Base 系统用户表「系统角色」多选字段选项完全一致） */
export const ROLES = [
  '系统管理员',
  '院级管理',
  '教务',
  '财务',
  '教师本人',
  '学生事务',
  '招生',
  'HR行政',
  '审计',
] as const;

export type Role = (typeof ROLES)[number];

/** 引擎内部数据密级等级（ABAC 排名与默认），用于与学生/教师表（内部/敏感/高度敏感）对齐 */
export const DATA_LEVELS = ['L1', 'L2', 'L3', 'L4'] as const;
export type DataLevel = (typeof DATA_LEVELS)[number];

/**
 * 数据密级排名：同时兼容两套 Base 字段词汇，
 * 避免跨表比较时因字符串不匹配而误判为最高密级。
 *  - 系统用户表「数据密级上限」：一般 / 内部 / 敏感 / 高度敏感 / L4
 *  - 学生 / 教师表「数据密级」：内部 / 敏感 / 高度敏感（及遗留 L1）
 */
export const DATA_LEVEL_RANK = {
  L1: 1,
  一般: 1,
  L2: 2,
  内部: 2,
  L3: 3,
  敏感: 3,
  L4: 4,
  高度敏感: 4,
};

/** 系统用户表「数据密级上限」可选值（与 Base 实际字段选项严格一致，写入前校验） */
export const USER_LEVEL_OPTIONS = ['一般', '内部', '敏感', '高度敏感', 'L4'] as const;

/** 系统用户表密级（Base 中文）→ 引擎等级（L1–L4），供会话解析时使用 */
export const USER_LEVEL_TO_ENGINE: Record<string, DataLevel> = {
  一般: 'L1',
  内部: 'L2',
  敏感: 'L3',
  高度敏感: 'L4',
  L4: 'L4',
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
  // AI 域（来自 acaily 迁移）：对话对所有登录用户开放；配置/自动化/管理仅系统管理员
  'ai:chat',
  'ai:config',
  'ai:automation',
  'ai:admin',
] as const;

export type Permission = (typeof PERMISSIONS)[number];
