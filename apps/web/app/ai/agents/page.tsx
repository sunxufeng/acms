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

  // Determine binding status display
  function bindingStatus(agent: Agent) {
    if (agent.provider) return { text: '已绑定', color: '#10b981' };
    return { text: '未绑定', color: 'var(--text-muted)' };
  }

  return (
    <div>
      <div className="page-header">
        <div className="page-header-row">
          <div>
            <h1 className="page-title" style={{ margin: 0 }}>智能体配置</h1>
            <p className="page-subtitle" style={{ margin: '4px 0 0' }}>创建 / 编辑智能体并绑定飞书应用</p>
          </div>
          <Link href="/ai/agents/new" className="btn btn-primary">＋ 新建智能体</Link>
        </div>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 8 }}>
          创建管理智能体（含人设三段 IDENTITY / USER / SOUL），可绑定飞书自建应用，实现「每个智能体对应一个飞书机器人」。
        </p>
      </div>

      {error && <p className="msg-error" style={{ marginBottom: 16 }}>{error}</p>}
      {loading ? <div className="empty-state">加载中…</div> : (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ width: '20%' }}>名称</th>
                <th style={{ width: '12%' }}>组织</th>
                <th style={{ width: '14%' }}>绑定飞书</th>
                <th style={{ width: '18%' }}>更新时间</th>
                <th style={{ width: '36%' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {agents.length === 0 && (
                <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--fg-tertiary)', padding: 40 }}>暂无智能体，点击右上角「新建智能体」开始</td></tr>
              )}
              {agents.map((agent) => {
                const bind = bindingStatus(agent);
                return (
                  <tr key={agent.id}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <strong>{agent.name}</strong>
                        {agent.emoji && <span>{agent.emoji}</span>}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{agent.owner || '组织'}</div>
                    </td>
                    <td><span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{agent.owner || '—'}</span></td>
                    <td>
                      <span style={{
                        display: 'inline-block',
                        padding: '2px 10px',
                        borderRadius: 12,
                        fontSize: 12,
                        background: `${bind.color}15`,
                        color: bind.color,
                      }}>
                        {bind.text}
                      </span>
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                      {agent.updatedAt ? new Date(agent.updatedAt).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour12: false }) : '—'}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <Link href={`/ai/chat?agentId=${agent.id}`} className="btn btn-outline btn-sm">开启对话</Link>
                        <Link href={`/ai/agents/${agent.id}/edit`} className="btn btn-outline btn-sm">编辑</Link>
                        <button
                          className="btn btn-outline btn-sm"
                          onClick={() => alert(`绑定飞书功能：在编辑页填写飞书应用 App ID / Secret，即可让该智能体以独立机器人身份推送消息`)}
                          title="查看/绑定飞书"
                        >
                          绑定飞书
                        </button>
                        <button className="btn btn-danger btn-sm" onClick={() => remove(agent)}>删除</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
