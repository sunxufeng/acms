'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api } from '../../../lib/api';

type Msg = { role: 'user' | 'assistant' | 'system'; content: string };

const wrap: React.CSSProperties = {
  display: 'flex',
  height: 'calc(100vh - 120px)',
  gap: 12,
};
const panel: React.CSSProperties = {
  background: 'var(--bg-secondary)',
  border: '1px solid var(--border)',
  borderRadius: 10,
  overflow: 'hidden',
};
const btn = (primary = false): React.CSSProperties => ({
  background: primary ? 'var(--accent)' : 'transparent',
  color: primary ? '#fff' : 'var(--text)',
  border: primary ? 'none' : '1px solid var(--border)',
  borderRadius: 8,
  padding: '7px 14px',
  cursor: 'pointer',
  fontSize: 13,
});

export default function AiChatPage() {
  const [convs, setConvs] = useState<{ id: string; title: string; updatedAt: string }[]>([]);
  const [agents, setAgents] = useState<{ id: string; name: string; provider?: string; model?: string; emoji?: string }[]>([]);
  const [agentId, setAgentId] = useState('');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.aiListConversations().then(setConvs).catch(() => null);
    // 加载智能体列表，供「选择 Provider/智能体」下拉；无权限（普通用户）时静默降级为仅默认项
    api.aiListAgents().then((list) => setAgents((list as { id: string; name: string; provider?: string; model?: string; emoji?: string }[]) || [])).catch(() => null);
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 1e9, behavior: 'smooth' });
  }, [messages]);

  async function send() {
    const text = input.trim();
    if (!text || sending) return;
    setInput('');
    const next = [...messages, { role: 'user' as const, content: text }];
    setMessages(next);
    setSending(true);
    try {
      const r = await api.aiChat({ message: text, sessionId: sessionId ?? undefined, agentId: agentId || undefined, history: next });
      setMessages([...next, { role: 'assistant' as const, content: r.content }]);
      if (r.sessionId && !sessionId) setSessionId(r.sessionId);
      api.aiListConversations().then(setConvs).catch(() => null);
    } catch (e) {
      setMessages([...next, { role: 'assistant' as const, content: `⚠️ ${e instanceof Error ? e.message : String(e)}` }]);
    } finally {
      setSending(false);
    }
  }

  async function newChat() {
    try {
      const r = await api.aiCreateConversation({ title: '新对话' });
      setSessionId(r.id);
      setMessages([]);
      api.aiListConversations().then(setConvs).catch(() => null);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  }

  async function openConv(id: string) {
    setSessionId(id);
    try {
      const h = await api.aiGetConversation(id);
      setMessages(h as Msg[]);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div style={{ padding: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 10 }}>
          <div>
            <h2 style={{ margin: 0 }}>AI 对话</h2>
            <small style={{ color: 'var(--text-muted)' }}>基于你个人配置的模型网关；未配置则请先在「模型设置」中填写 Provider / API Key / Model。</small>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={{ fontSize: 13, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
              智能体 / Provider
              <select
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                style={{ background: 'var(--bg-tertiary)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 8, padding: '6px 10px', fontSize: 13 }}
              >
                <option value="">个人默认配置</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.emoji ? `${a.emoji} ` : ''}{a.name}（{(a.provider || '—')}{a.model ? ` · ${a.model}` : ''}）
                  </option>
                ))}
              </select>
            </label>
            <button style={btn()} onClick={newChat}>＋ 新对话</button>
            <Link href="/ai/config" style={btn() as React.CSSProperties}>⚙ 模型设置</Link>
          </div>
        </div>

      <div style={wrap}>
        {/* 会话列表 */}
        <div style={{ ...panel, width: 240, flexShrink: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)', fontWeight: 600, fontSize: 13 }}>对话历史</div>
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {convs.length === 0 && <div style={{ padding: 12, color: 'var(--text-muted)', fontSize: 13 }}>暂无对话</div>}
            {convs.map((c) => (
              <div
                key={c.id}
                onClick={() => openConv(c.id)}
                style={{
                  padding: '10px 12px',
                  cursor: 'pointer',
                  borderBottom: '1px solid var(--border)',
                  background: c.id === sessionId ? 'var(--bg-hover)' : 'transparent',
                  fontSize: 13,
                }}
              >
                <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.title || '未命名'}</div>
                <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>{c.updatedAt?.slice(0, 16) || ''}</div>
              </div>
            ))}
          </div>
        </div>

        {/* 对话区 */}
        <div style={{ ...panel, flex: 1, display: 'flex', flexDirection: 'column' }}>
          <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
            {messages.length === 0 && (
              <div style={{ color: 'var(--text-muted)', margin: 'auto', textAlign: 'center' }}>
                开始与你的 AI 助手对话吧。支持天气、联网搜索、网页总结等实时能力。
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
                <div
                  style={{
                    maxWidth: '78%',
                    background: m.role === 'user' ? 'var(--accent)' : 'var(--bg-tertiary)',
                    color: m.role === 'user' ? '#fff' : 'var(--text)',
                    padding: '10px 14px',
                    borderRadius: 12,
                    whiteSpace: 'pre-wrap',
                    fontSize: 14,
                    lineHeight: 1.6,
                  }}
                >
                  {m.content}
                </div>
              </div>
            ))}
            {sending && <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>思考中…</div>}
          </div>
          <div style={{ borderTop: '1px solid var(--border)', padding: 12, display: 'flex', gap: 8 }}>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
              placeholder="输入消息，Enter 发送，Shift+Enter 换行"
              style={{ flex: 1, resize: 'none', height: 44, background: 'var(--bg-tertiary)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 8, padding: 10, fontSize: 14 }}
            />
            <button style={btn(true)} disabled={sending} onClick={send}>{sending ? '发送中' : '发送'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
