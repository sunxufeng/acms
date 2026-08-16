import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'ACMS',
  description: 'Arete College Management System',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
