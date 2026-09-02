'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { api } from '../../../lib/api';

const btn = (primary = false): React.CSSProperties => ({
  background: primary ? 'var(--accent)' : 'transparent',
  color: primary ? 'var(--fg-on-accent)' : 'var(--text)',
  border: primary ? 'none' : '1px solid var(--border)',
  borderRadius: 8,
  padding: '6px 12px',
  cursor: 'pointer',
  fontSize: 13,
});

type Usage = {
  rangeDays: number;
  asOf: number;
  summary: { totalRequests: number; totalTokens: number; inputTokens: number; outputTokens: number; modelsUsed: number; activeUsers: number };
  byModel: { provider: string; model: string; requests: number; totalTokens: number; share: number; rank: number }[];
  trend: { date: string; requests: number; totalTokens: number }[];
  byUser: { openId: string; name: string; requests: number; totalTokens: number }[];
};

export default function AiAdminPage() {
  const t = useTranslations('ai.admin');
  const [usage, setUsage] = useState<Usage | null>(null);
  const [audit, setAudit] = useState<Record<string, unknown>[]>([]);
  const [range, setRange] = useState(30);
  const [tab, setTab] = useState<'usage' | 'audit'>('usage');

  async function loadUsage() {
    try { setUsage((await api.aiUsage(range)) as Usage); } catch (e) { alert(e instanceof Error ? e.message : String(e)); }
  }
  async function loadAudit() {
    try { setAudit((await api.aiAudit(200)) as Record<string, unknown>[]); } catch (e) { alert(e instanceof Error ? e.message : String(e)); }
  }
  useEffect(() => { loadUsage(); loadAudit(); }, []);

  const card: React.CSSProperties = { background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 10, padding: 16, flex: 1, minWidth: 140 };

  return (
    <div style={{ padding: 16 }}>
      <h2 style={{ margin: '0 0 4px' }}>{t('title')}</h2>
      <small style={{ color: 'var(--text-muted)' }}>{t('subtitle')}</small>

      <div style={{ display: 'flex', gap: 8, margin: '16px 0' }}>
        <button style={tab === 'usage' ? btn(true) : btn()} onClick={() => setTab('usage')}>{t('tabUsage')}</button>
        <button style={tab === 'audit' ? btn(true) : btn()} onClick={() => setTab('audit')}>{t('tabAudit')}</button>
        {tab === 'usage' && (
          <>
            <select style={{ ...btn(), marginLeft: 'auto' }} value={range} onChange={(e) => { setRange(Number(e.target.value)); }}>
              <option value={7}>{t('range7')}</option>
              <option value={30}>{t('range30')}</option>
              <option value={90}>{t('range90')}</option>
            </select>
            <button style={btn()} onClick={loadUsage}>{t('refresh')}</button>
          </>
        )}
      </div>

      {tab === 'usage' && (
        <div>
          {usage && (
            <>
              <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
                <div style={card}><div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('reqCount')}</div><div style={{ fontSize: 24, fontWeight: 700 }}>{usage.summary.totalRequests}</div></div>
                <div style={card}><div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('totalTokens')}</div><div style={{ fontSize: 24, fontWeight: 700 }}>{usage.summary.totalTokens.toLocaleString()}</div></div>
                <div style={card}><div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('inOut')}</div><div style={{ fontSize: 24, fontWeight: 700 }}>{usage.summary.inputTokens.toLocaleString()} / {usage.summary.outputTokens.toLocaleString()}</div></div>
                <div style={card}><div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('modelsUsers')}</div><div style={{ fontSize: 24, fontWeight: 700 }}>{usage.summary.modelsUsed} / {usage.summary.activeUsers}</div></div>
              </div>

              <h4>{t('byModel')}</h4>
              <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead><tr style={{ background: 'var(--bg-tertiary)', textAlign: 'left' }}>
                    <th style={{ padding: 10 }}>{t('colModel')}</th><th style={{ padding: 10 }}>{t('colRequests')}</th><th style={{ padding: 10 }}>{t('colTokens')}</th><th style={{ padding: 10 }}>{t('colShare')}</th>
                  </tr></thead>
                  <tbody>
                    {usage.byModel.map((m, i) => (
                      <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                        <td style={{ padding: 10 }}>{m.provider} / {m.model}</td>
                        <td style={{ padding: 10 }}>{m.requests}</td>
                        <td style={{ padding: 10 }}>{m.totalTokens.toLocaleString()}</td>
                        <td style={{ padding: 10 }}>{m.share}%</td>
                      </tr>
                    ))}
                    {usage.byModel.length === 0 && <tr><td colSpan={4} style={{ padding: 16, textAlign: 'center', color: 'var(--text-muted)' }}>{t('noData')}</td></tr>}
                  </tbody>
                </table>
              </div>

              <h4>{t('byUser')}</h4>
              <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead><tr style={{ background: 'var(--bg-tertiary)', textAlign: 'left' }}>
                    <th style={{ padding: 10 }}>{t('colUser')}</th><th style={{ padding: 10 }}>{t('colRequests')}</th><th style={{ padding: 10 }}>{t('colTokens')}</th>
                  </tr></thead>
                  <tbody>
                    {usage.byUser.map((u, i) => (
                      <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                        <td style={{ padding: 10 }}>{u.name || u.openId}</td>
                        <td style={{ padding: 10 }}>{u.requests}</td>
                        <td style={{ padding: 10 }}>{u.totalTokens.toLocaleString()}</td>
                      </tr>
                    ))}
                    {usage.byUser.length === 0 && <tr><td colSpan={3} style={{ padding: 16, textAlign: 'center', color: 'var(--text-muted)' }}>{t('noData')}</td></tr>}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {tab === 'audit' && (
        <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr style={{ background: 'var(--bg-tertiary)', textAlign: 'left' }}>
              <th style={{ padding: 10 }}>{t('colTime')}</th><th style={{ padding: 10 }}>{t('colActor')}</th><th style={{ padding: 10 }}>{t('colAction')}</th><th style={{ padding: 10 }}>{t('colTarget')}</th>
            </tr></thead>
            <tbody>
              {audit.map((a, i) => (
                <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ padding: 10 }}>{String(a.ts || '').slice(0, 19)}</td>
                  <td style={{ padding: 10 }}>{String(a.actor || '')}</td>
                  <td style={{ padding: 10 }}>{String(a.action || '')}</td>
                  <td style={{ padding: 10 }}>{String(a.target || '')}</td>
                </tr>
              ))}
              {audit.length === 0 && <tr><td colSpan={4} style={{ padding: 16, textAlign: 'center', color: 'var(--text-muted)' }}>{t('noAudit')}</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
