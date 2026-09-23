'use client';

import type { ReactNode } from 'react';

/**
 * 通用弹窗外壳（2026-09-24）。
 *
 * 之前每个弹窗（`AiSummarizeModal` 等）都自己内联一份 overlay + 卡片样式；
 * 「我的跟进」里要弹两个（招生跟进 / 邮件），再各写一份就三份了。
 * 这里收口成一处：**样式与项目现有弹窗保持一致**（同样的 overlay、圆角、阴影、头部高度）。
 *
 * 行为：点遮罩关闭、点卡片内部不关闭（`stopPropagation`）、内容区可滚动。
 */
export interface ModalProps {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** 底部操作区（可选） */
  footer?: ReactNode;
  /** 卡片宽度上限（px，默认 640） */
  width?: number;
}

export function Modal({ title, onClose, children, footer, width = 640 }: ModalProps) {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--overlay)',
        zIndex: 60,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: '6vh 16px',
        overflowY: 'auto',
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border)',
          borderRadius: 14,
          width: `min(${width}px, 100%)`,
          boxShadow: 'var(--shadow-modal)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            padding: '16px 22px',
            borderBottom: '1px solid var(--border)',
          }}
        >
          <h3 style={{ margin: 0, fontSize: 'var(--font-lg)', fontWeight: 700, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {title}
          </h3>
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="close">
            ×
          </button>
        </div>

        <div style={{ padding: '16px 22px' }}>{children}</div>

        {footer ? (
          <div style={{ padding: '12px 22px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** 两种导入都支持（命名 + 默认），免得调用方记混 */
export default Modal;
