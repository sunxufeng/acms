'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api } from '../../../lib/api';
import Markdown from '../../../components/Markdown';

type Msg = { role: 'user' | 'assistant' | 'system'; content: string };
type FileRef = { file_token: string; name: string };

const wrap: React.CSSProperties = {
  display: 'flex',
  height: 'calc(100vh - 220px)',
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
  const [menuId, setMenuId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editText, setEditText] = useState('');
  const [fileRefs, setFileRefs] = useState<FileRef[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.aiListConversations().then(setConvs).catch(() => null);
    // 加载智能体列表，供「选择 Provider/智能体」下拉；无权限（普通用户）时静默降级为仅默认项
    api.aiListAgents().then((list) => setAgents((list as { id: string; name: string; provider?: string; model?: string; emoji?: string }[]) || [])).catch(() => null);
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 1e9, behavior: 'smooth' });
  }, [messages]);

  async function send(overrideText?: string) {
    const text = (overrideText ?? input).trim();
    if (!text || sending) return;
    if (!overrideText) setInput('');
    setFileRefs([]);
    const next = [...messages, { role: 'user' as const, content: text }];
    setMessages(next);
    setSending(true);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const r = await api.aiChat({ message: text, sessionId: sessionId ?? undefined, agentId: agentId || undefined, history: next }, ac.signal);
      setMessages([...next, { role: 'assistant' as const, content: r.content }]);
      if (r.sessionId && !sessionId) setSessionId(r.sessionId);
      api.aiListConversations().then(setConvs).catch(() => null);
    } catch (e: any) {
      if (e.name === 'AbortError') return;
      setMessages([...next, { role: 'assistant' as const, content: `⚠️ ${e instanceof Error ? e.message : String(e)}` }]);
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
      setSending(false);
    }
  }

  function stopGenerating() {
    abortRef.current?.abort();
    setSending(false);
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

  async function renameConv(c: { id: string; title: string }) {
    const next = window.prompt('修改对话名称', c.title || '');
    if (next === null) return;
    if (!next.trim()) { alert('名称不能为空'); return; }
    try {
      await api.aiRenameConversation(c.id, next.trim());
      api.aiListConversations().then(setConvs).catch(() => null);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  }

  async function deleteConv(c: { id: string; title?: string }) {
    if (!window.confirm(`确认删除对话「${c.title || '未命名'}」？此操作不可恢复。`)) return;
    try {
      await api.aiDeleteConversation(c.id);
      if (sessionId === c.id) { setSessionId(null); setMessages([]); }
      api.aiListConversations().then(setConvs).catch(() => null);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  }

  function startEdit(idx: number) {
    const m = messages[idx];
    if (m.role !== 'user') return;
    setEditingIdx(idx);
    setEditText(m.content);
  }

  function confirmEdit() {
    if (editingIdx === null) return;
    const text = editText.trim();
    if (!text) return;
    const next = [...messages];
    next[editingIdx] = { role: 'user' as const, content: text };
    setMessages(next);
    // 删除该条之后的所有消息（assistant 回复），然后重新发送
    const trimmed = next.slice(0, editingIdx + 1);
    setMessages(trimmed);
    setEditingIdx(null);
    send(text);
  }

  function cancelEdit() {
    setEditingIdx(null);
    setEditText('');
  }

  async function copyMessage(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // fallback
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta);
    }
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files?.length) return;
    const uploaded: FileRef[] = [];
    for (const f of Array.from(files)) {
      try {
        const r = await api.uploadFile(f);
        if (r.ok && r.file_token) uploaded.push({ file_token: r.file_token, name: r.name || f.name });
      } catch { /* skip failed */ }
    }
    if (uploaded.length) setFileRefs((prev) => [...prev, ...uploaded]);
    e.target.value = '';
  }

  return (
    <div style={{ padding: 16 }} onClick={() => menuId && setMenuId(null)}>
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
                    {a.name}（{(a.provider || '—')}{a.model ? ` · ${a.model}` : ''}）
                  </option>
                ))}
              </select>
            </label>
            <button style={btn()} onClick={newChat}>＋ 新对话</button>
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
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.title || '未命名'}</div>
                  <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>{c.updatedAt?.slice(0, 16) || ''}</div>
                </div>
                <div style={{ position: 'relative' }} onClick={(e) => e.stopPropagation()}>
                  <button
                    title="更多操作"
                    onClick={() => setMenuId(menuId === c.id ? null : c.id)}
                    style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: '2px 4px', borderRadius: 6 }}
                  >⋯</button>
                  {menuId === c.id && (
                    <div
                      style={{
                        position: 'absolute',
                        right: 0,
                        top: '100%',
                        zIndex: 10,
                        background: 'var(--bg-primary)',
                        border: '1px solid var(--border)',
                        borderRadius: 8,
                        boxShadow: '0 6px 20px rgba(0,0,0,0.25)',
                        minWidth: 120,
                      }}
                    >
                      <button
                        onClick={() => { setMenuId(null); renameConv(c); }}
                        style={{ display: 'block', width: '100%', textAlign: 'left', background: 'transparent', border: 'none', color: 'var(--text)', padding: '8px 12px', cursor: 'pointer', fontSize: 13 }}
                      >✏️ 重命名</button>
                      <button
                        onClick={() => { setMenuId(null); deleteConv(c); }}
                        style={{ display: 'block', width: '100%', textAlign: 'left', background: 'transparent', border: 'none', color: 'var(--danger, #ff5c5c)', padding: '8px 12px', cursor: 'pointer', fontSize: 13 }}
                      >🗑️ 删除</button>
                    </div>
                  )}
                </div>
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
              <div key={i} className="msg-row" style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }}
                onMouseEnter={(e) => { const el = e.currentTarget.querySelector('.msg-actions'); if (el) (el as HTMLElement).style.opacity = '1'; }}
                onMouseLeave={(e) => { const el = e.currentTarget.querySelector('.msg-actions'); if (el) (el as HTMLElement).style.opacity = '0'; }}
              >
                <div style={{ maxWidth: '78%', display: 'flex', flexDirection: 'column', gap: 4, alignItems: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
                  {editingIdx === i ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%', background: 'var(--bg-secondary)', borderRadius: 14, padding: 14, boxShadow: '0 2px 12px rgba(0,0,0,0.08)' }}>
                      <textarea
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); confirmEdit(); } }}
                        rows={4}
                        autoFocus
                        style={{ width: '100%', resize: 'vertical', minHeight: 72, background: '#fff', color: '#1a1a1a', border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px', fontSize: 14, lineHeight: 1.6, outline: 'none', boxSizing: 'border-box' }}
                      />
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <span style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
                          编辑后将从此处重新开始对话，已有产物不会被删除
                        </span>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button onClick={cancelEdit} style={{ padding: '6px 18px', fontSize: 13, borderRadius: 20, cursor: 'pointer', background: 'transparent', color: 'var(--text)', border: '1px solid var(--border)' }}>取消</button>
                          <button onClick={confirmEdit} style={{ padding: '6px 18px', fontSize: 13, borderRadius: 20, cursor: 'pointer', background: '#1a1a1a', color: '#fff', border: 'none' }}>发送</button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div
                        className="msg-bubble"
                        style={{
                          position: 'relative',
                          background: m.role === 'user' ? 'var(--accent)' : 'var(--bg-tertiary)',
                          color: m.role === 'user' ? '#fff' : 'var(--text)',
                          padding: '10px 14px',
                          borderRadius: 12,
                          fontSize: 14,
                          lineHeight: 1.6,
                          transition: 'filter 0.15s',
                        }}
                      >
                        <Markdown>{m.content}</Markdown>
                      </div>
                      {m.role === 'user' && (
                        <div className="msg-actions" style={{ display: 'flex', gap: 6, alignItems: 'center', opacity: 0, transition: 'opacity 0.15s', height: 20 }}>
                          <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
                          <button title="复制" onClick={() => copyMessage(m.content)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 2, borderRadius: 4, display: 'flex', alignItems: 'center', transition: 'color 0.15s' }}
                            onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--text)')}
                            onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-muted)')}
                          ><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
                          <button title="编辑并重新发送" onClick={() => startEdit(i)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 2, borderRadius: 4, display: 'flex', alignItems: 'center', transition: 'color 0.15s' }}
                            onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--text)')}
                            onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-muted)')}
                          ><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg></button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            ))}
            {sending && <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>思考中…</div>}
          </div>
          <div style={{ borderTop: '1px solid var(--border)', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {fileRefs.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {fileRefs.map((f, i) => (
                  <span key={i} style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 8px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
                    📎 {f.name}
                    <button onClick={() => setFileRefs((prev) => prev.filter((_, j) => j !== i))} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 0, fontSize: 14 }}>×</button>
                  </span>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <label title="添加本地文件" style={{ ...btn(), padding: '7px 10px', cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
                📎
                <input type="file" multiple onChange={handleFileUpload} style={{ display: 'none' }} />
              </label>
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
                placeholder="输入消息，Enter 发送，Shift+Enter 换行"
                style={{ flex: 1, resize: 'none', height: 44, background: 'var(--bg-tertiary)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 8, padding: 10, fontSize: 14 }}
              />
              {sending ? (
                <button style={{ ...btn(), borderColor: 'var(--danger, #ff5c5c)', color: 'var(--danger, #ff5c5c)' }} onClick={stopGenerating}>停止</button>
              ) : (
                <button style={btn(true)} disabled={!input.trim()} onClick={() => send()}>发送</button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
