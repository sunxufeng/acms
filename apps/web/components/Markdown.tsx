'use client';

import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * 全站唯一的只读 Markdown 渲染器。
 *
 * 用于：详情页（CrudView 的 markdown 字段）、FloatingAIPanel、student-360、ai/chat，
 * 以及 components/MarkdownField.tsx 的「浏览」Tab。
 * 所有场景共用本实现 + globals.css 的 .md 规则集，保证「编辑时预览」与「保存后展示」完全一致。
 *
 * 引擎：react-markdown + remarkGfm，支持表格、任务列表、删除线等 GFM 语法。
 * 行为：单个换行 \n 渲染为 <br/>（与旧的自研解析器一致），避免对话记录、AI 输出
 *       这类依赖硬换行的内容在替换引擎后挤成一段。
 * 安全：未启用 rehype-raw，HTML 不会被解析；react-markdown 默认清理 javascript: 等危险链接。
 */

function withBreaks(children: React.ReactNode): React.ReactNode {
  return React.Children.map(children, (child) => {
    if (typeof child === 'string') {
      if (!child.includes('\n')) return child;
      const parts = child.split('\n');
      // 空片段是块级元素之间的分隔空白（loose list / blockquote 会产生），
      // 不能转成 <br/>，否则列表项、引用的上下会多出空行。
      const out: React.ReactNode[] = [];
      parts.forEach((part, i) => {
        if (part === '') return;
        if (out.length > 0) out.push(<br key={`br-${i}`} />);
        out.push(part);
      });
      return out;
    }
    if (React.isValidElement(child)) {
      const type = child.type as unknown;
      // 代码块内容必须保留原始换行
      if (type === 'code' || type === 'pre') return child;
      const props = child.props as { children?: React.ReactNode };
      if (props?.children != null) {
        return React.cloneElement(child, { children: withBreaks(props.children) } as Partial<unknown> & React.Attributes);
      }
    }
    return child;
  });
}

export default function Markdown({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children: c }) => <p>{withBreaks(c)}</p>,
          li: ({ children: c }) => <li>{withBreaks(c)}</li>,
          blockquote: ({ children: c }) => <blockquote>{withBreaks(c)}</blockquote>,
        }}
      >
        {children || ''}
      </ReactMarkdown>
    </div>
  );
}
