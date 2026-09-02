'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../lib/api';
import Markdown from './Markdown';

type Msg = { role: 'user' | 'assistant' | 'system'; content: string };
type FileRef = { file_token: string; name: string };
type DialogRect = { x: number; y: number; width: number; height: number };

function defaultDialogRect(): DialogRect {
  if (typeof window === 'undefined') return { x: 0, y: 80, width: 560, height: 640 };
  const width = 560;
  const height = Math.min(640, window.innerHeight - 120);
  return {
    x: Math.max(20, window.innerWidth - width - 20),
    y: 80,
    width,
    height,
  };
}

export interface FloatingAIPanelProps {
  /** 注入给 AI 的系统上下文（学生 / 招生跟进等聚合摘要文本） */
  context: string;
  /** 上下文变化（如切换学生 / 重新勾选）时重置对话；建议传稳定标识（如选中 id 列表） */
  resetKey?: string;
  /** 是否禁用（无可用数据）。禁用时悬浮按钮置灰且不可打开 */
  disabled?: boolean;
  /** 禁用时的提示文案 */
  disabledHint?: string;
  /** 悬浮按钮文案，默认「AI」 */
  label?: string;
  /** 对话框标题，默认「AI」 */
  title?: string;
  /** 当前对象名称（显示在副标题，如学生姓名 / 已选学生列表） */
  subject?: string;
  /** localStorage key，用于持久化对话框位置/大小；不同页面应不同 */
  storageKey: string;
  /** 输入框占位提示 */
  placeholder?: string;
}

/**
 * 通用「AI助手」悬浮面板：可拖拽的悬浮按钮 + 可拖拽/缩放的对话框（含智能体下拉与对话）。
 * 学生全景与招生跟进等页面共用此组件，仅 context / disabled / subject 不同。
 */
