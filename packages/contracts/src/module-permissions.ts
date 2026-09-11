/** 模块目录不依赖 role/homepage，避免权限枚举与导航配置形成循环依赖。 */
export const MODULE_ACTION_LABELS = {
  enter: '进入菜单',
  read: '查看',
  create: '新增',
  update: '编辑',
  delete: '删除/归档',
  import: '导入',
  export: '导出',
  refresh: '刷新',
  transition: '状态流转',
} as const;

export type ModuleAction = keyof typeof MODULE_ACTION_LABELS;
export type ModulePermission = `module:${string}:${ModuleAction}`;
export const ROLE_PERMISSION_VERSION = 2;

export interface ModuleResource {
  /** 稳定标识：沿用 DEFAULT_NAV_MENU_CONFIG 的 key，而非接口路径。 */
  key: string;
  label: string;
  /** 主 API 路径；没有独立 API 的页面使用前端路径。 */
  path: string;
  aliases?: readonly string[];
  /** 旧服务实际校验的权限；null 表示无此操作/无可自动继承的旧权限。 */
  legacyRead: string | null;
  legacyWrite: string | null;
  /** 旧菜单权限，仅用于一次性迁移 enter，不用于运行时鉴权。 */
  menuPermission: string | null;
  actions: readonly ModuleAction[];
  /** 与旧导航一致：限制菜单入口，不替代服务端操作鉴权。 */
  adminOnly?: boolean;
  /** 特殊动作迁移条件：数组中的旧权限必须全部满足，空数组不继承。 */
  legacyActions?: Partial<Record<ModuleAction, readonly string[]>>;
  /** 是否由通用 CRUD（GenericCrudModule.registerAll）承载，具备标准 /import 批量导入端点。
   *  仅用于前端 CrudPage 自动接线导入按钮，不影响鉴权（鉴权走 module:<key>:<action>）。 */
  genericCrud?: boolean;
}

const READ = ['enter', 'read', 'refresh'] as const;
const CRUD = ['enter', 'read', 'create', 'update', 'delete', 'refresh'] as const;
const RECORD = [...CRUD, 'export'] as const;
const FLOW = [...RECORD, 'transition'] as const;
/** 通用 CRUD 承载的可写记录模块：在 RECORD 基础上开放批量导入（module:<key>:import）。 */
const RECORD_IMPORT = [...RECORD, 'import'] as const;

/**
 * 手工核对 homepage 菜单、API controller/service、lifecycle/idp 元数据及前端表单。
 * import 只登记现有 MarkdownField 导入，不意味着具备批量记录导入接口。
 * export 的别名使用 TABLES 的真实键，不能从菜单 key 或页面文案猜测。
 * refresh 专指重新读取 UI 数据；同步、执行等写操作属于 update/transition。
 * 第三层按钮/区块目录可独立扩展；本次不生成按钮权限。
 */
