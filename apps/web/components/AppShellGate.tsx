'use client';

import { usePathname } from 'next/navigation';
import AppShell from './AppShell';
import { type DashboardTheme } from '@acms/contracts';

/**
 * 登录页是独立全屏页面，不应套用侧边栏 AppShell（否则 AppShell 会在未登录态
 * 调用 getPermissions，触发 401 自刷新死循环）。家长 H5（/parent）与学生自助门户
 * （/portal）同样独立渲染，不依赖飞书登录态。学生网页登录（/student-login）也独立。
 * 其余页面统一走 AppShell。
 */
const STANDALONE = ['/login', '/parent', '/portal', '/student-login'];

export default function AppShellGate({
  children,
  initialDashboardTheme,
}: {
  children: React.ReactNode;
  initialDashboardTheme?: DashboardTheme | null;
}) {
  const pathname = usePathname();
  if (STANDALONE.includes(pathname)) return <>{children}</>;
  return <AppShell initialDashboardTheme={initialDashboardTheme}>{children}</AppShell>;
}
