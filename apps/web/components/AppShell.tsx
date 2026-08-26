'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { api } from '../lib/api';
import { imageUrl, type DashboardTheme, type NavMenuConfig, type NavMenuGroupConfig, type NavMenuItem, DEFAULT_NAV_MENU_CONFIG } from '@acms/contracts';

interface Me {
  name: string;
  openId: string;
  roles: string[];
}

/** 图标名称 → 组件（与 NavMenuItem.icon 对应） */
export const ICONS: Record<string, () => ReactNode> = {
  dashboard: DashboardIcon,
  students: StudentsIcon,
  admissions: AdmissionsIcon,
  courses: CoursesIcon,
  schedule: ScheduleIcon,
  teachers: TeachersIcon,
  notifications: NotificationsIcon,
  chat: ChatIcon,
  config: ConfigIcon,
  bot: BotIcon,
  skill: SkillIcon,
  clock: ClockIcon,
  chart: ChartIcon,
  billing: BillingIcon,
  audit: AuditIcon,
  system: SystemIcon,
  integration: IntegrationIcon,
  userGroup: UserGroupIcon,
  shield: ShieldIcon,
  dictionary: DictionaryIcon,
  reports: ReportsIcon,
  settings: SettingsIcon,
  // 新增同风格图标（B6）
  user: UserIcon,
  key: KeyIcon,
  lock: LockIcon,
  location: LocationIcon,
  calendar: CalendarIcon,
  file: FileIcon,
  folder: FolderIcon,
  star: StarIcon,
  check: CheckIcon,
  book: BookIcon,
  graduation: GraduationIcon,
  mail: MailIcon,
  phone: PhoneIcon,
  list: ListIcon,
  grid: GridIcon,
  target: TargetIcon,
  wallet: WalletIcon,
  award: AwardIcon,
  flag: FlagIcon,
  compass: CompassIcon,
};

/** 历史硬编码菜单（配置读取失败时回退） */
type LegacyNavItem = { key: string; label: string; href: string; icon: () => ReactNode; perm?: string; adminOnly?: boolean; disabled?: boolean };
type LegacyNavSubsection = { title: string; items: LegacyNavItem[] };
type LegacyNavGroup = { section: string; items: LegacyNavItem[]; subsections?: LegacyNavSubsection[] };

