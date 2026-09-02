'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { api } from '../../../lib/api';
import BalanceWheel, { type WheelDim } from '../../../components/idp/BalanceWheel';
import CommunicationManager from '../../../components/idp/CommunicationManager';
import { useTl } from '../../../lib/useTl';
import { useTranslations } from 'next-intl';

interface Goal { title: string; areas: string[]; importance: number; urgency: number; meaning: number; measures: string[]; note: string }
interface Phase { no: string; node: string; result: string }
interface Att { file_token: string; name: string }

function str(v: unknown): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : String((x as { text?: string })?.text ?? ''))).join('、');
  if (typeof v === 'object') return String((v as { text?: string })?.text ?? '');
  return String(v);
}
function parseJSON<T>(v: unknown, fallback: T): T {
  if (typeof v === 'string' && v.trim()) {
    try { const p = JSON.parse(v); if (p) return p as T; } catch { /* ignore */ }
  }
  return fallback;
}
function attachmentFiles(v: unknown): Att[] {
  if (Array.isArray(v)) return v as Att[];
  if (typeof v === 'string' && v.trim()) {
    try { const p = JSON.parse(v); if (Array.isArray(p)) return p as Att[]; } catch { /* ignore */ }
  }
  return [];
}

function InfoItem({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>{label}</span>
      <span style={{ fontWeight: 500 }}>{value || '—'}</span>
    </div>
  );
}

