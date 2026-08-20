'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AgentForm } from '../AgentForm';

export default function NewAgentPage() {
  const router = useRouter();
  return (
    <div>
      <div className="page-header"><div className="page-header-row"><div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-md)' }}><Link href="/ai/agents" className="btn btn-icon" title="返回列表"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18"><path d="m15 18-6-6 6-6" /></svg></Link><div><div className="page-eyebrow">CREATE / 智能体配置</div><h1 className="page-title">新建智能体</h1></div></div></div></div>
      <AgentForm onDone={() => router.push('/ai/agents')} />
    </div>
  );
}
