'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AutomationForm } from '../AutomationForm';

export default function NewAutomationPage() {
  const router = useRouter();

  return (
    <div className="page">
      <div className="page-header page-header-row">
        <div>
          <div className="page-eyebrow">CREATE / 自动化任务</div>
          <h1 className="page-title">新建自动化任务</h1>
        </div>
        <div className="page-actions">
          <Link href="/ai/automations" className="btn btn-ghost">取消</Link>
          <button type="submit" form="automation-form" className="btn btn-primary">保存</button>
        </div>
      </div>

      <AutomationForm onDone={() => router.push('/ai/automations')} />
    </div>
  );
}
