/** 登录页 / 首页配置（由「首页管理」编辑器维护） */

export interface LoginFeature {
  icon: 'shield' | 'users' | 'layers' | 'lock' | 'check' | 'zap' | string;
  title: string;
  desc: string;
}

/** 登录后工作台/仪表盘主题 */
export interface DashboardTheme {
  /** 侧边栏背景色 */
  sidebarBgColor: string;
  /** 侧边栏文字色 */
  sidebarTextColor: string;
  /** 侧边栏 hover 背景色 */
  sidebarHoverBgColor: string;
  /** 侧边栏选中项背景色 */
  sidebarActiveBgColor: string;
  /** 侧边栏选中项文字色 */
  sidebarActiveTextColor: string;
  /** 侧边栏分组标题色 */
  sidebarSectionColor: string;
  /** 侧边栏边框色 */
  sidebarBorderColor: string;

  /** 侧边栏展开宽度（px） */
  sidebarWidth?: number;

  /** 顶部 header 背景色 */
  headerBgColor: string;
  /** 顶部 header 文字色 */
  headerTextColor: string;
  /** 顶部 header 边框色 */
  headerBorderColor: string;

  /** 主内容区背景色 */
  mainBgColor?: string;
  /** 主内容区文字色 */
  mainTextColor?: string;

  /** 工作台左上角 Logo（URL 或 file_token），为空则使用登录页 logoUrl */
  logoUrl?: string | null;
  /** 工作台品牌名，为空则使用登录页 brandName */
  brandName?: string;
  /** 工作台品牌副标题，为空则使用登录页 brandSubtitle */
  brandSubtitle?: string;
}

/** 导航菜单项 */
export interface NavMenuItem {
  key: string;
  /** 中文显示名（默认语言） */
  label: string;
  /** 英文显示名；为空时英文环境回退到静态 en.json（nav 命名空间，按 key 查）或中文 label */
  enLabel?: string;
  href: string;
  /** 图标名称（对应 AppShell 中的图标映射） */
  icon: string;
  /** 所属分组；parentKey 为空时必填 */
  section?: string | null;
  /** 父级菜单 key；为空表示顶层菜单 */
  parentKey?: string | null;
  /** 同级排序，越小越靠前 */
  order: number;
  /** 仅系统管理员可见 */
  adminOnly?: boolean;
  /** 所需权限标识 */
  perm?: string;
  /** 是否置灰显示「敬请期待」 */
  disabled?: boolean;
}

export interface NavMenuConfig {
  items: NavMenuItem[];
}

/**
 * 笔记转换目标：一条「笔记 → 业务记录」的映射配置。
 *
 * 与菜单配置同源，存在系统配置表（配置键 `note_convert_config`），
 * 避免为一项配置单独建飞书表。
 *
 * `key` 关联菜单 key：系统里新开发的菜单由后端读取时自愈补充（enabled 默认 false），
 * 所以配置页会自动出现新功能；「新增」按钮用于登记尚未进菜单的功能。
 */
export interface NoteConvertTarget {
  /** 关联菜单 key（与 NavMenuItem.key 一致）；手工新增时为 note_conv_ 前缀 */
  key: string;
  /** 菜单中文名 */
  label: string;
  /** 菜单英文名 */
  enLabel?: string;
  /** 菜单路径：转换时跳到该路径并自动进入新建态 */
  href: string;
  /** 是否转换：只有 true 的菜单才会出现在笔记列表的「转换」候选里 */
  enabled: boolean;
  /** 笔记「总结」写入目标模块的哪个字段（如家校沟通的 沟通总结） */
  summaryField: string;
  /** 笔记「原始记录」写入目标模块的哪个字段（如家校沟通的 沟通明细） */
  rawField: string;
  /** 排序，越小越靠前 */
  order: number;
  /** 是否手工新增（非菜单自动带出） */
  custom?: boolean;
}

export interface NoteConvertConfig {
  items: NoteConvertTarget[];
}

