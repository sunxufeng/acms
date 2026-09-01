'use client';

import React from 'react';

// 本组件是自研的轻量 Markdown 解析器（供 AI 输出等只读场景使用）。
// 样式统一来自 globals.css 的 .md 规则集，与 components/MarkdownField.tsx
// （react-markdown + GFM）共用同一套样式，保证观感一致。
// 注意：本解析器不支持 GFM（表格、任务列表、删除线），需要这些能力请用 MarkdownField。

// 行内格式：**粗体** *斜体* `代码` [文本](链接)。支持换行 → <br/>。
function tokenize(text: string, keyPrefix: string): React.ReactNode[] {
  const pattern =
    /(\*\*([^*]+?)\*\*)|(\*([^*]+?)\*)|(_([^_]+?)_)|(`([^`]+?)`)|(\[([^\]]+?)\]\((https?:\/\/[^\s)]+)\))/g;
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${keyPrefix}-${i++}`;
    if (m[2] !== undefined) out.push(<strong key={k}>{tokenize(m[2], k)}</strong>);
    else if (m[4] !== undefined) out.push(<em key={k}>{tokenize(m[4], k)}</em>);
    else if (m[6] !== undefined) out.push(<em key={k}>{tokenize(m[6], k)}</em>);
    else if (m[8] !== undefined) out.push(<code key={k} className="md-inline-code">{m[8]}</code>);
    else if (m[10] !== undefined) out.push(<a key={k} href={m[11]} target="_blank" rel="noreferrer">{m[10]}</a>);
    last = pattern.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const parts = text.split('\n');
  const res: React.ReactNode[] = [];
  parts.forEach((part, idx) => {
    if (idx > 0) res.push(<br key={`${keyPrefix}-br-${idx}`} />);
    res.push(...tokenize(part, `${keyPrefix}-${idx}`));
  });
  return res;
}

export default function Markdown({ children }: { children: string }) {
  const text = (children || '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  const isBlank = (l: string) => /^\s*$/.test(l);
  const isHeading = (l: string) => /^(#{1,4})\s+/.test(l);
  const isQuote = (l: string) => /^>\s?/.test(l);
  const isUl = (l: string) => /^[-*]\s+/.test(l);
  const isOl = (l: string) => /^\d+\.\s+/.test(l);
  const isHr = (l: string) => /^(\*\*\*|---|___)\s*$/.test(l);
  const isFence = (l: string) => /^```/.test(l);

  while (i < lines.length) {
    const line = lines[i];

    if (isFence(line)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !isFence(lines[i])) { buf.push(lines[i]); i++; }
      i++; // 跳过结束 ```
      blocks.push(<pre key={key++} className="md-pre"><code>{buf.join('\n')}</code></pre>);
      continue;
    }
    if (isBlank(line)) { i++; continue; }

    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const Tag = (`h${Math.min(h[1].length + 2, 6)}`) as React.ElementType;
      blocks.push(<Tag key={key++} className="md-h">{renderInline(h[2], `h${key}`)}</Tag>);
      i++;
      continue;
    }
    if (isHr(line)) { blocks.push(<hr key={key++} className="md-hr" />); i++; continue; }
    if (isQuote(line)) {
      const buf: string[] = [];
      while (i < lines.length && isQuote(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++; }
      blocks.push(<blockquote key={key++} className="md-quote">{renderInline(buf.join(' '), `q${key}`)}</blockquote>);
      continue;
    }
    if (isUl(line)) {
      const items: string[] = [];
      while (i < lines.length && isUl(lines[i])) { items.push(lines[i].replace(/^[-*]\s+/, '')); i++; }
      blocks.push(
        <ul key={key++} className="md-ul">
          {items.map((it, idx) => <li key={idx}>{renderInline(it, `ul${key}-${idx}`)}</li>)}
        </ul>
      );
      continue;
    }
    if (isOl(line)) {
      const items: string[] = [];
      while (i < lines.length && isOl(lines[i])) { items.push(lines[i].replace(/^\d+\.\s+/, '')); i++; }
      blocks.push(
        <ol key={key++} className="md-ol">
          {items.map((it, idx) => <li key={idx}>{renderInline(it, `ol${key}-${idx}`)}</li>)}
        </ol>
      );
      continue;
    }

    // 段落：收集连续普通行
    const para: string[] = [];
    while (
      i < lines.length &&
      !isBlank(lines[i]) && !isFence(lines[i]) && !isHeading(lines[i]) &&
      !isQuote(lines[i]) && !isUl(lines[i]) && !isOl(lines[i]) && !isHr(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    blocks.push(<p key={key++} className="md-p">{renderInline(para.join('\n'), `p${key}`)}</p>);
  }

  return <div className="md">{blocks}</div>;
}
