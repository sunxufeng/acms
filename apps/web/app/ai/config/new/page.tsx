'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ApiConfigForm } from '../ApiConfigForm';

export default function NewApiConfigPage() {
  const router = useRouter();

  return (
    <div className="page">
      <div className="page-header page-header-row">
        <div>
          <div className="page-eyebrow">CREATE / API 设置</div>
          <h1 className="page-title">新增 API 配置</h1>
        </div>
        <div className="page-actions">
          <Link href="/ai/config" className="btn btn-ghost">取消</Link>
          <button type="submit" form="api-config-form" className="btn btn-primary">保存</button>
        </div>
      </div>
      <ApiConfigForm onDone={() => router.push('/ai/config')} />
    </div>
  );
}