/**
 * 笔记转换留痕记录。
 *
 * ⚠️ 为什么不在 Get笔记 上打标签留痕：上游硬限制**单篇笔记最多 5 个标签**
 * （报错 `tags length must be less than 5`），而 system + ai 标签往往已占掉 4 个，
 * 留痕只剩 1 个位 —— 结果是一篇笔记只能成功留痕一个模块，之后转其他模块全部失败。
 * 所以留痕落在 ACMS 自己的「笔记转换记录」表里，顺带能记住转成了哪条业务记录。
 */
export interface NoteConvertLogItem {
  /** 留痕记录 id（回填目标记录 ID 时要用） */
  logId: string;
  /** 目标模块 key，如 homeSchoolComms */
  moduleKey: string;
  /** 目标模块中文名，如 家校沟通 */
  moduleLabel: string;
  /** 该笔记转成该模块的累计次数 */
  count: number;
  /** 最近一次转换时间（datetime 字段，毫秒时间戳或 ISO） */
  at?: string | number;
  /** 转换人姓名 */
  by?: string;
  /** 目标模块里生成的业务记录 id（目标页保存成功后回填） */
  targetRecordId?: string;
}

/**
 * 笔记 ↔ 知识库配置 的归属关系（「我的笔记」列表的「配置名称」列用）。
 *
 * 数据来源：飞书「笔记配置映射」表。自动同步时由 SourcesService.processNote 写入，
 * 历史笔记由 scripts/backfill_note_config_map.mjs 补。
 * 没有映射记录的笔记（如手工在 Get笔记 建的、或还没同步过）查不到，列表显示「—」。
 */
export interface NoteConfigMapItem {
  /** 知识库配置表的记录 id */
  configId: string;
  /** 配置名称（快照；显示时优先用配置表当前名称，改名能自动生效） */
  configName: string;
}

/**
 * 笔记转换的智能默认字段映射：菜单 key → 目标模块的「总结字段 / 原始记录字段」。
 *
 * 只登记已核对过字段名的常用模块（家校沟通 / 日常跟进 / 招生跟进 三者的
 * 「沟通总结」「沟通明细」key 完全一致）。未登记的菜单在配置页降级为手工填写。
 * 新增模块映射时在此登记即可，前后端共用这一份。
 */
export const DEFAULT_CONVERT_FIELDS: Record<string, { summaryField: string; rawField: string }> = {
  homeSchoolComms: { summaryField: '沟通总结', rawField: '沟通明细' },
  dailyFollowups: { summaryField: '沟通总结', rawField: '沟通明细' },
  // 学生观察：字段结构照搬日常跟进，总结/明细 key 完全一致（2026-09-06）
  studentObservations: { summaryField: '沟通总结', rawField: '沟通明细' },
  // 会议纪要（2026-09-11）：笔记「总结」→ 会议总结，「原始记录」→ 会议明细
  meetingMinutes: { summaryField: '会议总结', rawField: '会议明细' },
  sourceFollowups: { summaryField: '沟通总结', rawField: '沟通明细' },
  alumniFollowups: { summaryField: '跟进事项', rawField: '跟进备注' },
  idpPlans: { summaryField: '展示内容', rawField: '原始文档' },
  practiceActivities: { summaryField: '活动内容', rawField: '活动表现' },
  stageEvaluations: { summaryField: '评价内容', rawField: '改进计划' },
  grades: { summaryField: '课堂表现', rawField: '教师评语' },
  studentAttendances: { summaryField: '异常描述', rawField: '处理结果' },
};

