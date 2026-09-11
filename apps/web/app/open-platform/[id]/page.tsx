'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { api } from '../../../lib/api';
import { COLUMNS } from '../columns';
import CrudView from '../../../components/CrudView';

export default function OpenPlatformAppDetailPage() {
  const t = useTranslations('common');
  const params = useParams();
  const router = useRouter();
  const id = String(params.id);
  const [record, setRecord] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true);
    setError('');
    api
      .getOpenPlatformApp(id)
      .then((data) => setRecord(data))
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading)
    return (
      <div className="empty-state" style={{ minHeight: '50vh' }}>
        <div
          style={{
            width: 28,
            height: 28,
            border: '3px solid var(--border)',
            borderTopColor: 'var(--accent)',
            borderRadius: '50%',
            animation: 'spin 0.7s linear infinite',
          }}
        />
      </div>
    );
  if (error) return <div className="page-header"><p className="msg-error">加载失败：{error}</p></div>;
  if (!record) return <div className="page-header"><p style={{ color: 'var(--fg-tertiary)' }}>记录不存在</p></div>;

  return (
    <div>
      <div className="page-header">
        <div className="page-header-row">
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-lg)' }}>
            <Link href="/open-platform" className="btn btn-icon" title="返回列表">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18"><path d="m15 18-6-6 6-6" /></svg>
            </Link>
            <div>
              <div className="page-eyebrow">OPEN-PLATFORM / {String(record['系统来源'] ?? '')}</div>
              <h1 className="page-title">应用详情 · {String(record['应用名称'] ?? id.slice(0, 6))}</h1>
              <p className="page-subtitle">凭证类字段仅显示掩码，需在列表页编辑时重新输入</p>
            </div>
          </div>
          <div className="page-actions">
            <button className="btn btn-outline btn-sm" onClick={() => router.push('/open-platform')}>{t('backToList')}</button>
          </div>
        </div>
      </div>

      <CrudView columns={COLUMNS} record={record} />
    </div>
  );
}
