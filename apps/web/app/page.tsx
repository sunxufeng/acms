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

  useEffect(() => {
    fetch('/api/v1/auth/me', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setMe(d))
      .catch(() => setMe(null))
      .finally(() => setLoading(false));
  }, []);

  return (
    <main style={{ maxWidth: 720, margin: '80px auto', padding: '0 16px' }}>
      <h1 style={{ fontSize: 24, marginBottom: 8 }}>ACMS</h1>
      <p style={{ color: 'var(--muted)', marginBottom: 24 }}>Arete College Management System</p>
      {loading ? (
        <p>加载中…</p>
      ) : me ? (
        <div>
          <p>已登录：{me.name || me.openId}</p>
          <p>角色：{me.roles.length ? me.roles.join('、') : '（未分配，M1 接用户表后生效）'}</p>
          <a href="/api/v1/auth/logout" style={{ color: 'var(--brand)' }}>退出登录</a>
        </div>
      ) : (
        <a
          href="/api/v1/auth/login"
          style={{
            display: 'inline-block',
            padding: '10px 24px',
            background: 'var(--brand)',
            color: '#fff',
            borderRadius: 8,
            textDecoration: 'none',
          }}
        >
          飞书登录
        </a>
      )}
    </main>
  );
}