const LEGACY_NAV_ITEMS: LegacyNavGroup[] = [
  {
    section: '工作台',
    items: [
      { key: 'dashboard', label: '概览', href: '/', icon: DashboardIcon },
    ],
  },
  {
    section: '业务管理',
    items: [
      { key: 'students', label: '学生档案', href: '/students', icon: StudentsIcon },
      { key: 'courses', label: '课程方案', href: '/courses', icon: CoursesIcon },
      { key: 'teaching', label: '教学班级', href: '/teaching-classes', icon: CoursesIcon },
      { key: 'schedule', label: '排课课次', href: '/schedule', icon: ScheduleIcon },
      { key: 'portal', label: '学生门户', href: '/portal', icon: StudentsIcon },
    ],
  },
  {
    section: '学生闭环',
    items: [
      { key: 'student360', label: '学生全景', href: '/student-360', icon: StudentsIcon },
      { key: 'sourceFollowups', label: '招生跟进', href: '/source-followups', icon: AdmissionsIcon },
      { key: 'studentAttendances', label: '学生考勤', href: '/student-attendances', icon: StudentsIcon },
      { key: 'grades', label: '学业成绩', href: '/grades', icon: CoursesIcon },
      { key: 'practiceActivities', label: '实践活动', href: '/practice-activities', icon: StudentsIcon },
      { key: 'homeSchoolComms', label: '家校沟通', href: '/home-school-comms', icon: NotificationsIcon },
      { key: 'dailyFollowups', label: '日常跟进', href: '/daily-followups', icon: NotificationsIcon },
      { key: 'stageEvaluations', label: '阶段评价', href: '/stage-evaluations', icon: StudentsIcon },
      { key: 'alumniFollowups', label: '校友跟进', href: '/alumni-followups', icon: StudentsIcon },
    ],
  },
  {
    section: '教师管理',
    items: [
      { key: 'teachers', label: '教师档案', href: '/teachers', icon: TeachersIcon },
      { key: 'attendance', label: '教师履约', href: '/attendance', icon: TeachersIcon },
      { key: 'billing', label: '计费结算', href: '/billing', icon: BillingIcon },
      { key: 'settlements', label: '月度结算', href: '/settlements', icon: BillingIcon },
      { key: 'adjustments', label: '调整冲销', href: '/adjustments', icon: BillingIcon },
      { key: 'partnerships', label: '聘用合作', href: '/partnerships', icon: TeachersIcon },
    ],
  },
  {
    section: '智能助手',
    items: [
      { key: 'aiChat', label: 'AI 对话', href: '/ai/chat', icon: ChatIcon },
      { key: 'aiConfig', label: 'AI 设置', href: '/ai/config', icon: ConfigIcon },
      { key: 'aiAgents', label: 'Bot管理', href: '/ai/agents', icon: BotIcon, perm: 'ai:config' },
      { key: 'aiSkills', label: '技能管理', href: '/ai/skills', icon: SkillIcon, perm: 'ai:admin' },
      { key: 'aiAutomations', label: '定时任务', href: '/ai/automations', icon: ClockIcon, perm: 'ai:automation' },
      { key: 'aiAdmin', label: 'AI 用量', href: '/ai/admin', icon: ChartIcon, perm: 'ai:admin' },
    ],
  },
  {
    section: '后台管理',
    items: [
      { key: 'dictionary', label: '字典数据', href: '/dictionaries', icon: DictionaryIcon },
      { key: 'export', label: '数据导出', href: '/export', icon: ReportsIcon },
      { key: 'audit-logs', label: '审计日志', href: '/audit-logs', icon: AuditIcon },
      { key: 'users', label: '用户管理', href: '/users', icon: UserGroupIcon, adminOnly: true },
      { key: 'permissions', label: '权限授权', href: '/permissions', icon: ShieldIcon, adminOnly: true },
      { key: 'notifications', label: '通知任务', href: '/notifications', icon: NotificationsIcon },
      { key: 'notification-templates', label: '通知模板', href: '/notification-templates', icon: NotificationsIcon },
      { key: 'settings', label: '系统设置', href: '/settings', icon: SettingsIcon },
      { key: 'attendance-zones', label: '考勤围栏', href: '/attendance-zones', icon: SettingsIcon },
      { key: 'wechat-bindings', label: '微信用户', href: '/wechat-bindings', icon: UserGroupIcon, adminOnly: true },
      { key: 'homepage-management', label: '工作台主题', href: '/homepage-management', icon: SettingsIcon, adminOnly: true },
      { key: 'homepage-settings', label: '登录页配置', href: '/homepage-settings', icon: SettingsIcon, adminOnly: true },
      { key: 'menu-settings', label: '菜单管理', href: '/menu-settings', icon: DictionaryIcon, adminOnly: true },
    ],
  },
];

function themeCssVars(t: DashboardTheme | null): React.CSSProperties {
  if (!t) return {};
  return {
    '--sidebar-bg': t.sidebarBgColor,
    '--sidebar-hover': t.sidebarHoverBgColor,
    '--sidebar-active': t.sidebarActiveBgColor,
    '--sidebar-fg': t.sidebarTextColor,
    '--sidebar-fg-secondary': t.sidebarTextColor,
    '--sidebar-fg-tertiary': t.sidebarSectionColor,
    '--topbar-chip-border': t.sidebarBorderColor,
    '--sidebar-width': t.sidebarWidth ? `${t.sidebarWidth}px` : undefined,
    '--topbar-bg': t.headerBgColor,
    '--topbar-fg': t.headerTextColor,
    '--topbar-fg-secondary': t.headerTextColor,
    '--topbar-fg-tertiary': t.headerTextColor,
    '--content-bg': t.mainBgColor,
  } as React.CSSProperties;
}

