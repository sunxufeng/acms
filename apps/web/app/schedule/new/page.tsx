'use client';

import { useState } from 'react';
import Link from 'next/link';
import { SessionForm } from '../../../components/SessionForm';

export default function NewSessionPage() {
  const [msg, setMsg] = useState('');

  const handleSubmit = () => {
    setMsg('已创建课次，可继续在「课次列表」中调整状态或删除。');
  };

  return (
    <div>
      <div className="page-header">
        <div className="page-header-row">
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-md)' }}>
            <Link href="/schedule" className="btn btn-icon" title="返回列表">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18"><path d="m15 18-6-6 6-6" /></svg>
            </Link>
            <div>
              <div className="page-eyebrow">CREATE / 课次</div>
              <h1 className="page-title">新建课次</h1>
            </div>
          </div>
        </div>
      </div>

      {msg && <p className="msg-success">{msg}</p>}

      <SessionForm onSubmit={handleSubmit} />
    </div>
  );
}