export const MODULE_RESOURCES: readonly ModuleResource[] = [
  { key: 'dashboard', label: '概览', path: '/dashboard', aliases: ['/'], legacyRead: 'student:read', legacyWrite: null, menuPermission: 'dashboard:read', actions: READ },
  { key: 'students', label: '学生档案', path: '/students', aliases: ['/export/studentProfile'], legacyRead: 'student:read', legacyWrite: 'student:write', menuPermission: 'student:read', actions: RECORD, legacyActions: { delete: ['student:archive'] } },
  { key: 'courses', label: '课程方案', path: '/course-plans', aliases: ['/courses', '/export/coursePlan'], legacyRead: 'course:read', legacyWrite: 'course:write', menuPermission: 'course:read', actions: FLOW },
  { key: 'teaching', label: '教学班级', path: '/teaching-classes', aliases: ['/enrollments', '/export/teachingClass', '/export/enrollment'], legacyRead: 'course:read', legacyWrite: 'course:write', menuPermission: 'teaching:read', actions: FLOW },
  { key: 'schedule', label: '排课课次', path: '/sessions', aliases: ['/schedule', '/export/session'], legacyRead: 'schedule:read', legacyWrite: 'schedule:write', menuPermission: 'schedule:read', actions: FLOW },
  { key: 'portal', label: '学生门户', path: '/portal', legacyRead: 'student:read', legacyWrite: 'attendance:write', menuPermission: 'portal:read', actions: [...READ, 'create'] },
  { key: 'student360', label: '学生全景', path: '/student-360', legacyRead: 'student:read', legacyWrite: null, menuPermission: 'student360:read', actions: READ },
  // lifecycle.meta.ts / idp.meta.ts 的真实 CRUD 权限均为 student:read/write。
  { key: 'sourceFollowups', label: '招生跟进', path: '/source-followups', aliases: ['/source-followups-ai', '/export/sourceFollowup'], legacyRead: 'student:read', legacyWrite: 'student:write', menuPermission: 'followup:read', actions: RECORD_IMPORT, genericCrud: true },
  { key: 'studentAttendances', label: '学生考勤', path: '/student-attendances', aliases: ['/export/attendance'], legacyRead: 'student:read', legacyWrite: 'student:write', menuPermission: 'studentattendance:read', actions: RECORD_IMPORT, genericCrud: true },
  { key: 'grades', label: '学业成绩', path: '/grades', aliases: ['/export/academicGrade'], legacyRead: 'student:read', legacyWrite: 'student:write', menuPermission: 'grade:read', actions: RECORD_IMPORT, genericCrud: true },
  { key: 'practiceActivities', label: '实践活动', path: '/practice-activities', aliases: ['/export/practiceActivity'], legacyRead: 'student:read', legacyWrite: 'student:write', menuPermission: 'activity:read', actions: RECORD_IMPORT, genericCrud: true },
  { key: 'homeSchoolComms', label: '家校沟通', path: '/home-school-comms', aliases: ['/home-school-comms-ai', '/export/homeSchoolComm'], legacyRead: 'student:read', legacyWrite: 'student:write', menuPermission: 'communication:read', actions: RECORD_IMPORT, genericCrud: true },
  { key: 'dailyFollowups', label: '日常跟进', path: '/daily-followups', aliases: ['/daily-followups-ai', '/export/dailyFollowup'], legacyRead: 'student:read', legacyWrite: 'student:write', menuPermission: 'dailyfollowup:read', actions: RECORD_IMPORT, genericCrud: true },
  { key: 'studentObservations', label: '学生观察', path: '/student-observations', aliases: ['/student-observations-ai', '/export/studentObservation'], legacyRead: 'student:read', legacyWrite: 'student:write', menuPermission: 'observation:read', actions: RECORD_IMPORT, genericCrud: true },
  { key: 'meetingMinutes', label: '会议纪要', path: '/meeting-minutes', aliases: ['/export/meetingMinute'], legacyRead: 'department:read', legacyWrite: 'department:write', menuPermission: 'meeting:read', actions: RECORD_IMPORT, genericCrud: true },
  { key: 'idpPlans', label: 'IDP管理', path: '/idp-plans', aliases: ['/idp-communications', '/export/idpPlan', '/export/idpCommunication'], legacyRead: 'student:read', legacyWrite: 'student:write', menuPermission: 'idp:read', actions: RECORD },
  { key: 'stageEvaluations', label: '阶段评价', path: '/stage-evaluations', aliases: ['/export/stageEvaluation'], legacyRead: 'student:read', legacyWrite: 'student:write', menuPermission: 'evaluation:read', actions: RECORD_IMPORT, genericCrud: true },
  { key: 'alumniFollowups', label: '校友跟进', path: '/alumni-followups', aliases: ['/export/alumniFollowup'], legacyRead: 'student:read', legacyWrite: 'student:write', menuPermission: 'alumni:read', actions: RECORD_IMPORT, genericCrud: true },
  { key: 'openPlatformApps', label: '开放平台', path: '/open-platform', legacyRead: 'openplatform:read', legacyWrite: 'openplatform:write', menuPermission: 'openplatform:read', actions: RECORD, genericCrud: true },
  { key: 'reports', label: '报表管理', path: '/reports', legacyRead: 'report:read', legacyWrite: null, menuPermission: 'report:read', actions: READ },
  { key: 'mailAccounts', label: '邮件账户', path: '/mail-accounts', aliases: ['/export/mailAccount'], legacyRead: 'mail:read', legacyWrite: 'mail:write', menuPermission: 'mail:write', actions: RECORD },
  { key: 'mailArchive', label: '邮件归档', path: '/mail-archive', aliases: ['/export/mailArchive'], legacyRead: 'mail:read', legacyWrite: 'mail:write', menuPermission: 'mail:read', actions: [...READ, 'update', 'export'] },
  { key: 'teachers', label: '教师档案', path: '/teachers', aliases: ['/export/teacherProfile'], legacyRead: 'teacher:read', legacyWrite: 'teacher:write', menuPermission: 'teacher:read', actions: RECORD, legacyActions: { delete: ['teacher:archive'] } },
  { key: 'attendance', label: '教师履约', path: '/attendances', aliases: ['/attendance', '/export/teacherAttendance'], legacyRead: 'attendance:read', legacyWrite: 'attendance:write', menuPermission: 'attendance:read', actions: FLOW, legacyActions: { transition: ['attendance:write', 'attendance:approve'] } },
  { key: 'billing', label: '计费结算', path: '/billing', aliases: ['/export/billingDetail'], legacyRead: 'billing:read', legacyWrite: 'billing:write', menuPermission: 'billing:read', actions: FLOW, legacyActions: { transition: ['billing:write', 'billing:confirm', 'billing:settle'] } },
  { key: 'settlements', label: '月度结算', path: '/settlements', aliases: ['/export/monthlySettlement'], legacyRead: 'billing:read', legacyWrite: 'billing:settle', menuPermission: 'settlement:read', actions: FLOW, legacyActions: { transition: ['billing:settle', 'finance:approve'] } },
  { key: 'adjustments', label: '调整冲销', path: '/adjustments', aliases: ['/export/adjustment'], legacyRead: 'finance:read', legacyWrite: 'billing:settle', menuPermission: 'adjustment:read', actions: FLOW, legacyActions: { transition: ['finance:approve'] } },
  { key: 'partnerships', label: '聘用合作', path: '/partnerships', aliases: ['/export/partnership'], legacyRead: 'partnership:read', legacyWrite: 'partnership:write', menuPermission: 'partnership:read', actions: RECORD },
  { key: 'aiChat', label: 'AI 对话', path: '/ai/chat', aliases: ['/ai/conversations'], legacyRead: 'ai:chat', legacyWrite: 'ai:chat', menuPermission: 'ai:chat', actions: CRUD },
  // 个人设置旧服务校验 ai:chat，但组织默认设置写入需 ai:config，合并动作按较严条件继承。
  { key: 'aiConfig', label: 'AI 设置', path: '/ai/config', aliases: ['/ai/presets', '/ai/org-default'], legacyRead: 'ai:chat', legacyWrite: 'ai:config', menuPermission: 'ai:config', actions: [...READ, 'update', 'delete'], legacyActions: { update: ['ai:chat', 'ai:config'], delete: ['ai:chat'] } },
  { key: 'aiAgents', label: 'Bot管理', path: '/ai/agents', aliases: ['/ai/tools'], legacyRead: 'ai:config', legacyWrite: 'ai:config', menuPermission: 'aiagent:read', actions: [...CRUD, 'import'] },
  { key: 'aiSkills', label: '技能管理', path: '/ai/skills', legacyRead: 'ai:admin', legacyWrite: 'ai:admin', menuPermission: 'aiskill:read', actions: [...READ, 'update', 'import'] },
  { key: 'aiAutomations', label: '定时任务', path: '/ai/automations', aliases: ['/ai/cron/build'], legacyRead: 'ai:automation', legacyWrite: 'ai:automation', menuPermission: 'ai:automation', actions: [...CRUD, 'transition'] },
  { key: 'aiAdmin', label: 'AI 用量', path: '/ai/admin', legacyRead: 'ai:admin', legacyWrite: null, menuPermission: 'aiusage:read', actions: READ },
  { key: 'getnote', label: '知识库', path: '/getnote', legacyRead: 'getnote:read', legacyWrite: 'getnote:write', menuPermission: 'getnote:read', actions: [...CRUD, 'import'] },
  { key: 'getnoteSources', label: '知识库配置', path: '/getnote-sources', aliases: ['/getnote/sources', '/export/getnoteSource'], legacyRead: 'getnote:read', legacyWrite: 'getnote:write', menuPermission: 'getnote:write', actions: RECORD },
  { key: 'dictionary', label: '字典数据', path: '/dictionaries', legacyRead: 'config:read', legacyWrite: 'config:write', menuPermission: 'config:read', actions: [...READ, 'update'] },
  // 导出工作台只授予入口/查看；执行导出必须检查源模块的 export，不提供全表通行证。
  { key: 'export', label: '数据导出', path: '/export', legacyRead: 'export:run', legacyWrite: null, menuPermission: 'export:run', actions: ['enter', 'read'] },
  { key: 'audit-logs', label: '审计日志', path: '/audit-logs', aliases: ['/export/auditLog'], legacyRead: 'admin:audit', legacyWrite: null, menuPermission: null, actions: [...READ, 'export'], adminOnly: true },
  { key: 'users', label: '用户管理', path: '/users', legacyRead: 'admin:user', legacyWrite: 'admin:user', menuPermission: null, actions: [...CRUD, 'transition'], adminOnly: true },
  { key: 'permissions', label: '权限授权', path: '/auth/permissions', aliases: ['/permissions'], legacyRead: 'admin:user', legacyWrite: null, menuPermission: null, actions: READ, adminOnly: true },
  { key: 'role-management', label: '角色管理', path: '/role-management', legacyRead: 'admin:user', legacyWrite: 'admin:user', menuPermission: 'admin:user', actions: CRUD, adminOnly: true },
  { key: 'notifications', label: '通知任务', path: '/notifications', aliases: ['/export/notificationLog'], legacyRead: 'notification:read', legacyWrite: 'notification:send', menuPermission: 'notification:read', actions: [...READ, 'create', 'transition', 'export'], legacyActions: { transition: ['notification:read', 'notification:send'] } },
  { key: 'notification-templates', label: '通知模板', path: '/notifications/templates', aliases: ['/notification-templates', '/export/notificationTemplate'], legacyRead: 'notification:read', legacyWrite: 'notification:write', menuPermission: 'notification:write', actions: RECORD },
  { key: 'settings', label: '系统设置', path: '/settings', aliases: ['/export/systemConfig'], legacyRead: 'config:read', legacyWrite: 'config:write', menuPermission: null, actions: RECORD_IMPORT, adminOnly: true, genericCrud: true },
  { key: 'attendance-zones', label: '考勤围栏', path: '/attendance-zones', aliases: ['/export/attendanceZone'], legacyRead: 'config:read', legacyWrite: 'config:write', menuPermission: null, actions: RECORD_IMPORT, adminOnly: true, genericCrud: true },
  { key: 'wechat-bindings', label: '微信用户', path: '/wechat-bindings', aliases: ['/wechat-binding-actions', '/export/wechatBinding'], legacyRead: 'config:read', legacyWrite: 'config:write', menuPermission: null, actions: [...RECORD_IMPORT, 'transition'], adminOnly: true, genericCrud: true, legacyActions: { transition: ['config:write'] } },
  // 两个页面共用 homepage-config 整体读写；该 API 归登录页配置，主题页保留独立前端入口。
  { key: 'homepage-management', label: '工作台主题', path: '/homepage-management', legacyRead: null, legacyWrite: null, menuPermission: null, actions: [...READ, 'update'], adminOnly: true },
  { key: 'homepage-settings', label: '登录页配置', path: '/homepage-config', aliases: ['/homepage-settings'], legacyRead: null, legacyWrite: null, menuPermission: null, actions: [...READ, 'update'], adminOnly: true },
  { key: 'menu-settings', label: '菜单管理', path: '/homepage-config/menu', aliases: ['/menu-settings'], legacyRead: null, legacyWrite: null, menuPermission: null, actions: [...READ, 'update'], adminOnly: true },
  { key: 'menu-groups-settings', label: '菜单分组', path: '/homepage-config/menu-groups', aliases: ['/menu-groups-settings'], legacyRead: null, legacyWrite: null, menuPermission: null, actions: [...READ, 'update'], adminOnly: true },
  { key: 'note-convert', label: '转换配置', path: '/homepage-config/note-convert', aliases: ['/note-convert'], legacyRead: null, legacyWrite: null, menuPermission: null, actions: [...READ, 'update'], adminOnly: true },
  { key: 'student-users', label: '学生账号', path: '/student-auth/accounts', aliases: ['/student-users', '/student-auth/search', '/student-auth/admin/set-password'], legacyRead: 'admin:studentUser', legacyWrite: 'admin:studentUser', menuPermission: 'admin:studentUser', actions: [...READ, 'update'], adminOnly: true },
  // 组织管理 / 部门管理：只读同步飞书通讯录部门树，全员可见（菜单 perm 空）。
  // 无写权限点；同步动作由后端身份 system:department-sync 执行，不暴露给普通用户。
  { key: 'departments', label: '部门管理', path: '/department-management', legacyRead: 'department:read', legacyWrite: null, menuPermission: null, actions: READ },
];