/** 图标名称（与 AppShell 中 ICONS 映射一一对应）。新增图标时同步更新 AppShell 的组件与 ICON_NAMES。 */
export type IconName =
  | 'dashboard' | 'students' | 'admissions' | 'courses' | 'schedule' | 'teachers'
  | 'notifications' | 'chat' | 'config' | 'bot' | 'skill' | 'clock' | 'chart'
  | 'billing' | 'audit' | 'system' | 'integration' | 'userGroup' | 'shield'
  | 'dictionary' | 'reports' | 'settings'
  // 新增同风格图标（B6）
  | 'user' | 'key' | 'lock' | 'location' | 'calendar' | 'file' | 'folder'
  | 'star' | 'check' | 'book' | 'graduation' | 'mail' | 'phone' | 'list'
  | 'grid' | 'target' | 'wallet' | 'award' | 'flag' | 'compass';

export const ICON_NAMES: readonly IconName[] = [
  'dashboard', 'students', 'admissions', 'courses', 'schedule', 'teachers',
  'notifications', 'chat', 'config', 'bot', 'skill', 'clock', 'chart',
  'billing', 'audit', 'system', 'integration', 'userGroup', 'shield',
  'dictionary', 'reports', 'settings',
  // 新增同风格图标（B6）
  'user', 'key', 'lock', 'location', 'calendar', 'file', 'folder',
  'star', 'check', 'book', 'graduation', 'mail', 'phone', 'list',
  'grid', 'target', 'wallet', 'award', 'flag', 'compass',
];

/** 菜单分组（用于「菜单管理」的分组下拉与侧边栏分组的展示顺序） */
export interface NavMenuGroup {
  /** 分组标识（与 NavMenuItem.section 对应，唯一） */
  key: string;
  /** 分组显示名（中文，默认语言） */
  label: string;
  /** 分组英文显示名；为空时英文环境回退到静态 en.json（navSection 命名空间，按中文名查）或中文 label */
  enLabel?: string;
  /** 同级排序，越小越靠前 */
  order: number;
}

export interface NavMenuGroupConfig {
  items: NavMenuGroup[];
}

export interface HomepageConfig {
  /** 左侧面板宽度百分比（0-100） */
  leftWidth: number;
  /** 右侧面板宽度百分比（0-100） */
  rightWidth: number;

  /** 左侧背景色 */
  leftBgColor: string;
  /** 左侧背景图：URL 或飞书 file_token */
  leftBgImage?: string | null;
  /** 左侧文字色 */
  leftTextColor: string;

  /** 右侧背景色 */
  rightBgColor: string;
  /** 右侧背景图：URL 或飞书 file_token */
  rightBgImage?: string | null;
  /** 右侧文字色 */
  rightTextColor: string;

  /** 左上角 Logo（URL 或 file_token），为空则显示品牌首字母 */
  logoUrl?: string | null;
  /** 品牌名 */
  brandName: string;
  /** 品牌副标题 */
  brandSubtitle: string;

  /** 主标题字体大小（CSS 值） */
  headingFontSize: string;
  /** 正文字体大小（CSS 值） */
  bodyFontSize: string;
  /** 字体族 */
  fontFamily: string;

  /** 左侧 eyebrow 小字 */
  eyebrow: string;
  /** 左侧 section label */
  sectionLabel: string;
  /** 左侧主标题（支持 \n 换行） */
  heroTitle: string;
  /** 左侧副标题 */
  heroSubtitle: string;
  /** 左侧特性列表 */
  features: LoginFeature[];

  /** 右侧小标签 */
  rightLabel: string;
  /** 右侧标题 */
  rightHeading: string;
  /** 右侧描述 */
  rightDesc: string;
  /** 登录按钮文字 */
  ctaText: string;
  /** 右下角状态标签 */
  statusTag: string;
  /** 右下角状态说明 */
  statusText: string;

  /** 登录后工作台主题 */
  dashboardTheme?: DashboardTheme;
}

/** 分组中文名 → 英文（与 en.json 的 navSection 保持一致，用于默认分组的 enLabel 回填） */
export const SECTION_EN_LABELS: Record<string, string> = {
  工作台: 'Workspace',
  业务管理: 'Operations',
  学生闭环: 'Student Lifecycle',
  教师管理: 'Faculty',
  智能助手: 'AI Assistant',
  后台管理: 'Administration',
  邮件归档: 'Mail Archive',
  知识库: 'Knowledge Base',
  报表管理: 'Reports',
  组织管理: 'Organization',
  'AI 路由': 'AI Gateway',
};