export default function FloatingAIPanel({
  context,
  resetKey,
  disabled = false,
  disabledHint,
  label = 'AI',
  title = 'AI',
  subject,
  storageKey,
  placeholder = '输入你的问题，Enter 发送…',
}: FloatingAIPanelProps) {
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<DialogRect>({ x: 0, y: 80, width: 560, height: 640 });
  const [dlgDragging, setDlgDragging] = useState(false);
  const [dlgResizing, setDlgResizing] = useState(false);
  const dlgDragStart = useRef({ x: 0, y: 0, startX: 0, startY: 0 });
  const dlgResizeStart = useRef({ x: 0, y: 0, startW: 0, startH: 0 });

  // 悬浮按钮位置（可拖拽），默认右上角
  const [fabPos, setFabPos] = useState<{ x: number; y: number } | null>(null);
  const [fabDragging, setFabDragging] = useState(false);
  const fabDragStart = useRef({ x: 0, y: 0, startX: 0, startY: 0, moved: false });

  const [agents, setAgents] = useState<{ id: string; name: string; provider?: string; model?: string }[]>([]);
  const [agentId, setAgentId] = useState('');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editText, setEditText] = useState('');
  const [fileRefs, setFileRefs] = useState<FileRef[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 恢复上次对话框位置/大小（越界则拉回可视区）
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) {
        setDialog(defaultDialogRect());
        return;
      }
      const saved: DialogRect = JSON.parse(raw);
      const maxW = window.innerWidth - 40;
      const maxH = window.innerHeight - 80;
      const width = Math.max(360, Math.min(saved.width || 560, maxW));
      const height = Math.max(300, Math.min(saved.height || 640, maxH));
      const x = Math.max(20, Math.min(saved.x || 0, window.innerWidth - width - 20));
      const y = Math.max(20, Math.min(saved.y || 80, window.innerHeight - height - 20));
      setDialog({ x, y, width, height });
    } catch {
      setDialog(defaultDialogRect());
    }
  }, [storageKey]);

  // 保存对话框位置/大小
  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem(storageKey, JSON.stringify(dialog));
  }, [dialog, storageKey]);

  // 打开时拉回到可视区（避免上次记录的位置超屏）
  useEffect(() => {
    if (!open || typeof window === 'undefined') return;
    setDialog((d) => {
      const maxW = window.innerWidth - 40;
      const maxH = window.innerHeight - 80;
      const width = Math.max(360, Math.min(d.width, maxW));
      const height = Math.max(300, Math.min(d.height, maxH));
      const x = Math.max(20, Math.min(d.x, window.innerWidth - width - 20));
      const y = Math.max(20, Math.min(d.y, window.innerHeight - height - 20));
      return { x, y, width, height };
    });
  }, [open]);

  // 上下文变化（resetKey 变化）时重置对话
  useEffect(() => {
    setMessages([{ role: 'system', content: context }]);
    setSessionId(null);
    setInput('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  // 加载智能体列表
  useEffect(() => {
    api
      .aiListAgents()
      .then((list) => setAgents((list as { id: string; name: string; provider?: string; model?: string }[]) || []))
      .catch(() => null);
  }, []);

  // 新消息自动滚动到底
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 1e9, behavior: 'smooth' });
  }, [messages]);

  // 拖动对话框标题栏
  useEffect(() => {
    if (!dlgDragging) return;
    function onMove(e: MouseEvent) {
      const dx = e.clientX - dlgDragStart.current.x;
      const dy = e.clientY - dlgDragStart.current.y;
      setDialog((d) => {
        const nextX = dlgDragStart.current.startX + dx;
        const nextY = dlgDragStart.current.startY + dy;
        return {
          ...d,
          x: Math.max(0, Math.min(nextX, window.innerWidth - d.width)),
          y: Math.max(0, Math.min(nextY, window.innerHeight - d.height)),
        };
      });
    }
    function onUp() {
      setDlgDragging(false);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dlgDragging]);

  // 拖拽右下角改变对话框大小
  useEffect(() => {
    if (!dlgResizing) return;
    function onMove(e: MouseEvent) {
      const dx = e.clientX - dlgResizeStart.current.x;
      const dy = e.clientY - dlgResizeStart.current.y;
      setDialog((d) => {
        const maxW = window.innerWidth - d.x - 20;
        const maxH = window.innerHeight - d.y - 20;
        return {
          ...d,
          width: Math.max(360, Math.min(dlgResizeStart.current.startW + dx, maxW)),
          height: Math.max(300, Math.min(dlgResizeStart.current.startH + dy, maxH)),
        };
      });
    }
    function onUp() {
      setDlgResizing(false);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dlgResizing]);

  // 悬浮按钮默认位置（右上角）
  useEffect(() => {
    if (typeof window === 'undefined' || fabPos) return;
    setFabPos({ x: Math.max(20, window.innerWidth - 76), y: 120 });
  }, [fabPos]);

  // 拖拽悬浮按钮
  useEffect(() => {
    if (!fabDragging) return;
    function onMove(e: MouseEvent) {
      const dx = e.clientX - fabDragStart.current.x;
      const dy = e.clientY - fabDragStart.current.y;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) fabDragStart.current.moved = true;
      setFabPos((p) => {
        if (!p) return p;
        const nextX = fabDragStart.current.startX + dx;
        const nextY = fabDragStart.current.startY + dy;
        return {
          x: Math.max(0, Math.min(nextX, window.innerWidth - 72)),
          y: Math.max(0, Math.min(nextY, window.innerHeight - 52)),
        };
      });
    }
    function onUp() {
      setFabDragging(false);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [fabDragging]);

  async function send(overrideText?: string) {
    const text = (overrideText ?? input).trim();
    if (!text || sending || disabled) return;
    if (!overrideText) setInput('');
    setFileRefs([]);
    const next = [...messages, { role: 'user' as const, content: text }];
    setMessages(next);
    setSending(true);

    let sid = sessionId;
    if (!sid) {
      try {
        const r = await api.aiCreateConversation({ title: `${title} · ${subject || '未命名'}` });
        sid = r.id;
        setSessionId(sid);
      } catch {
        // 会话创建失败则继续用临时 history，不阻塞对话
      }
    }

    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const r = await api.aiChat({ message: text, sessionId: sid ?? undefined, agentId: agentId || undefined, history: messages }, ac.signal);
      setMessages([...next, { role: 'assistant', content: r.content }]);
      if (r.sessionId && !sessionId) setSessionId(r.sessionId);
    } catch (e: any) {
      if (e.name === 'AbortError') return;
      setMessages([...next, { role: 'assistant', content: `⚠️ ${e instanceof Error ? e.message : String(e)}` }]);
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
      setSending(false);
    }
  }

  function stopGenerating() {
    abortRef.current?.abort();
    setSending(false);
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
    const trimmed = messages.slice(0, editingIdx + 1);
    setMessages(trimmed);
    setEditingIdx(null);
    send(text);
  }

  function cancelEdit() { setEditingIdx(null); setEditText(''); }

  async function copyMessage(text: string) {
    try { await navigator.clipboard.writeText(text); } catch {
      const ta = document.createElement('textarea'); ta.value = text;
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
    }
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files; if (!files?.length) return;
    const uploaded: FileRef[] = [];
    for (const f of Array.from(files)) {
      try { const r = await api.uploadFile(f); if (r.ok && r.file_token) uploaded.push({ file_token: r.file_token, name: r.name || f.name }); } catch {}
    }
    if (uploaded.length) setFileRefs((prev) => [...prev, ...uploaded]);
    e.target.value = '';
  }

  const subjectText = subject || '（未选择对象）';

  const fab = !open && typeof document !== 'undefined'
    ? createPortal(
        <button
          type="button"
          className="ai-fab"
          disabled={disabled}
          title={disabled ? (disabledHint ?? '暂无可分析的数据') : `打开 ${label}（可拖拽移动位置）`}
          style={fabPos ? { left: fabPos.x, top: fabPos.y, right: 'auto' } : undefined}
          onMouseDown={(e) => {
            if (!fabPos) return;
            fabDragStart.current = {
              x: e.clientX,
              y: e.clientY,
              startX: fabPos.x,
              startY: fabPos.y,
              moved: false,
            };
            setFabDragging(true);
          }}
          onClick={() => {
            // 拖拽后不再触发展开
            if (fabDragStart.current.moved) {
              fabDragStart.current.moved = false;
              return;
            }
            if (!disabled) setOpen(true);
          }}
        >
          {label}
        </button>,
        document.body,
      )
    : null;

  const panel = typeof document !== 'undefined'
    ? createPortal(
        <div
          style={{
            position: 'fixed',
            left: dialog.x,
            top: dialog.y,
            width: dialog.width,
            height: dialog.height,
            display: open ? 'flex' : 'none',
            flexDirection: 'column',
            background: 'var(--bg)',
            border: '1px solid var(--border)',
            borderRadius: 12,
            boxShadow: 'var(--shadow-lg)',
            zIndex: 2000,
            overflow: 'hidden',
          }}
        >
          <div
            onMouseDown={(e) => {
              dlgDragStart.current = {
                x: e.clientX,
                y: e.clientY,
                startX: dialog.x,
                startY: dialog.y,
              };
              setDlgDragging(true);
            }}
            style={{
              flexShrink: 0,
              padding: '14px 18px',
              borderBottom: '1px solid var(--border)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              cursor: 'move',
              userSelect: 'none',
            }}
          >
            <div>
              <div style={{ fontWeight: 700, fontSize: 15 }}>{title}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{subjectText}</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <select
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                style={{
                  background: 'var(--bg-tertiary)',
                  color: 'var(--text)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  padding: '6px 10px',
                  fontSize: 13,
                }}
              >
                <option value="">个人默认配置</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}（{a.provider || '—'}{a.model ? ` · ${a.model}` : ''}）
                  </option>
                ))}
              </select>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(false)} title="收起智能分析">
                收起
              </button>
            </div>
          </div>

          <div
            ref={scrollRef}
            style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}
          >
            {messages.length <= 1 && (
              <div style={{ color: 'var(--text-muted)', margin: 'auto', textAlign: 'center', maxWidth: 360 }}>
                已加载「{subjectText}」的摘要，可就选中的数据向 AI 提问，例如招生意向、跟进进度、家长反馈、风险与下一步建议等。
              </div>
            )}
            {messages.map((m, i) => {
              if (m.role === 'system') return null;
              return (
                <div key={i} className="msg-row" style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }}
                  onMouseEnter={(e) => { const el = e.currentTarget.querySelector('.msg-actions'); if (el) (el as HTMLElement).style.opacity = '1'; }}
                  onMouseLeave={(e) => { const el = e.currentTarget.querySelector('.msg-actions'); if (el) (el as HTMLElement).style.opacity = '0'; }}
                >
                  <div style={{ maxWidth: '86%', display: 'flex', flexDirection: 'column', gap: 4, alignItems: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
                    {editingIdx === i ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%', background: 'var(--bg-secondary)', borderRadius: 14, padding: 16, boxShadow: 'var(--shadow-md)' }}>
                        <textarea
                          value={editText}
                          onChange={(e) => setEditText(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); confirmEdit(); } }}
                          rows={7}
                          autoFocus
                          style={{ width: '100%', resize: 'vertical', minHeight: 120, background: 'var(--surface-input)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: 10, padding: '14px 16px', fontSize: 14, lineHeight: 1.65, outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit' }}
                        />
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                          <span style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
                            编辑后将从此处重新开始对话，已有产物不会被删除
                          </span>
                          <div style={{ display: 'flex', gap: 8 }}>
                            <button onClick={cancelEdit} style={{ padding: '6px 18px', fontSize: 13, borderRadius: 20, cursor: 'pointer', background: 'transparent', color: 'var(--text)', border: '1px solid var(--border)' }}>取消</button>
                            <button onClick={confirmEdit} style={{ padding: '6px 18px', fontSize: 13, borderRadius: 20, cursor: 'pointer', background: 'var(--accent)', color: 'var(--fg-on-accent)', border: 'none' }}>发送</button>
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
                            color: m.role === 'user' ? 'var(--fg-on-accent)' : 'var(--text)',
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
              );
            })}
            {sending && <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>思考中…</div>}
          </div>

          <div style={{ flexShrink: 0, borderTop: '1px solid var(--border)', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
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
              <label title="添加本地文件" className="btn btn-ghost btn-sm" style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', padding: '7px 10px' }}>
                📎
                <input type="file" multiple onChange={handleFileUpload} style={{ display: 'none' }} />
              </label>
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                placeholder={placeholder}
                disabled={disabled || sending}
                style={{
                  flex: 1,
                  resize: 'none',
                  height: 44,
                  background: 'var(--bg-tertiary)',
                  color: 'var(--text)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  padding: 10,
                  fontSize: 14,
                }}
              />
              {sending ? (
                <button type="button" className="btn btn-ghost btn-sm" onClick={stopGenerating} style={{ borderColor: 'var(--danger, #ff5c5c)', color: 'var(--danger, #ff5c5c)' }}>停止</button>
              ) : (
                <button type="button" className="btn btn-primary btn-sm" disabled={disabled || sending || !input.trim()} onClick={() => send()}>
                  发送
                </button>
              )}
            </div>
          </div>

          {/* 右下角缩放手柄 */}
          <div
            onMouseDown={(e) => {
              e.preventDefault();
              dlgResizeStart.current = {
                x: e.clientX,
                y: e.clientY,
                startW: dialog.width,
                startH: dialog.height,
              };
              setDlgResizing(true);
            }}
            title="拖拽缩放对话框"
            style={{
              position: 'absolute',
              right: 0,
              bottom: 0,
              width: 18,
              height: 18,
              cursor: 'nwse-resize',
              background:
                'linear-gradient(135deg, transparent 50%, var(--border) 50%, var(--border) 60%, transparent 60%, transparent 70%, var(--border) 70%, var(--border) 80%, transparent 80%, transparent 90%, var(--border) 90%, var(--border) 100%)',
            }}
          />
        </div>,
        document.body,
      )
    : null;

  return (
    <>
      {fab}
      {panel}
    </>
  );
}
