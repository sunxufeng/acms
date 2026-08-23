'use client';

import { usePathname } from 'next/navigation';
import AppShell from './AppShell';

/**
 * 登录页是独立全屏页面，不应套用侧边栏 AppShell（否则 AppShell 会在未登录态
 * 调用 getPermissions，触发 401 自刷新死循环）。家长 H5（/parent）同样独立渲染，
 * 不依赖飞书登录态。其余页面统一走 AppShell。
 */
const STANDALONE = ['/login', '/parent'];

export default function AppShellGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (STANDALONE.includes(pathname)) return <>{children}</>;
  return <AppShell>{children}</AppShell>;
}
