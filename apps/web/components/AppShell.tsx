'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { api } from '../lib/api';

interface Me {
  name: string;
  openId: string;
  roles: string[];
}

const NAV_ITEMS = [
  {
    section: '工作台',
    items: [
      { key: 'dashboard', label: '概览', href: '/', icon: DashboardIcon },
    ],
  },
  {
    section: '业务域',
    items: [
      { key: 'students', label: '学生档案', href: '/students', icon: StudentsIcon },
      { key: 'courses', label: '课程教学', href: '/courses', icon: CoursesIcon },
      { key: 'teaching', label: '教学班级', href: '/teaching-classes', icon: CoursesIcon },
      { key: 'schedule', label: '排课课次', href: '/schedule', icon: ScheduleIcon },
      { key: 'portal', label: '学生门户', href: '/portal', icon: StudentsIcon },
    ],
  },
  {
    section: 'AI 助手',
    items: [
      { key: 'aiChat', label: 'AI 对话', href: '/ai/chat', icon: AIIcon },
      { key: 'aiConfig', label: 'AI 设置', href: '/ai/config', icon: AIIcon },
      { key: 'aiAgents', label: 'Bot管理', href: '/ai/agents', icon: AIIcon, perm: 'ai:config' },
      { key: 'aiSkills', label: '技能管理', href: '/ai/skills', icon: AIIcon, perm: 'ai:admin' },
      { key: 'aiAutomations', label: '定时任务', href: '/ai/automations', icon: AIIcon, perm: 'ai:automation' },
      { key: 'aiAdmin', label: 'AI 用量', href: '/ai/admin', icon: AIIcon, perm: 'ai:admin' },
    ],
  },
  {
    section: '学生全生命周期',
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
    section: '管理',
    items: [
      { key: 'teachers', label: '教师档案', href: '/teachers', icon: TeachersIcon },
      { key: 'attendance', label: '教师履约', href: '/attendance', icon: TeachersIcon },
      { key: 'billing', label: '计费结算', href: '/billing', icon: BillingIcon },
      { key: 'settlements', label: '月度结算', href: '/settlements', icon: BillingIcon },
      { key: 'adjustments', label: '调整冲销', href: '/adjustments', icon: BillingIcon },
      { key: 'partnerships', label: '聘用合作', href: '/partnerships', icon: TeachersIcon },
      { key: 'notifications', label: '通知任务', href: '/notifications', icon: NotificationsIcon },
      { key: 'dictionary', label: '字典数据', href: '/dictionaries', icon: DictionaryIcon },
      { key: 'export', label: '数据导出', href: '/export', icon: ReportsIcon },
      { key: 'settings', label: '系统设置', href: '/settings', icon: SettingsIcon },
      { key: 'audit-logs', label: '审计日志', href: '/audit-logs', icon: AuditIcon },
      { key: 'users', label: '用户管理', href: '/users', icon: UserGroupIcon, adminOnly: true },
      { key: 'permissions', label: '权限授权', href: '/permissions', icon: ShieldIcon, adminOnly: true },
    ],
  },
];

function initial(name: string): string {
  if (!name) return '?';
  // Take first character of Chinese name or first letter of English
  const ch = name.charAt(0);
  return /[\u4e00-\u9fa5]/.test(ch) ? ch : name.split(/\s+/).map(s => s[0]).join('').slice(0, 2).toUpperCase();
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [myPerms, setMyPerms] = useState<string[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [loggingOut, setLoggingOut] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');

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
    setTheme(t);
    document.documentElement.setAttribute('data-theme', t);
  }, []);

  function toggleTheme() {
    const next = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('acms-theme', next);
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
    return pathname.startsWith(href);
  };

  const isAdmin = !!me?.roles?.includes('系统管理员');

  return (
    <div className="app-shell">
      {/* ── Sidebar ─────────────────────────────── */}
      <aside className={`sidebar${sidebarOpen ? '' : ' collapsed'}`}>
        <div className="sidebar-header">
          <img src="/logo.png" alt="Arete" className="sidebar-logo" style={{ objectFit: 'contain', padding: 2, background: 'var(--bg-primary)' }} />
          <div className="sidebar-brand">
            <strong>ARETE</strong>
            <small>COLLEGE OPS</small>
          </div>
          <button className="sidebar-collapse-btn" onClick={toggleSidebar} title={sidebarOpen ? '收起侧边栏' : '展开侧边栏'}>
            {sidebarOpen ? <ChevronLeftIcon /> : <ChevronRightIcon />}
          </button>
        </div>

        <nav className="sidebar-nav">
          {NAV_ITEMS.map((group) => {
            if (group.items.length === 0) return null;
            return (
              <div key={group.section}>
                <div className="sidebar-section-label">{group.section}</div>
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const it = item as { adminOnly?: boolean; perm?: string };
                  if (it.adminOnly && !isAdmin) return null;
                  if (it.perm && !(myPerms || []).includes(it.perm)) return null;
                  if ((item as { disabled?: boolean }).disabled) {
                    return (
                      <div key={item.key} className="nav-item nav-item--disabled" title="敬请期待">
                        <span className="nav-icon"><Icon /></span>
                        <span>{item.label}</span>
                        <span className="nav-soon">敬请期待</span>
                      </div>
                    );
                  }
                  const active = isActive(item.href);
                  return (
                    <Link key={item.key} href={item.href} className={`nav-item${active ? ' active' : ''}`}>
                      <span className="nav-icon"><Icon /></span>
                      <span>{item.label}</span>
                    </Link>
                  );
                })}
              </div>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <button className="nav-item" onClick={() => router.push('/permissions')}>
            <span className="nav-icon"><ShieldIcon /></span>
            <span>用户与权限</span>
          </button>
        </div>
      </aside>

      {/* ── Main area ──────────────────────────── */}
      <div className="main-area">
        {/* Top bar */}
        <header className="topbar">
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
                <span style={{ fontSize: 'var(--font-sm)', color: 'var(--fg-secondary)' }}>{me.name}</span>
                <div className="user-chip">
                  <span className="user-avatar-xs">{initial(me.name)}</span>
                  <span>{me.roles[0] || '用户'}</span>
                </div>
              </>
            )}
            <button className="theme-toggle" onClick={toggleTheme} title={theme === 'light' ? '切换深色模式' : '切换浅色模式'}>
              {theme === 'light' ? <SunIcon /> : <MoonIcon />}
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
function AIIcon() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a4 4 0 0 1 4 4v2a4 4 0 0 1-8 0V6a4 4 0 0 1 4-4z"/><path d="M12 12v10"/><path d="M8 22h8"/></svg>);
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
function ChevronRightIcon() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>);
}