function initial(name: string): string {
  if (!name) return '?';
  // Take first character of Chinese name or first letter of English
  const ch = name.charAt(0);
  return /[\u4e00-\u9fa5]/.test(ch) ? ch : name.split(/\s+/).map(s => s[0]).join('').slice(0, 2).toUpperCase();
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [me, setMe] = useState<Me | null>(null);
  const [myPerms, setMyPerms] = useState<string[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [loggingOut, setLoggingOut] = useState(false);
  const [themeMode, setThemeMode] = useState<'light' | 'dark'>('dark');
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({});
  const [dashboardTheme, setDashboardTheme] = useState<DashboardTheme | null>(null);
  const [menuConfig, setMenuConfig] = useState<NavMenuConfig>(DEFAULT_NAV_MENU_CONFIG);
  const [menuGroups, setMenuGroups] = useState<NavMenuGroupConfig | null>(null);
  const [logoError, setLogoError] = useState(false);

  // Sidebar: init from localStorage
  useEffect(() => {
    const saved = localStorage.getItem('acms-sidebar');
    if (saved === 'collapsed') setSidebarOpen(false);
  }, []);

  function toggleSidebar() {
    const next = !sidebarOpen;
    setSidebarOpen(next);
    localStorage.setItem('acms-sidebar', next ? 'expanded' : 'collapsed');
  }

  // Theme: init from localStorage → apply data-theme to <html>
  useEffect(() => {
    const saved = localStorage.getItem('acms-theme') as 'light' | 'dark' | null;
    const t = saved || 'dark';
    setThemeMode(t);
    document.documentElement.setAttribute('data-theme', t);
  }, []);

  function toggleTheme() {
    const next = themeMode === 'light' ? 'dark' : 'light';
    setThemeMode(next);
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('acms-theme', next);
  }

  // Load dashboard theme + menu config
  useEffect(() => {
    fetch('/api/v1/homepage-config', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.dashboardTheme) setDashboardTheme(d.dashboardTheme);
      })
      .catch(() => null);
    api.getMenuConfig()
      .then((d) => {
        if (d?.items?.length) setMenuConfig(d);
      })
      .catch(() => null);
    api.getMenuGroups()
      .then((d) => setMenuGroups(d))
      .catch(() => null);
  }, []);

  // 侧边栏大类折叠：默认全部收起；若当前路径命中某大类，则自动展开该类
  useEffect(() => {
    const saved = localStorage.getItem('acms-nav-sections');
    let initial: Record<string, boolean> = {};
    try {
      initial = saved ? JSON.parse(saved) : {};
    } catch { /* ignore */ }

    navGroups.forEach((g) => {
      if (initial[g.section] === undefined) {
        initial[g.section] = false;
      }
    });

    const activeSection = navGroups.find((g) =>
      g.items.some((it) => isActive(it.href)) ||
      g.items.some((it) => childrenMap[it.key]?.some((c) => isActive(c.href))),
    );
    if (activeSection && initial[activeSection.section] === false) {
      initial[activeSection.section] = true;
    }

    setExpandedSections(initial);
  }, []);

  useEffect(() => {
    const activeSection = navGroups.find((g) =>
      g.items.some((it) => isActive(it.href)) ||
      g.items.some((it) => childrenMap[it.key]?.some((c) => isActive(c.href))),
    );
    if (activeSection && !expandedSections[activeSection.section]) {
      toggleSection(activeSection.section, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  function toggleSection(section: string, force?: boolean) {
    setExpandedSections((prev) => {
      const next = { ...prev, [section]: force !== undefined ? force : !prev[section] };
      localStorage.setItem('acms-nav-sections', JSON.stringify(next));
      return next;
    });
  }

  useEffect(() => {
    fetch('/api/v1/auth/me', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setMe(d))
      .catch(() => null);
    api.getPermissions()
      .then((p) => setMyPerms(p.myPermissions || []))
      .catch(() => null);
  }, []);

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await fetch('/api/v1/auth/logout', { method: 'POST', credentials: 'include' });
    } catch { /* ignore */ }
    window.location.href = '/login';
  }

  const isActive = (href: string) => {
    if (href === '/') return pathname === '/';
    // Boundary match: exact path or a nested path (href + '/').
    // Without the '/' boundary, '/attendance-zones' would wrongly match
    // the '/attendance' (教师履约) menu because it is a prefix.
    return pathname === href || pathname.startsWith(href + '/');
  };

  const isAdmin = !!me?.roles?.includes('系统管理员');

  // Build navigable menu groups from config
  const sortedItems = menuConfig.items.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const childrenMap: Record<string, NavMenuItem[]> = {};
  sortedItems.forEach((it) => {
    if (it.parentKey) {
      if (!childrenMap[it.parentKey]) childrenMap[it.parentKey] = [];
      childrenMap[it.parentKey].push(it);
    }
  });
  const sectionsMap: Record<string, NavMenuItem[]> = {};
  sortedItems.forEach((it) => {
    if (it.parentKey) return;
    const section = it.section || '其他';
    if (!sectionsMap[section]) sectionsMap[section] = [];
    sectionsMap[section].push(it);
  });
  const navGroups = Object.entries(sectionsMap).map(([section, items]) => ({ section, items }));

  // 侧边栏「分组（大类）」顺序以菜单分组配置为准；未配置分组则维持原顺序。
  const groupOrder = new Map<string, number>();
  for (const g of menuGroups?.items ?? []) {
    if (g.order != null) {
      groupOrder.set(g.key, g.order);
      groupOrder.set(g.label, g.order);
    }
  }
  const navGroupsSorted = navGroups.slice().sort((a, b) => {
    const oa = groupOrder.has(a.section) ? (groupOrder.get(a.section) as number) : Number.MAX_SAFE_INTEGER;
    const ob = groupOrder.has(b.section) ? (groupOrder.get(b.section) as number) : Number.MAX_SAFE_INTEGER;
    return oa - ob;
  });

  // Theme-derived values
  const sidebarStyle = themeCssVars(dashboardTheme);
  const sidebarLogoUrl = dashboardTheme?.logoUrl ? imageUrl(dashboardTheme.logoUrl) : '/logo.png';
  const sidebarBrandName = dashboardTheme?.brandName || 'ARETE';
  const sidebarBrandSubtitle = dashboardTheme?.brandSubtitle || 'COLLEGE OPS';

  return (
    <div className="app-shell">
      {/* ── Sidebar ─────────────────────────────── */}
      <aside className={`sidebar${sidebarOpen ? '' : ' collapsed'}`} style={sidebarStyle}>
        <div className="sidebar-header">
          {dashboardTheme?.logoUrl && !logoError ? (
            <img
              src={sidebarLogoUrl}
              alt={sidebarBrandName}
              className="sidebar-logo"
              style={{ objectFit: 'contain', padding: 2, background: 'transparent' }}
              onError={() => setLogoError(true)}
            />
          ) : (
            <div className="sidebar-logo">{sidebarBrandName.charAt(0).toUpperCase()}</div>
          )}
          <div className="sidebar-brand">
            <strong>{sidebarBrandName}</strong>
            <small>{sidebarBrandSubtitle}</small>
          </div>
          <button className="sidebar-collapse-btn" onClick={toggleSidebar} title={sidebarOpen ? '收起侧边栏' : '展开侧边栏'}>
            {sidebarOpen ? <ChevronLeftIcon /> : <ChevronRightIcon />}
          </button>
        </div>

        <nav className="sidebar-nav">
          {navGroupsSorted.map((group) => {
            if (group.items.length === 0) return null;
            const expanded = expandedSections[group.section] ?? false;
            const renderItem = (item: NavMenuItem) => {
              const Icon = ICONS[item.icon] ?? (() => null);
              if (item.adminOnly && !isAdmin) return null;
              if (item.perm && !(myPerms || []).includes(item.perm)) return null;
              if (item.disabled) {
                return (
                  <div key={item.key} className="nav-item nav-item--disabled" title="敬请期待">
                    <span className="nav-icon"><Icon /></span>
                    <span>{item.label}</span>
                    <span className="nav-soon">敬请期待</span>
                  </div>
                );
              }
              const active = isActive(item.href);
              const children = childrenMap[item.key];
              return (
                <div key={item.key} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <Link href={item.href} className={`nav-item${active ? ' active' : ''}`}>
                    <span className="nav-icon"><Icon /></span>
                    <span>{item.label}</span>
                  </Link>
                  {children && children.length > 0 && (
                    <div style={{ paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 2 }}>
                      {children.map(renderItem)}
                    </div>
                  )}
                </div>
              );
            };
            return (
              <div key={group.section} className={`sidebar-section${expanded ? ' expanded' : ''}`}>
                <button
                  type="button"
                  className="sidebar-section-header"
                  onClick={() => toggleSection(group.section)}
                  aria-expanded={expanded}
                >
                  <span className="sidebar-section-label">{group.section}</span>
                  <span className="sidebar-section-chevron">{expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}</span>
                </button>
                <div className="sidebar-section-items">
                {(!sidebarOpen || expanded) && (
                  <>
                    {group.items.map(renderItem)}
                  </>
                )}
                </div>
              </div>
            );
          })}
        </nav>
      </aside>

      {/* ── Main area ──────────────────────────── */}
      <div className="main-area">
        {/* Top bar */}
        <header className="topbar" style={sidebarStyle}>
          <div className="topbar-left">
            <button className="btn-icon" onClick={() => setSidebarOpen(!sidebarOpen)} aria-label="切换侧边栏">
              <MenuIcon />
            </button>
            <span className="topbar-breadcrumb">主校区 <span>/</span> {breadcrumbLabel(pathname)}</span>
            <div className="topbar-divider" />
            <div className="topbar-search">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
              <span>全局搜索尚未接入</span>
            </div>
          </div>
          <div className="topbar-right">
            {me && (
              <>
                <span style={{ fontSize: 'var(--font-sm)', color: 'var(--topbar-fg-secondary)' }}>{me.name}</span>
                <div className="user-chip">
                  <span className="user-avatar-xs">{initial(me.name)}</span>
                  <span>{me.roles[0] || '用户'}</span>
                </div>
              </>
            )}
            <button className="theme-toggle" onClick={toggleTheme} title={themeMode === 'light' ? '切换深色模式' : '切换浅色模式'}>
              {themeMode === 'light' ? <SunIcon /> : <MoonIcon />}
            </button>
            <button className="btn-icon" onClick={handleLogout} title="退出登录" disabled={loggingOut}>
              <LogoutIcon />
            </button>
          </div>
        </header>

        {/* Page content */}
        <div className="page-content">
          {children}
        </div>
      </div>
    </div>
  );
}

/* ── Breadcrumb helper ─────────────────────────── */

function breadcrumbLabel(path: string): string {
  if (path === '/') return '工作台';
  if (path.startsWith('/users')) return '用户管理';
  if (path.startsWith('/permissions')) return '权限授权';
  if (path.startsWith('/wechat-bindings')) return '微信用户';
  if (path.startsWith('/homepage-management')) return '工作台主题';
  if (path.startsWith('/homepage-settings')) return '登录页配置';
  if (path.startsWith('/menu-settings')) return '菜单管理';
  if (path.startsWith('/notification-templates')) return '通知模板';
  if (path.startsWith('/students')) {
    if (path === '/students/new') return '新建学生';
    if (/\/students\/[^/]+$/.test(path)) return '学生详情';
    return '学生档案';
  }
  return path.slice(1);
}

/* ── SVG Icons ─────────────────────────────────── */

function DashboardIcon() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>);
}
function StudentsIcon() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>);
}
function AdmissionsIcon() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>);
}
function CoursesIcon() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>);
}
function ScheduleIcon() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>);
}
function TeachersIcon() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>);
}
function NotificationsIcon() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>);
}
function ChatIcon() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>);
}
function ConfigIcon() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>);
}
function BotIcon() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"/><path d="M12 11V7a4 4 0 0 1 4-4h0"/><circle cx="8.5" cy="15.5" r="1.5"/><circle cx="15.5" cy="15.5" r="1.5"/><path d="M12 21v-2"/></svg>);
}
function SkillIcon() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>);
}
function ClockIcon() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>);
}
function ChartIcon() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>);
}
function BillingIcon() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>);
}
function AuditIcon() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>);
}
function SystemIcon() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>);
}
function IntegrationIcon() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>);
}
function UserGroupIcon() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>);
}
function ShieldIcon() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>);
}
function DictionaryIcon() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/></svg>);
}
function ReportsIcon() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18"/><rect x="7" y="11" width="3" height="6"/><rect x="12" y="7" width="3" height="10"/><rect x="17" y="13" width="3" height="4"/></svg>);
}
function SettingsIcon() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>);
}
function LogoutIcon() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>);
}
function MenuIcon() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>);
}
function SunIcon() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>);
}
function MoonIcon() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>);
}
function ChevronLeftIcon() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>);
}
function ChevronDownIcon() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>);
}
function ChevronRightIcon() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>);
}
function UserIcon() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>);
}
function KeyIcon() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3"/></svg>);
}
function LockIcon() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>);
}
function LocationIcon() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>);
}
function CalendarIcon() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>);
}
function FileIcon() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>);
}
function FolderIcon() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>);
}
function StarIcon() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>);
}
function CheckIcon() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>);
}
function BookIcon() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>);
}
function GraduationIcon() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/></svg>);
}
function MailIcon() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 5L2 7"/></svg>);
}
function PhoneIcon() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/></svg>);
}
function ListIcon() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>);
}
function GridIcon() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>);
}
function TargetIcon() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>);
}
function WalletIcon() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4z"/></svg>);
}
function AwardIcon() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="7"/><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"/></svg>);
}
function FlagIcon() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>);
}
function CompassIcon() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg>);
}