export default function IdpPlanDetailPage() {
  const t = useTranslations('common');
  const ti = useTranslations('idp');
  const tl = useTl();
  const params = useParams<{ id: string }>();
  const [plan, setPlan] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    api.getIdpPlan(params.id)
      .then((p) => setPlan(p))
      .catch((e) => setError(e instanceof Error ? e.message : '加载失败'))
      .finally(() => setLoading(false));
  }, [params.id]);

  if (loading) return <div className="empty-state">{t('loading')}</div>;
  if (error) return <div className="empty-state" style={{ color: 'var(--danger)' }}>错误：{error}</div>;
  if (!plan) return <div className="empty-state">{ti('idpPlanNotFound')}</div>;

  const wheel: WheelDim[] = parseJSON<WheelDim[]>(plan['人生平衡轮'], []);
  const goals: Goal[] = parseJSON<Goal[]>(plan['目标列表'], []);
  const phases: Phase[] = parseJSON<Phase[]>(plan['阶段成果'], []);
  const atts: Att[] = attachmentFiles(plan['原始文档']);

  return (
    <div className="page">
      <div className="page-header page-header-row">
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-lg)' }}>
          <Link href="/idp-plans" className="btn btn-icon" title="返回列表">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18"><path d="m15 18-6-6 6-6" /></svg>
          </Link>
          <div>
            <div className="page-eyebrow">IDP / DETAIL</div>
            <h1 className="page-title">IDP 方案详情</h1>
            <p className="page-subtitle">{str(plan['关联学生'])} · {str(plan['学期'])} · {str(plan['状态']) || '草稿'}</p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <Link className="btn btn-outline" href={`/idp-plans/${params.id}/edit`}>{t('edit')}</Link>
        </div>
      </div>

      <div style={{ border: '1px solid var(--border)', background: 'var(--bg-elevated)', borderRadius: 12, padding: 18, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 16, marginBottom: 18 }}>
        <InfoItem label="学生" value={str(plan['关联学生'])} />
        <InfoItem label="学期" value={str(plan['学期'])} />
        <InfoItem label="导师" value={str(plan['导师'])} />
        <InfoItem label="状态" value={str(plan['状态']) || '草稿'} />
        <InfoItem label="制定日期" value={str(plan['制定日期'])} />
        <InfoItem label="展示方式" value={str(plan['展示方式'])} />
      </div>

      <section style={{ border: '1px solid var(--border)', background: 'var(--bg-elevated)', borderRadius: 12, padding: 18, marginBottom: 18 }}>
        <h2 style={{ marginTop: 0, fontSize: 'var(--font-lg)' }}>{ti('balanceWheel')}</h2>
        {wheel.length ? <BalanceWheel dims={wheel} /> : <div className="muted">{ti('notProvided')}</div>}
      </section>

      <section style={{ border: '1px solid var(--border)', background: 'var(--bg-elevated)', borderRadius: 12, padding: 18, marginBottom: 18 }}>
        <h2 style={{ marginTop: 0, fontSize: 'var(--font-lg)' }}>{ti('goalsSection')}</h2>
        {goals.length === 0 ? <div className="muted">{ti('goalsEmpty')}</div> : (
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th style={{ width: 50 }}>#</th><th>{ti('goal')}</th><th>{ti('domain')}</th><th>{ti('importance')}</th><th>{ti('urgent')}</th><th>{ti('meaning')}</th><th>{ti('measure')}</th><th>{ti('otherNote')}</th></tr></thead>
              <tbody>
                {goals.map((g, i) => (
                  <tr key={i}>
                    <td>{i + 1}</td>
                    <td>{g.title || '—'}</td>
                    <td>{(Array.isArray(g.areas) ? g.areas.join('、') : g.areas) || '—'}</td>
                    <td>{g.importance ? '★'.repeat(g.importance) : '—'}</td>
                    <td>{g.urgency ? '★'.repeat(g.urgency) : '—'}</td>
                    <td>{g.meaning ? '★'.repeat(g.meaning) : '—'}</td>
                    <td>{g.measures?.join('、') || '—'}</td>
                    <td style={{ whiteSpace: 'pre-wrap' }}>{g.note || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section style={{ border: '1px solid var(--border)', background: 'var(--bg-elevated)', borderRadius: 12, padding: 18, marginBottom: 18 }}>
        <h2 style={{ marginTop: 0, fontSize: 'var(--font-lg)' }}>{ti('phaseTitle')}</h2>
        {phases.length === 0 ? <div className="muted">{ti('notProvided')}</div> : (
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th style={{ width: 80 }}>{ti('phaseNo')}</th><th>{ti('timeNode')}</th><th>{ti('expectedResult')}</th></tr></thead>
              <tbody>
                {phases.map((p, i) => (
                  <tr key={i}><td>{p.no || i + 1}</td><td>{p.node || '—'}</td><td>{p.result || '—'}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section style={{ border: '1px solid var(--border)', background: 'var(--bg-elevated)', borderRadius: 12, padding: 18, marginBottom: 18 }}>
        <h2 style={{ marginTop: 0, fontSize: 'var(--font-lg)' }}>{ti('roadshowTitle')}</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 16 }}>
          <InfoItem label="展示方式" value={str(plan['展示方式'])} />
          <InfoItem label="邀请人员" value={str(plan['邀请人员'])} />
          <InfoItem label="学生确认时间" value={str(plan['学生确认时间'])} />
          <InfoItem label="导师确认时间" value={str(plan['导师确认时间'])} />
          <div style={{ gridColumn: '1 / -1' }}><InfoItem label="展示内容" value={str(plan['展示内容'])} /></div>
          <div style={{ gridColumn: '1 / -1' }}><InfoItem label="展示亮点" value={str(plan['展示亮点'])} /></div>
        </div>
      </section>

      <section style={{ border: '1px solid var(--border)', background: 'var(--bg-elevated)', borderRadius: 12, padding: 18, marginBottom: 18 }}>
        <h2 style={{ marginTop: 0, fontSize: 'var(--font-lg)' }}>{tl('原始文档')}</h2>
        {atts.length === 0 ? <div className="muted">{ti('notUploaded')}</div> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {atts.map((a, i) => (
              <a key={a.file_token ?? i} href={`/api/v1/files/${a.file_token}`} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>{a.name}</a>
            ))}
          </div>
        )}
      </section>

      <section id="communications" style={{ border: '1px solid var(--border)', background: 'var(--bg-elevated)', borderRadius: 12, padding: 18 }}>
        <CommunicationManager planId={params.id} />
      </section>
    </div>
  );
}
