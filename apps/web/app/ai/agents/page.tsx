'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '../../../lib/api';
import type { Agent } from './AgentForm';

export default function AiAgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  async function load() {
    setLoading(true);
    try {
      setAgents(await api.aiListAgents() as Agent[]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function remove(agent: Agent) {
    if (!agent.id || !confirm(`确认删除智能体「${agent.name}」？`)) return;
    try {
      await api.aiDeleteAgent(agent.id);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div>
      <div className="page-header">
        <div className="page-header-row">
          <div>
            <div className="page-eyebrow">AI / AGENTS</div>
            <h1 className="page-title">智能体配置</h1>
            <p className="page-subtitle">管理智能体的人设、可用工具和模型绑定。</p>
          </div>
          <Link href="/ai/agents/new" className="btn btn-primary">＋ 新建智能体</Link>
        </div>
      </div>

      {error && <p className="msg-error" style={{ marginBottom: 16 }}>{error}</p>}
      {loading ? <div className="empty-state">加载中…</div> : (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead><tr><th>智能体</th><th>描述</th><th>Provider / Model</th><th>工具</th><th>更新时间</th><th>操作</th></tr></thead>
            <tbody>
              {agents.length === 0 && <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--fg-tertiary)' }}>暂无智能体</td></tr>}
              {agents.map((agent) => (
                <tr key={agent.id}>
                  <td><strong>{agent.emoji || 'AI'} {agent.name}</strong></td>
                  <td>{agent.description || '—'}</td>
                  <td>{agent.provider || '—'} / {agent.model || '—'}</td>
                  <td>{agent.toolList?.length ? `${agent.toolList.length} 项` : '全部'}</td>
                  <td>{agent.updatedAt ? new Date(agent.updatedAt).toLocaleString('zh-CN', { hour12: false }) : '—'}</td>
                  <td><div style={{ display: 'flex', gap: 8 }}><Link href={`/ai/agents/${agent.id}/edit`} className="btn btn-outline btn-sm">编辑</Link><button className="btn btn-danger btn-sm" onClick={() => remove(agent)}>删除</button></div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
