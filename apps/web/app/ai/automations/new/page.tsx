'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AutomationForm } from '../AutomationForm';

export default function NewAutomationPage() {
  const router = useRouter();

  return (
    <div>
      <div className="page-header">
        <div className="page-header-row">
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-md)' }}>
            <Link href="/ai/automations" className="btn btn-icon" title="返回列表">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18"><path d="m15 18-6-6 6-6"/></svg>
            </Link>
            <div>
              <div className="page-eyebrow">CREATE / 自动化任务</div>
              <h1 className="page-title">新建自动化任务</h1>
            </div>
          </div>
        </div>
      </div>

      <AutomationForm onDone={() => router.push('/ai/automations')} />
    </div>
  );
}
