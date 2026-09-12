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
        // ⚠️ 卫瓴枚举是 {"label":"1","value":"美国"}：**label 是数字键，value 才是显示文本**
        // （跟直觉相反）。用反了会把枚举显示成「1」而不是「美国」。
        opt.set(f.api_name, new Map(f.options.map((o) => [String(o.label), o.value])));
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

  // 该联系人的跟进记录（按时间倒序）
  const [progress, setProgress] = useState<
    { 跟进时间: number; 跟进人: string; 跟进内容: string; 图片: string; 附件: string }[]
  >([]);
  useEffect(() => {
    if (!record) return;
    api
      .getWeilingProgress(id)
      .then((list) => setProgress(Array.isArray(list) ? list : []))
      .catch(() => setProgress([]));
  }, [id, record]);

  // 卫瓴原始 JSON（41 个字段）：摊平字段只是其中一部分，这里把原始全量也渲染出来，
  // 保证「系统里存的所有信息」都能在详情页查到，而不是只展示同步时挑的那几个。
  const rawEntries = useMemo(() => {
    let obj: Record<string, unknown> = {};
    try {
      obj = JSON.parse(String(record?.['原始数据'] ?? '{}')) as Record<string, unknown>;
    } catch {
      obj = {};
    }
    const isTimeKey = (k: string) => /(_time|_at)$/.test(k) || k === 'create_time';
    return Object.entries(obj)
      .filter(([, v]) => v !== null && v !== '' && !(Array.isArray(v) && v.length === 0))
      .map(([k, v]) => {
        const label = dict.name.get(k) ?? k;
        // 枚举值翻译（卫瓴：label 是数字键、value 是显示文本）
        const m = dict.opt.get(k);
        let text: string;
        if (isTimeKey(k) && (typeof v === 'number' || /^\d+$/.test(String(v)))) {
          text = fmtTs(v);
        } else if (typeof v === 'boolean') {
          text = v ? '是' : '否';
        } else if (m && (typeof v === 'string' || typeof v === 'number')) {
          const vals = Array.isArray(v) ? v : [v];
          text = vals.map((x) => m.get(String(x)) ?? String(x)).join('、');
        } else if (typeof v === 'object') {
          text = JSON.stringify(v);
        } else {
          text = String(v ?? '');
        }
        return { key: k, label, text };
      })
      .sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'));
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
  const isTs = (k: string) => /时间$/.test(k) && k !== '匹配时间';
  const studentId = String(record['关联学生ID'] ?? '');
  const score = Number(record['匹配置信度'] ?? 0);

  const val = (k: string): React.ReactNode => {
    if (isTs(k)) return fmtTs(record[k]);
    // 关联学生：可点进学生档案
    if (k === '关联学生') {
      const name = String(record['关联学生'] ?? '');
      if (!name) return '—';
      return studentId ? (
        <Link href={`/students/${studentId}`} style={{ color: 'var(--accent)', fontWeight: 600 }}>
          {name} →
        </Link>
      ) : (
        name
      );
    }
    if (k === '匹配置信度') {
      if (!score) return '—';
      const text = score >= 90 ? '高' : score >= 70 ? '中' : '低';
      const color = score >= 90 ? '#2c6b45' : score >= 70 ? '#7a5c10' : '#6b6b66';
      return (
        <span style={{ color }}>
          {score}（{text}）
        </span>
      );
    }
    return String(record[k] ?? '') || '—';
  };

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
          <h2 style={{ fontSize: 'var(--font-md)', fontWeight: 600, margin: '0 0 0.75rem' }}>
            {g.title}
            {g.title === '关联匹配' ? (
              <span style={{ marginLeft: 8, fontSize: 'var(--font-xs)', fontWeight: 400, color: 'var(--fg-tertiary)' }}>
                系统按姓名/手机号自动推测，属「疑似」关系，需人工确认
              </span>
            ) : null}
          </h2>
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

      {/* 跟进记录：卫瓴里销售写的跟进内容，按时间倒序 */}
      <div style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ fontSize: 'var(--font-md)', fontWeight: 600, margin: '0 0 0.75rem' }}>
          跟进记录
          <span style={{ marginLeft: 8, fontSize: 'var(--font-xs)', fontWeight: 400, color: 'var(--fg-tertiary)' }}>
            共 {progress.length} 条
          </span>
        </h2>
        {progress.length === 0 ? (
          <div
            style={{
              padding: '16px',
              background: 'var(--bg-elevated, #fff)',
              border: '1px solid var(--border)',
              borderRadius: 10,
              color: 'var(--fg-tertiary)',
              fontSize: 'var(--font-sm)',
            }}
          >
            暂无跟进记录（若卫瓴侧已有跟进，可在列表页点「同步跟进记录」后再看）
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {progress.map((p, i) => (
              <div
                key={i}
                style={{
                  padding: '12px 14px',
                  background: 'var(--bg-elevated, #fff)',
                  border: '1px solid var(--border)',
                  borderRadius: 10,
                  borderLeft: '3px solid var(--accent)',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    gap: 10,
                    alignItems: 'baseline',
                    marginBottom: 6,
                    fontSize: 'var(--font-xs)',
                    color: 'var(--fg-tertiary)',
                  }}
                >
                  <span style={{ fontWeight: 600, color: 'var(--fg-secondary)' }}>{p.跟进人 || '—'}</span>
                  <span>{fmtTs(p.跟进时间)}</span>
                </div>
                <div style={{ fontSize: 'var(--font-sm)', whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>
                  {p.跟进内容 || '—'}
                </div>
                {p.图片 ? (
                  <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {p.图片.split(',').filter(Boolean).map((u) => (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        key={u}
                        src={u}
                        alt="跟进图片"
                        style={{ width: 90, height: 90, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--border)' }}
                      />
                    ))}
                  </div>
                ) : null}
                {p.附件 ? (
                  <div style={{ marginTop: 6, fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>
                    {(() => {
                      try {
                        const arr = JSON.parse(p.附件) as { name?: string; url?: string }[];
                        return arr.map((f, j) => (
                          <a key={j} href={f.url ?? '#'} target="_blank" rel="noreferrer" style={{ marginRight: 10 }}>
                            📎 {f.name || '附件'}
                          </a>
                        ));
                      } catch {
                        return null;
                      }
                    })()}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 卫瓴原始字段全量（保证系统里存的每条信息都能查到） */}
      <div style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ fontSize: 'var(--font-md)', fontWeight: 600, margin: '0 0 0.75rem' }}>
          卫瓴原始字段
          <span style={{ marginLeft: 8, fontSize: 'var(--font-xs)', fontWeight: 400, color: 'var(--fg-tertiary)' }}>
            共 {rawEntries.length} 项（已翻译为中文，空值已隐藏）
          </span>
        </h2>
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
          {rawEntries.map((r) => (
            <div key={r.key} style={{ minWidth: 0 }}>
              <div style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)', marginBottom: 2 }}>
                {r.label}
                <span style={{ opacity: 0.55 }}> · {r.key}</span>
              </div>
              <div
                title={r.text}
                style={{
                  fontSize: 'var(--font-sm)',
                  wordBreak: 'break-all',
                  maxHeight: 60,
                  overflow: 'hidden',
                }}
              >
                {r.text.length > 160 ? `${r.text.slice(0, 160)}…` : r.text || '—'}
              </div>
            </div>
          ))}
        </div>
      </div>

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