/** 默认导航菜单（与当前 AppShell 硬编码菜单保持一致，用于回退） */
export const DEFAULT_NAV_MENU_CONFIG: NavMenuConfig = {
  items: [
    { key: 'dashboard', label: '概览', enLabel: 'Overview', href: '/', icon: 'dashboard', section: '工作台', order: 10, perm: 'dashboard:read' },

    { key: 'students', label: '学生档案', enLabel: 'Students', href: '/students', icon: 'students', section: '业务管理', order: 10, perm: 'student:read' },
    { key: 'courses', label: '课程方案', enLabel: 'Courses', href: '/courses', icon: 'courses', section: '业务管理', order: 20, perm: 'course:read' },
    { key: 'teaching', label: '教学班级', enLabel: 'Teaching Classes', href: '/teaching-classes', icon: 'courses', section: '业务管理', order: 30, perm: 'teaching:read' },
    { key: 'schedule', label: '排课课次', enLabel: 'Schedules', href: '/schedule', icon: 'schedule', section: '业务管理', order: 40, perm: 'schedule:read' },
    { key: 'portal', label: '学生门户', enLabel: 'Student Portal', href: '/portal', icon: 'students', section: '业务管理', order: 50, perm: 'portal:read' },

    { key: 'student360', label: '学生全景', enLabel: 'Student 360', href: '/student-360', icon: 'students', section: '学生闭环', order: 10, perm: 'student360:read' },
    { key: 'sourceFollowups', label: '招生跟进', enLabel: 'Admissions Follow-ups', href: '/source-followups', icon: 'admissions', section: '学生闭环', order: 20, perm: 'followup:read' },
    { key: 'studentAttendances', label: '学生考勤', enLabel: 'Attendance', href: '/student-attendances', icon: 'students', section: '学生闭环', order: 30, perm: 'studentattendance:read' },
    { key: 'grades', label: '学业成绩', enLabel: 'Grades', href: '/grades', icon: 'courses', section: '学生闭环', order: 40, perm: 'grade:read' },
    { key: 'practiceActivities', label: '实践活动', enLabel: 'Activities', href: '/practice-activities', icon: 'students', section: '学生闭环', order: 50, perm: 'activity:read' },
    { key: 'homeSchoolComms', label: '家校沟通', enLabel: 'Home-School Comms', href: '/home-school-comms', icon: 'notifications', section: '学生闭环', order: 60, perm: 'communication:read' },
    { key: 'dailyFollowups', label: '日常跟进', enLabel: 'Daily Follow-ups', href: '/daily-followups', icon: 'notifications', section: '学生闭环', order: 70, perm: 'dailyfollowup:read' },
    { key: 'studentObservations', label: '学生观察', enLabel: 'Student Observations', href: '/student-observations', icon: 'students', section: '学生闭环', order: 72, perm: 'observation:read' },
    { key: 'idpPlans', label: 'IDP管理', enLabel: 'IDP Plans', href: '/idp-plans', icon: 'target', section: '学生闭环', order: 75, perm: 'idp:read' },
    { key: 'stageEvaluations', label: '阶段评价', enLabel: 'Stage Evaluations', href: '/stage-evaluations', icon: 'students', section: '学生闭环', order: 80, perm: 'evaluation:read' },
    { key: 'alumniFollowups', label: '校友跟进', enLabel: 'Alumni Follow-ups', href: '/alumni-followups', icon: 'students', section: '学生闭环', order: 90, perm: 'alumni:read' },

    { key: 'reports', label: '报表管理', enLabel: 'Reports', href: '/reports', icon: 'reports', section: '报表管理', order: 10, perm: 'report:read' },

    { key: 'mailAccounts', label: '邮件账户', enLabel: 'Mail Accounts', href: '/mail-accounts', icon: 'mail', section: '邮件归档', order: 10, perm: 'mail:write' },
    { key: 'mailArchive', label: '邮件归档', enLabel: 'Mail Archive', href: '/mail-archive', icon: 'folder', section: '邮件归档', order: 20, perm: 'mail:read' },

    { key: 'teachers', label: '教师档案', enLabel: 'Teachers', href: '/teachers', icon: 'teachers', section: '教师管理', order: 10, perm: 'teacher:read' },
    { key: 'attendance', label: '教师履约', enLabel: 'Faculty Attendance', href: '/attendance', icon: 'teachers', section: '教师管理', order: 20, perm: 'attendance:read' },
    { key: 'billing', label: '计费结算', enLabel: 'Billing', href: '/billing', icon: 'billing', section: '教师管理', order: 30, perm: 'billing:read' },
    { key: 'settlements', label: '月度结算', enLabel: 'Monthly Settlements', href: '/settlements', icon: 'billing', section: '教师管理', order: 40, perm: 'settlement:read' },
    { key: 'adjustments', label: '调整冲销', enLabel: 'Adjustments', href: '/adjustments', icon: 'billing', section: '教师管理', order: 50, perm: 'adjustment:read' },
    { key: 'partnerships', label: '聘用合作', enLabel: 'Partnerships', href: '/partnerships', icon: 'teachers', section: '教师管理', order: 60, perm: 'partnership:read' },

    { key: 'aiChat', label: 'AI 对话', enLabel: 'AI Chat', href: '/ai/chat', icon: 'chat', section: '智能助手', order: 10, perm: 'ai:chat' },
    { key: 'aiDocs', label: 'AI 文档', enLabel: 'AI Docs', href: '/ai-docs', icon: 'file', section: '智能助手', order: 12, perm: 'ai:chat' },
    { key: 'aiConfig', label: 'AI 设置', enLabel: 'AI Settings', href: '/ai/config', icon: 'config', section: '智能助手', order: 20, perm: 'ai:config' },
    { key: 'aiAgents', label: 'Bot管理', enLabel: 'Bots', href: '/ai/agents', icon: 'bot', section: '智能助手', order: 30, perm: 'aiagent:read' },
    { key: 'aiSkills', label: '技能管理', enLabel: 'Skills', href: '/ai/skills', icon: 'skill', section: '智能助手', order: 40, perm: 'aiskill:read' },
    { key: 'aiAutomations', label: '定时任务', enLabel: 'Scheduled Tasks', href: '/ai/automations', icon: 'clock', section: '智能助手', order: 50, perm: 'ai:automation' },
    { key: 'aiAdmin', label: 'AI 用量', enLabel: 'AI Usage', href: '/ai/admin', icon: 'chart', section: '智能助手', order: 60, perm: 'aiusage:read' },

    { key: 'getnote', label: '知识库', enLabel: 'Knowledge Base', href: '/getnote', icon: 'dictionary', section: '知识库', order: 10, perm: 'getnote:read' },
    { key: 'getnoteSources', label: '知识库配置', enLabel: 'Knowledge Sources', href: '/getnote/sources', icon: 'config', section: '知识库', order: 20, perm: 'getnote:write' },

    { key: 'dictionary', label: '字典数据', enLabel: 'Dictionaries', href: '/dictionaries', icon: 'dictionary', section: '后台管理', order: 10, perm: 'config:read' },
    { key: 'export', label: '数据导出', enLabel: 'Export', href: '/export', icon: 'reports', section: '后台管理', order: 20, perm: 'export:run' },
    { key: 'audit-logs', label: '审计日志', enLabel: 'Audit Logs', href: '/audit-logs', icon: 'audit', section: '后台管理', order: 30, adminOnly: true },
    { key: 'users', label: '用户管理', enLabel: 'Users', href: '/users', icon: 'userGroup', section: '后台管理', order: 40, adminOnly: true },
    { key: 'permissions', label: '权限授权', enLabel: 'Permissions', href: '/permissions', icon: 'shield', section: '后台管理', order: 50, adminOnly: true },
    { key: 'role-management', label: '角色管理', enLabel: 'Role Management', href: '/role-management', icon: 'key', section: '后台管理', order: 52, adminOnly: true, perm: 'admin:user' },
    { key: 'notifications', label: '通知任务', enLabel: 'Notifications', href: '/notifications', icon: 'notifications', section: '后台管理', order: 60, perm: 'notification:read' },
    { key: 'notification-templates', label: '通知模板', enLabel: 'Notification Templates', href: '/notification-templates', icon: 'notifications', section: '后台管理', order: 70, perm: 'notification:write' },
    { key: 'settings', label: '系统设置', enLabel: 'Settings', href: '/settings', icon: 'settings', section: '后台管理', order: 80, adminOnly: true },
    { key: 'system-monitor', label: '系统监控', enLabel: 'System Monitor', href: '/system-monitor', icon: 'chart', section: '后台管理', order: 85, adminOnly: true, perm: 'admin:monitor' },
    { key: 'attendance-zones', label: '考勤围栏', enLabel: 'Attendance Zones', href: '/attendance-zones', icon: 'settings', section: '后台管理', order: 90, adminOnly: true },
    { key: 'wechat-bindings', label: '微信用户', enLabel: 'WeChat Users', href: '/wechat-bindings', icon: 'userGroup', section: '后台管理', order: 100, adminOnly: true },
    { key: 'homepage-management', label: '工作台主题', enLabel: 'Dashboard Theme', href: '/homepage-management', icon: 'settings', section: '后台管理', order: 105, adminOnly: true },
    { key: 'homepage-settings', label: '登录页配置', enLabel: 'Login Page Config', href: '/homepage-settings', icon: 'settings', section: '后台管理', order: 110, adminOnly: true },
    { key: 'open-platform', label: '开放平台', enLabel: 'Open Platform', href: '/open-platform', icon: 'settings', section: '后台管理', order: 115, adminOnly: true, perm: 'openplatform:read' },
    { key: 'weiling-contacts', label: '联系人管理', enLabel: 'Contacts', href: '/weiling-contacts', icon: 'userGroup', section: '招生管理', order: 10, perm: 'weiling:read' },
    { key: 'menu-settings', label: '菜单管理', enLabel: 'Menu Management', href: '/menu-settings', icon: 'dictionary', section: '后台管理', order: 120, adminOnly: true },
    { key: 'menu-groups-settings', label: '菜单分组', enLabel: 'Menu Groups', href: '/menu-groups-settings', icon: 'list', section: '后台管理', order: 122, adminOnly: true },
    { key: 'note-convert', label: '转换配置', enLabel: 'Note Convert', href: '/note-convert', icon: 'settings', section: '后台管理', order: 124, adminOnly: true },
    { key: 'student-users', label: '学生账号', enLabel: 'Student Accounts', href: '/student-users', icon: 'user', section: '后台管理', order: 130, adminOnly: true, perm: 'admin:studentUser' },

  // ── 组织管理（2026-09-10 新增）：只读同步飞书通讯录部门树，全员可见 ──
  { key: 'department-management', label: '部门管理', enLabel: 'Departments', href: '/department-management', icon: 'compass', section: '组织管理', order: 10, perm: '' },
  { key: 'meetingMinutes', label: '会议纪要', enLabel: 'Meeting Minutes', href: '/meeting-minutes', icon: 'notifications', section: '组织管理', order: 20, perm: 'meeting:read' },

    // ── AI 路由（acapi 网关移植，2026-09-12）────────────────────────
    // 一套自建的大模型调用网关：上游是各家厂商的真实账号，对外发我们自己的密钥。
    // 菜单可见性走 module:<key>:enter（无需 perm），接口权限同名。
    { key: 'aiRouteGroups', label: '分组管理', enLabel: 'Groups', href: '/ai-route-groups', icon: 'integration', section: 'AI 路由', order: 10, perm: '' },
    { key: 'aiUpstreams', label: '上游账号', enLabel: 'Upstreams', href: '/ai-upstreams', icon: 'bot', section: 'AI 路由', order: 20, perm: '' },
    { key: 'aiModelRoutes', label: '模型路由', enLabel: 'Model Routes', href: '/ai-model-routes', icon: 'compass', section: 'AI 路由', order: 30, perm: '' },
    { key: 'aiApiKeys', label: 'API 密钥', enLabel: 'API Keys', href: '/ai-api-keys', icon: 'key', section: 'AI 路由', order: 40, perm: '' },
    { key: 'aiUsage', label: '用量统计', enLabel: 'Usage', href: '/ai-usage', icon: 'chart', section: 'AI 路由', order: 50, perm: '' },
    { key: 'aiOpLogs', label: '审计日志', enLabel: 'Audit Log', href: '/ai-op-logs', icon: 'audit', section: 'AI 路由', order: 60, perm: '' },
  ],
};

