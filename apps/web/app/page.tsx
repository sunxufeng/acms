'use client';

import { useEffect, useState } from 'react';

interface Me {
  name: string;
  openId: string;
  roles: string[];
}

export default function Home() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    fetch('/api/v1/auth/me', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setMe(d))
      .catch(() => setMe(null))
      .finally(() => setLoading(false));
  }, []);

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await fetch('/api/v1/auth/logout', { method: 'POST', credentials: 'include' });
    } catch {
      // 忽略网络错误，仍跳转登录页
    } finally {
      window.location.href = '/login';
    }
  }

  if (loading) {
    return (
      <main style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
        <p style={{ color: 'var(--muted)' }}>加载中…</p>
      </main>
    );
  }

  if (!me) {
    // Redirect to login page
    if (typeof window !== 'undefined') {
      window.location.href = '/login';
    }
    return null;
  }

  return (
    <main style={{ maxWidth: 720, margin: '80px auto', padding: '0 16px' }}>
      <h1 style={{ fontSize: 24, marginBottom: 8 }}>ACMS 工作台</h1>
      <p style={{ color: 'var(--muted)', marginBottom: 24 }}>Arete College Management System</p>
      <div style={{ marginBottom: 24, padding: 20, border: '1px solid var(--border)', borderRadius: 12 }}>
        <p style={{ marginBottom: 8 }}>已登录：{me.name || me.openId}</p>
        <p style={{ color: 'var(--muted)' }}>角色：{me.roles.length ? me.roles.join('、') : '（未分配，M1 接用户表后生效）'}</p>
      </div>
      <a
        href="/students"
        style={{
          display: 'block',
          padding: '18px 20px',
          border: '1px solid var(--border)',
          borderRadius: 12,
          textDecoration: 'none',
          color: 'var(--fg)',
          background: '#fff',
          marginBottom: 16,
        }}
      >
        <strong style={{ fontSize: 16 }}>学生管理</strong>
        <span style={{ display: 'block', color: 'var(--muted)', fontSize: 13, marginTop: 4 }}>
          学生档案 CRUD、列表筛选、归档恢复、数据导出
        </span>
      </a>
      <button
        onClick={handleLogout}
        disabled={loggingOut}
        style={{
          background: 'none',
          border: 'none',
          padding: 0,
          color: 'var(--brand)',
          cursor: 'pointer',
          fontSize: 16,
        }}
      >
        {loggingOut ? '退出中…' : '退出登录'}
      </button>
    </main>
  );
}

