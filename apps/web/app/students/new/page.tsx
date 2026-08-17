'use client';

import { useState } from 'react';
import Link from 'next/link';
import { StudentForm } from '../../../components/StudentForm';

export default function NewStudentPage() {
  const [msg, setMsg] = useState('');

  // 表单内部已负责建记录/上传；此处仅作保存后的提示（不跳转，便于立即上传照片与附件）
  const handleSubmit = () => {
    setMsg('已创建学生档案，可继续上传照片与附件，或完善信息后再次保存。');
  };

  return (
    <div>
      <div className="page-header">
        <div className="page-header-row">
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-md)' }}>
            <Link href="/students" className="btn btn-icon" title="返回列表">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18"><path d="m15 18-6-6 6-6"/></svg>
            </Link>
            <div>
              <div className="page-eyebrow">STUDENT / NEW</div>
              <h1 className="page-title">新建学生档案</h1>
            </div>
          </div>
        </div>
      </div>

      {msg && <p className="msg-success">{msg}</p>}

      <StudentForm onSubmit={handleSubmit} />
    </div>
  );
}
