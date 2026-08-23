'use client';

import { useEffect, useState } from 'react';
import { DEFAULT_HOMEPAGE_CONFIG, type HomepageConfig } from '@acms/contracts';
import LoginShell from './LoginShell';

export default function LoginPage() {
  const [config, setConfig] = useState<HomepageConfig>(DEFAULT_HOMEPAGE_CONFIG);

  useEffect(() => {
    // If already authenticated, redirect to dashboard
    fetch('/api/v1/auth/me', { credentials: 'include' })
      .then((r) => {
        if (r.ok) window.location.href = '/';
      })
      .catch(() => {});

    // Load homepage configuration (public endpoint)
    fetch('/api/v1/homepage-config', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) setConfig({ ...DEFAULT_HOMEPAGE_CONFIG, ...d });
      })
      .catch(() => {});
  }, []);

  return <LoginShell config={config} />;
}
