/** 系统角色（与 Base 系统用户表「系统角色」多选字段选项完全一致）。
 *  注：student / parent 为外部用户（微信小程序 / 家长 H5）角色，不出现在飞书系统用户表，
 *  仅由后端在签发会话时写入。 */
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
  'student',
  'parent',
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
  'admin:studentUser',
  'admin:audit',
  'config:read',
  'config:write',
  // AI 域（来自 acaily 迁移）：对话对所有登录用户开放；配置/自动化/管理仅系统管理员
  'ai:chat',
  'ai:config',
  'ai:automation',
  'ai:admin',
  // 邮件自动归档（招生与国外学校沟通留存）
  'mail:read',
  'mail:write',
  // 得到大脑（Get笔记）知识库：全局单账号，鉴权只控制「能不能用」，不隔离数据
  'getnote:read',
  'getnote:write',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** 系统配置表「配置键」：角色权限矩阵 */
export const ROLE_PERMISSION_CONFIG_KEY = 'role_permission_config';

/** 权限域中文标签（用于权限矩阵分组展示） */
export const DOMAIN_LABELS: Record<string, string> = {
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
  ai: 'AI 助手',
  mail: '邮件归档',
  getnote: '知识库',
};

const ACTION_LABELS: Record<string, string> = {
  read: '查看',
  write: '编辑',
  archive: '归档',
  approve: '审批',
  confirm: '确认',
  settle: '结算',
  send: '发送',
  run: '执行',
};

const PERMISSION_LABEL_OVERRIDES: Record<string, string> = {
  'admin:user': '用户管理',
  'admin:studentUser': '学生账号',
  'admin:audit': '审计查看',
  'config:read': '配置查看',
  'config:write': '配置编辑',
  'ai:chat': 'AI 对话',
  'ai:config': 'AI 配置',
  'ai:automation': 'AI 自动化',
  'ai:admin': 'AI 管理',
};

/** 权限点 → 中文展示名 */
export const PERMISSION_LABELS: Record<Permission, string> = PERMISSIONS.reduce(
  (acc, p) => {
    if (PERMISSION_LABEL_OVERRIDES[p]) {
      acc[p] = PERMISSION_LABEL_OVERRIDES[p];
    } else {
      const [dom = '', act = ''] = p.split(':');
      acc[p] = `${DOMAIN_LABELS[dom] ?? dom}·${ACTION_LABELS[act] ?? act}`;
    }
    return acc;
  },
  {} as Record<Permission, string>,
);

/** 单个角色的定义（角色管理功能的可编辑单元） */
export interface RoleDef {
  /** 角色键（与 Base 系统用户表「系统角色」多选字段选项一致；自定义角色为任意唯一字符串） */
  key: string;
  /** 展示名（缺省等于 key） */
  label: string;
  /** 授予的权限点 */
  permissions: Permission[];
  /** 数据密级上限 */
  maxDataLevel: DataLevel;
  /** 内置角色：不可删除 */
  protected?: boolean;
  /** 权限集锁定（如系统管理员）：仅可改名，权限/密级不可改 */
  lockedPermissions?: boolean;
}

/** 角色权限矩阵配置（持久化于系统配置表） */
export interface RolePermissionConfig {
  roles: RoleDef[];
}
