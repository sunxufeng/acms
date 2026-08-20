'use client';

import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';

const btn = (primary = false): React.CSSProperties => ({
  background: primary ? 'var(--accent)' : 'transparent',
  color: primary ? '#fff' : 'var(--text)',
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
      <h2 style={{ margin: '0 0 4px' }}>AI 用量与审计</h2>
      <small style={{ color: 'var(--text-muted)' }}>模型调用统计与 AI 域操作审计（仅管理员可见）。</small>

      <div style={{ display: 'flex', gap: 8, margin: '16px 0' }}>
        <button style={tab === 'usage' ? btn(true) : btn()} onClick={() => setTab('usage')}>用量统计</button>
        <button style={tab === 'audit' ? btn(true) : btn()} onClick={() => setTab('audit')}>审计日志</button>
        {tab === 'usage' && (
          <>
            <select style={{ ...btn(), marginLeft: 'auto' }} value={range} onChange={(e) => { setRange(Number(e.target.value)); }}>
              <option value={7}>近 7 天</option>
              <option value={30}>近 30 天</option>
              <option value={90}>近 90 天</option>
            </select>
            <button style={btn()} onClick={loadUsage}>刷新</button>
          </>
        )}
      </div>

      {tab === 'usage' && (
        <div>
          {usage && (
            <>
              <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
                <div style={card}><div style={{ fontSize: 12, color: 'var(--text-muted)' }}>请求数</div><div style={{ fontSize: 24, fontWeight: 700 }}>{usage.summary.totalRequests}</div></div>
                <div style={card}><div style={{ fontSize: 12, color: 'var(--text-muted)' }}>总 Token</div><div style={{ fontSize: 24, fontWeight: 700 }}>{usage.summary.totalTokens.toLocaleString()}</div></div>
                <div style={card}><div style={{ fontSize: 12, color: 'var(--text-muted)' }}>输入 / 输出</div><div style={{ fontSize: 24, fontWeight: 700 }}>{usage.summary.inputTokens.toLocaleString()} / {usage.summary.outputTokens.toLocaleString()}</div></div>
                <div style={card}><div style={{ fontSize: 12, color: 'var(--text-muted)' }}>模型数 / 活跃用户</div><div style={{ fontSize: 24, fontWeight: 700 }}>{usage.summary.modelsUsed} / {usage.summary.activeUsers}</div></div>
              </div>

              <h4>按模型</h4>
              <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead><tr style={{ background: 'var(--bg-tertiary)', textAlign: 'left' }}>
                    <th style={{ padding: 10 }}>模型</th><th style={{ padding: 10 }}>请求</th><th style={{ padding: 10 }}>Token</th><th style={{ padding: 10 }}>占比</th>
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
                    {usage.byModel.length === 0 && <tr><td colSpan={4} style={{ padding: 16, textAlign: 'center', color: 'var(--text-muted)' }}>暂无数据</td></tr>}
                  </tbody>
                </table>
              </div>

              <h4>按用户</h4>
              <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead><tr style={{ background: 'var(--bg-tertiary)', textAlign: 'left' }}>
                    <th style={{ padding: 10 }}>用户</th><th style={{ padding: 10 }}>请求</th><th style={{ padding: 10 }}>Token</th>
                  </tr></thead>
                  <tbody>
                    {usage.byUser.map((u, i) => (
                      <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                        <td style={{ padding: 10 }}>{u.name || u.openId}</td>
                        <td style={{ padding: 10 }}>{u.requests}</td>
                        <td style={{ padding: 10 }}>{u.totalTokens.toLocaleString()}</td>
                      </tr>
                    ))}
                    {usage.byUser.length === 0 && <tr><td colSpan={3} style={{ padding: 16, textAlign: 'center', color: 'var(--text-muted)' }}>暂无数据</td></tr>}
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
              <th style={{ padding: 10 }}>时间</th><th style={{ padding: 10 }}>操作人</th><th style={{ padding: 10 }}>动作</th><th style={{ padding: 10 }}>目标</th>
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
              {audit.length === 0 && <tr><td colSpan={4} style={{ padding: 16, textAlign: 'center', color: 'var(--text-muted)' }}>暂无审计记录</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
