'use client';

import React from 'react';

const MD_STYLE = `
.md { font-size: 14px; line-height: 1.65; word-break: break-word; }
.md > :first-child { margin-top: 0; }
.md > :last-child { margin-bottom: 0; }
.md p { margin: 0 0 8px; }
.md ul, .md ol { margin: 0 0 8px; padding-left: 22px; }
.md li { margin: 2px 0; }
.md h3, .md h4, .md h5, .md h6 { margin: 8px 0 6px; font-weight: 700; line-height: 1.35; }
.md h3 { font-size: 16px; } .md h4 { font-size: 15px; } .md h5, .md h6 { font-size: 14px; }
.md code.md-inline-code { background: rgba(127,127,127,0.20); padding: 1px 5px; border-radius: 4px; font-size: 12.5px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.md pre.md-pre { background: rgba(0,0,0,0.30); padding: 10px 12px; border-radius: 8px; overflow-x: auto; margin: 0 0 8px; }
.md pre.md-pre code { font-size: 12.5px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.md blockquote.md-quote { border-left: 3px solid var(--accent); margin: 0 0 8px; padding: 2px 10px; color: var(--text-muted); }
.md hr.md-hr { border: none; border-top: 1px solid var(--border); margin: 10px 0; }
.md a { color: var(--accent); text-decoration: underline; }
`;

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

  return (
    <>
      <style>{MD_STYLE}</style>
      <div className="md">{blocks}</div>
    </>
  );
}
