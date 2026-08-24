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
  label: string;
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
  /** 分组显示名 */
  label: string;
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

/** 默认导航菜单（与当前 AppShell 硬编码菜单保持一致，用于回退） */
export const DEFAULT_NAV_MENU_CONFIG: NavMenuConfig = {
  items: [
    { key: 'dashboard', label: '概览', href: '/', icon: 'dashboard', section: '工作台', order: 10 },

    { key: 'students', label: '学生档案', href: '/students', icon: 'students', section: '业务管理', order: 10 },
    { key: 'courses', label: '课程方案', href: '/courses', icon: 'courses', section: '业务管理', order: 20 },
    { key: 'teaching', label: '教学班级', href: '/teaching-classes', icon: 'courses', section: '业务管理', order: 30 },
    { key: 'schedule', label: '排课课次', href: '/schedule', icon: 'schedule', section: '业务管理', order: 40 },
    { key: 'portal', label: '学生门户', href: '/portal', icon: 'students', section: '业务管理', order: 50 },

    { key: 'student360', label: '学生全景', href: '/student-360', icon: 'students', section: '学生闭环', order: 10 },
    { key: 'sourceFollowups', label: '招生跟进', href: '/source-followups', icon: 'admissions', section: '学生闭环', order: 20 },
    { key: 'studentAttendances', label: '学生考勤', href: '/student-attendances', icon: 'students', section: '学生闭环', order: 30 },
    { key: 'grades', label: '学业成绩', href: '/grades', icon: 'courses', section: '学生闭环', order: 40 },
    { key: 'practiceActivities', label: '实践活动', href: '/practice-activities', icon: 'students', section: '学生闭环', order: 50 },
    { key: 'homeSchoolComms', label: '家校沟通', href: '/home-school-comms', icon: 'notifications', section: '学生闭环', order: 60 },
    { key: 'dailyFollowups', label: '日常跟进', href: '/daily-followups', icon: 'notifications', section: '学生闭环', order: 70 },
    { key: 'idpPlans', label: 'IDP管理', href: '/idp-plans', icon: 'target', section: '学生闭环', order: 75 },
    { key: 'stageEvaluations', label: '阶段评价', href: '/stage-evaluations', icon: 'students', section: '学生闭环', order: 80 },
    { key: 'alumniFollowups', label: '校友跟进', href: '/alumni-followups', icon: 'students', section: '学生闭环', order: 90 },

    { key: 'teachers', label: '教师档案', href: '/teachers', icon: 'teachers', section: '教师管理', order: 10 },
    { key: 'attendance', label: '教师履约', href: '/attendance', icon: 'teachers', section: '教师管理', order: 20 },
    { key: 'billing', label: '计费结算', href: '/billing', icon: 'billing', section: '教师管理', order: 30 },
    { key: 'settlements', label: '月度结算', href: '/settlements', icon: 'billing', section: '教师管理', order: 40 },
    { key: 'adjustments', label: '调整冲销', href: '/adjustments', icon: 'billing', section: '教师管理', order: 50 },
    { key: 'partnerships', label: '聘用合作', href: '/partnerships', icon: 'teachers', section: '教师管理', order: 60 },

    { key: 'aiChat', label: 'AI 对话', href: '/ai/chat', icon: 'chat', section: '智能助手', order: 10 },
    { key: 'aiConfig', label: 'AI 设置', href: '/ai/config', icon: 'config', section: '智能助手', order: 20 },
    { key: 'aiAgents', label: 'Bot管理', href: '/ai/agents', icon: 'bot', section: '智能助手', order: 30, perm: 'ai:config' },
    { key: 'aiSkills', label: '技能管理', href: '/ai/skills', icon: 'skill', section: '智能助手', order: 40, perm: 'ai:admin' },
    { key: 'aiAutomations', label: '定时任务', href: '/ai/automations', icon: 'clock', section: '智能助手', order: 50, perm: 'ai:automation' },
    { key: 'aiAdmin', label: 'AI 用量', href: '/ai/admin', icon: 'chart', section: '智能助手', order: 60, perm: 'ai:admin' },

    { key: 'dictionary', label: '字典数据', href: '/dictionaries', icon: 'dictionary', section: '后台管理', order: 10 },
    { key: 'export', label: '数据导出', href: '/export', icon: 'reports', section: '后台管理', order: 20 },
    { key: 'audit-logs', label: '审计日志', href: '/audit-logs', icon: 'audit', section: '后台管理', order: 30 },
    { key: 'users', label: '用户管理', href: '/users', icon: 'userGroup', section: '后台管理', order: 40, adminOnly: true },
    { key: 'permissions', label: '权限授权', href: '/permissions', icon: 'shield', section: '后台管理', order: 50, adminOnly: true },
    { key: 'notifications', label: '通知任务', href: '/notifications', icon: 'notifications', section: '后台管理', order: 60 },
    { key: 'notification-templates', label: '通知模板', href: '/notification-templates', icon: 'notifications', section: '后台管理', order: 70 },
    { key: 'settings', label: '系统设置', href: '/settings', icon: 'settings', section: '后台管理', order: 80 },
    { key: 'attendance-zones', label: '考勤围栏', href: '/attendance-zones', icon: 'settings', section: '后台管理', order: 90 },
    { key: 'wechat-bindings', label: '微信用户', href: '/wechat-bindings', icon: 'userGroup', section: '后台管理', order: 100, adminOnly: true },
    { key: 'homepage-management', label: '主页管理', href: '/homepage-management', icon: 'settings', section: '后台管理', order: 105, adminOnly: true },
    { key: 'homepage-settings', label: '首页管理', href: '/homepage-settings', icon: 'settings', section: '后台管理', order: 110, adminOnly: true },
    { key: 'menu-settings', label: '菜单管理', href: '/menu-settings', icon: 'dictionary', section: '后台管理', order: 120, adminOnly: true },
    { key: 'menu-groups-settings', label: '菜单分组', href: '/menu-groups-settings', icon: 'list', section: '后台管理', order: 122, adminOnly: true },
    { key: 'student-users', label: '学生账号', href: '/student-users', icon: 'user', section: '后台管理', order: 130, adminOnly: true, perm: 'admin:studentUser' },
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
