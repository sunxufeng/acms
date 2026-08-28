import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import './globals.css';
import AppShellGate from '../components/AppShellGate';
import { type DashboardTheme } from '@acms/contracts';

export const metadata: Metadata = {
  title: 'ACMS — Arete College Management System',
  description: '学院运营管理系统',
};

// 中英文靠 NEXT_LOCALE cookie 在「请求期」决定；必须强制动态渲染，
// 否则 next build 会把页面静态预渲染、把 locale 在构建期定死为 zh，
// 运行期切换 cookie 不再触发重渲染（表现为「切英文仍是中文」）。
export const dynamic = 'force-dynamic';

// SSR 阶段读取工作台主题，作为 AppShell 的初值下传，避免进入工作台时先闪一下
// 默认深色调、再切到已配置主题（FOUC）。服务端 fetch 必须用绝对地址。
const API_ORIGIN = process.env.API_ORIGIN || 'http://localhost:3000';

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const messages = await getMessages();
  let initialDashboardTheme: DashboardTheme | null = null;
  try {
    const res = await fetch(`${API_ORIGIN}/api/v1/homepage-config`, { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      if (data?.dashboardTheme) initialDashboardTheme = data.dashboardTheme;
    }
  } catch {
    // 接口不可用时回退到默认主题
  }

  return (
    <html lang={locale}>
      <body>
        <NextIntlClientProvider locale={locale} messages={messages}>
          <AppShellGate initialDashboardTheme={initialDashboardTheme}>{children}</AppShellGate>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
