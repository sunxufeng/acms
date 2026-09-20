'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/**
 * 通用弹出框（模态）—— 2026-09-20 新增。
 *
 * 为什么把成绩册的两个编辑器从「网格下方的内联面板」改成模态：
 *  - **内联面板会串内容**：它在页面上是可点的，用户能在它开着时点别的列头的「编辑」，
 *    而组件没有 key 时 React 会复用实例 ⇒ 表单里留着上一列的值（这个 bug 真实发生过）。
 *    模态挡住页面、一次只编辑一件事，从结构上排除这类问题（仍会按 id 给 key 做双保险）。
 *  - **滚动可见性**：内联面板在整张成绩表下面，列一多就得滚很久才看得到，
 *    老师甚至以为「功能没了」（作业同步面板就是这样）。
 *
 * ⚠️ 两条实现要点（踩过的坑）：
 *  1. Esc 关闭与滚动锁都用**空依赖 + ref**：把 `onClose` 放进依赖数组会让每次 render
 *     重新注册监听（调用方通常直接写 `() => setX(null)`，每次都是新函数）。
 *  2. 遮罩层的点击关闭只在**点遮罩本身**时触发（`e.target === e.currentTarget`），
 *     否则弹窗内部任意点击都会把它关掉。
 */
export default function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
  width = 760,
}: {
  title: string;
  /** 副标题：通常放「当前 学年 / 学期 / 班级」这类上下文，省得用户回头确认 */
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  /** 底部操作条（左侧摘要 + 右侧按钮由调用方自行排版） */
  footer?: ReactNode;
  width?: number;
}) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
    };
    window.addEventListener('keydown', onKey);
    // 打开期间锁住页面滚动：否则背景跟着滚，看着很乱
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, []);

  return (
    <div
      className="mb-mask"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeRef.current();
      }}
    >
      <div className="mb-modal" style={{ maxWidth: width }} role="dialog" aria-modal="true" aria-label={title}>
        <div className="mb-modal-hd">
          <div className="mb-modal-title">
            <b>{title}</b>
            {subtitle ? <div className="mb-modal-sub">{subtitle}</div> : null}
          </div>
          <button type="button" className="mb-modal-x" onClick={() => closeRef.current()} aria-label="关闭">
            ✕
          </button>
        </div>
        <div className="mb-modal-body">{children}</div>
        {footer ? <div className="mb-modal-ft">{footer}</div> : null}
      </div>
    </div>
  );
}