/** 与当前设计稿一致的默认配置 */
export const DEFAULT_HOMEPAGE_CONFIG: HomepageConfig = {
  leftWidth: 40,
  rightWidth: 60,

  leftBgColor: '#0F2E2B',
  leftBgImage: null,
  leftTextColor: '#FFFFFF',

  rightBgColor: '#F4F7F6',
  rightBgImage: null,
  rightTextColor: '#111827',

  logoUrl: null,
  brandName: 'ARETE',
  brandSubtitle: 'COLLEGE MGMT',

  headingFontSize: 'clamp(32px, 4vw, 48px)',
  bodyFontSize: '14px',
  fontFamily:
    'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif',

  eyebrow: 'AUTH / 01',
  sectionLabel: 'IDENTITY GATEWAY',
  heroTitle: '学院运营\n从可信身份开始。',
  heroSubtitle:
    '身份、角色、校区和数据密级在进入工作台前完成校验。浏览器不会直接访问飞书 Base。',
  features: [
    { icon: 'shield', title: '身份来源', desc: 'Feishu Open ID' },
    { icon: 'layers', title: '授权模型', desc: 'RBAC + ABAC' },
    { icon: 'lock', title: '合规边界', desc: 'HttpOnly / S·H' },
  ],

  rightLabel: 'SECURE SIGN-IN / ARETE',
  rightHeading: '进入管理工作台',
  rightDesc:
    '飞书身份必须在「系统用户与角色表」中唯一、启用且处于有效期内；数据范围规则只会收敛角色权限。',
  ctaText: '使用飞书登录',
  statusTag: 'FAIL. CLOSED',
  statusText:
    '账户不存在、账号停用、授权过期、角色或密级超出许可时，系统将拒绝建立会话。',

  dashboardTheme: {
    sidebarBgColor: '#0F2E2B',
    sidebarTextColor: '#D4E8E4',
    sidebarHoverBgColor: '#174A45',
    sidebarActiveBgColor: '#1A5C56',
    sidebarActiveTextColor: '#FFFFFF',
    sidebarSectionColor: '#8FBDB7',
    sidebarBorderColor: 'rgba(255,255,255,0.08)',
    sidebarWidth: 252,

    headerBgColor: 'rgba(11,34,31,0.90)',
    headerTextColor: '#F0F7F6',
    headerBorderColor: 'rgba(255,255,255,0.08)',

    mainBgColor: '#F4F7F6',
    mainTextColor: '#111827',

    logoUrl: null,
    brandName: 'ARETE',
    brandSubtitle: 'COLLEGE OPS',
  },
};

/** 把图片字段值解析为可显示的 URL：
 *  - 以 http(s) 开头：直接返回
 *  - 其他值视为飞书 file_token，走公开图片代理 */
export function imageUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  if (/^https?:\/\//.test(value)) return value;
  return `/api/v1/homepage-config/image/${encodeURIComponent(value)}`;
}
