'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ApiConfigForm } from '../ApiConfigForm';

export default function NewApiConfigPage() {
  const router = useRouter();

  return (
    <div>
      <div className="page-header">
        <div className="page-header-row">
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-md)' }}>
            <Link href="/ai/config" className="btn btn-icon" title="返回列表">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18"><path d="m15 18-6-6 6-6" /></svg>
            </Link>
            <div>
              <div className="page-eyebrow">CREATE / API 设置</div>
              <h1 className="page-title">新增 API 配置</h1>
            </div>
          </div>
        </div>
      </div>
      <ApiConfigForm onDone={() => router.push('/ai/config')} />
    </div>
  );
}