/** 返回值是 Permission 的子类型，供现有 authorize/hasPermission 直接使用。 */
export function modulePermission(key: string, action: ModuleAction): ModulePermission {
  return `module:${key}:${action}`;
}

export const MODULE_PERMISSIONS: readonly ModulePermission[] = MODULE_RESOURCES.flatMap((resource) =>
  resource.actions.map((action) => modulePermission(resource.key, action)),
);

/** 最长路径段边界匹配；支持 API 前缀、查询串、片段和完整前端 URL，未知路径返回 undefined。 */
export function moduleByPath(path: string): ModuleResource | undefined {
  let pathname = path;
  if (/^https?:\/\//i.test(pathname)) {
    const m = /^https?:\/\/[^/]+(\/[^?#]*)/.exec(pathname);
    if (!m) return undefined;
    pathname = m[1] ?? '/';
  }
  pathname = pathname.split(/[?#]/, 1)[0] ?? '';
  if (!pathname) return undefined;
  pathname = `/${pathname.replace(/^\/+|\/+$/g, '')}`;
  pathname = pathname.replace(/^\/api\/v1(?=\/|$)/, '') || '/';
  let best: ModuleResource | undefined;
  let length = -1;
  for (const resource of MODULE_RESOURCES) {
    for (const candidate of [resource.path, ...(resource.aliases ?? [])]) {
      if (candidate.length > length && (pathname === candidate || (candidate !== '/' && pathname.startsWith(`${candidate}/`)))) {
        best = resource;
        length = candidate.length;
      }
    }
  }
  return best;
}
