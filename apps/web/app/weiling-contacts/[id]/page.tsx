'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { api } from '../../../lib/api';
import { COLUMNS, DETAIL_GROUPS, fmtTs } from '../columns';

type FieldDesc = {
  api_name: string;
  view_name: string;
  options?: { label: string; value: string }[];
};

export default function WeilingContactDetailPage() {
  const t = useTranslations('common');
  const params = useParams();
  const router = useRouter();
  const id = String(params.id);
  const [record, setRecord] = useState<Record<string, unknown> | null>(null);
  const [fields, setFields] = useState<FieldDesc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true);
    setError('');
    Promise.all([api.getWeilingContact(id), api.weilingFields().catch(() => [] as FieldDesc[])])
      .then(([data, fs]) => {
        setRecord(data);
        setFields(fs ?? []);
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [id]);

  // api_name → 中文名 / 枚举值 → 文案
  const dict = useMemo(() => {
    const name = new Map<string, string>();
    const opt = new Map<string, Map<string, string>>();
    for (const f of fields) {
      name.set(f.api_name, f.view_name);
      if (f.options?.length) {
        opt.set(f.api_name, new Map(f.options.map((o) => [String(o.value), o.label])));
      }
    }
    return { name, opt };
  }, [fields]);

  // 自定义字段（contact_custom）翻译：缩写键 → 中文名；枚举数字 → 文案
  const customRows = useMemo(() => {
    const raw = String(record?.['自定义字段'] ?? '');
    if (!raw) return [];
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      return Object.entries(obj).map(([k, v]) => {
        const label = dict.name.get(k) ?? k;
        let text = String(v ?? '');
        const m = dict.opt.get(k);
        if (m) {
          const vals = Array.isArray(v) ? v : [v];
          text = vals.map((x) => m.get(String(x)) ?? String(x)).join('、');
        }
        return { key: k, label, text };
      });
    } catch {
      return [];
    }
  }, [record, dict]);

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

  const labelOf = (k: string) => COLUMNS.find((c) => c.key === k)?.label ?? k;
  const isTs = (k: string) => /时间$/.test(k);
  const val = (k: string) => (isTs(k) ? fmtTs(record[k]) : String(record[k] ?? '—') || '—');

  return (
    <div>
      <div className="page-header">
        <div className="page-header-row">
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-lg)' }}>
            <Link href="/weiling-contacts" className="btn btn-icon" title="返回列表">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18"><path d="m15 18-6-6 6-6" /></svg>
            </Link>
            <div>
              <div className="page-eyebrow">WEILING CONTACT / {String(record['客户阶段'] ?? '')}</div>
              <h1 className="page-title">{String(record['联系人姓名'] ?? '联系人详情')}</h1>
              <p className="page-subtitle">
                归属 {String(record['归属人'] ?? '—')} · 来源 {String(record['来源渠道'] ?? '—')} · 只读
              </p>
            </div>
          </div>
          <div className="page-actions">
            <button className="btn btn-outline btn-sm" onClick={() => router.push('/weiling-contacts')}>{t('backToList')}</button>
          </div>
        </div>
      </div>

      {DETAIL_GROUPS.map((g) => (
        <div key={g.title} style={{ marginBottom: '1.5rem' }}>
          <h2 style={{ fontSize: 'var(--font-md)', fontWeight: 600, margin: '0 0 0.75rem' }}>{g.title}</h2>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
              gap: '12px 24px',
              padding: '16px',
              background: 'var(--bg-elevated, #fff)',
              border: '1px solid var(--border)',
              borderRadius: 10,
            }}
          >
            {g.keys.map((k) => (
              <div key={k} style={{ minWidth: 0 }}>
                <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)', marginBottom: 2 }}>{labelOf(k)}</div>
                <div style={{ fontSize: 'var(--font-sm)', wordBreak: 'break-all' }}>{val(k)}</div>
              </div>
            ))}
          </div>
        </div>
      ))}

      {customRows.length > 0 ? (
        <div style={{ marginBottom: '1.5rem' }}>
          <h2 style={{ fontSize: 'var(--font-md)', fontWeight: 600, margin: '0 0 0.75rem' }}>自定义字段</h2>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
              gap: '12px 24px',
              padding: '16px',
              background: 'var(--bg-elevated, #fff)',
              border: '1px solid var(--border)',
              borderRadius: 10,
            }}
          >
            {customRows.map((r) => (
              <div key={r.key} style={{ minWidth: 0 }}>
                <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)', marginBottom: 2 }}>
                  {r.label}
                  <span style={{ opacity: 0.6 }}> · {r.key}</span>
                </div>
                <div style={{ fontSize: 'var(--font-sm)', wordBreak: 'break-all' }}>{r.text || '—'}</div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
