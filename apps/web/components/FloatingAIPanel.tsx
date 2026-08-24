'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../lib/api';
import Markdown from './Markdown';

type Msg = { role: 'user' | 'assistant' | 'system'; content: string };
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

  async function send() {
    const text = input.trim();
    if (!text || sending || disabled) return;
    setInput('');
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

    try {
      const r = await api.aiChat({ message: text, sessionId: sid ?? undefined, agentId: agentId || undefined, history: messages });
      setMessages([...next, { role: 'assistant', content: r.content }]);
      if (r.sessionId && !sessionId) setSessionId(r.sessionId);
    } catch (e) {
      setMessages([...next, { role: 'assistant', content: `⚠️ ${e instanceof Error ? e.message : String(e)}` }]);
    } finally {
      setSending(false);
    }
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
            boxShadow: '0 12px 40px rgba(0,0,0,0.25)',
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
                <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
                  <div
                    style={{
                      maxWidth: '86%',
                      background: m.role === 'user' ? 'var(--accent)' : 'var(--bg-tertiary)',
                      color: m.role === 'user' ? '#fff' : 'var(--text)',
                      padding: '10px 14px',
                      borderRadius: 12,
                      fontSize: 14,
                      lineHeight: 1.6,
                    }}
                  >
                    <Markdown>{m.content}</Markdown>
                  </div>
                </div>
              );
            })}
            {sending && <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>思考中…</div>}
          </div>

          <div style={{ flexShrink: 0, borderTop: '1px solid var(--border)', padding: 12, display: 'flex', gap: 8 }}>
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
            <button
              type="button"
              className="btn btn-primary"
              disabled={disabled || sending || !input.trim()}
              onClick={send}
            >
              {sending ? '发送中' : '发送'}
            </button>
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
