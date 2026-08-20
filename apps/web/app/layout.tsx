import type { Metadata } from 'next';
import './globals.css';
import AppShellGate from '../components/AppShellGate';

export const metadata: Metadata = {
  title: 'ACMS — Arete College Management System',
  description: '学院运营管理系统',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <AppShellGate>{children}</AppShellGate>
      </body>
    </html>
  );
}
