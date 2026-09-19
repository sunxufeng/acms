'use client';

import { Fragment } from 'react';

import type { CrudColumn } from './CrudPage';
import Markdown from './Markdown';
// 音频判据与播放器：与列表「操作」列、编辑表单共用同一套（判据只写一份）
import AudioAttachment from './AudioAttachment';
import { isAudioFile } from '../lib/rowAudio';

/** 只读记录渲染器：用于「详情页」展示，不可修改。复用 CrudColumn 定义决定字段顺序与类型。 */
export default function CrudView({ columns, record }: { columns: CrudColumn[]; record: Record<string, unknown> }) {
  // 仅渲染在表单 / 列表中出现的字段（避免内部字段如 *_link 误显示）
  //
  // ⚠️ 再叠一层 `showIf`：只读详情也要**按类型 / 条件只显示用得上的字段**。
  // 学生记录这类「一份列定义按类型显隐」的模块，光看 form/list 会把 20 个字段全摊开、
  // 一半是空的（日常跟进的详情里出现家长三件套、家校沟通里出现观察类型），整片「—」很难读。
  // 这里传的是**已保存的记录**，与表单里传 form 是同一个语义。
  const cols = columns.filter(
    (c) => (c.form || c.list !== false) && (!c.showIf || c.showIf(record)),
  );

  function disp(c: CrudColumn): React.ReactNode {
    const v = record[c.key];
    if (c.type === 'attachment') {
      const files = attachmentFiles(v);
      if (!files.length) return <span className="view-empty">—</span>;
      return (
        <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          {files.map((a, i) =>
            // 音频给**内联播放器**而不是下载链接（2026-09-19 统一）：只给链接的话，
            // 想听录音得先下载再找播放器；而且编辑表单里本来就有播放器，同一附件两种待遇说不过去
            isAudioFile(a) ? (
              <AudioAttachment key={a.file_token ?? i} token={a.file_token} name={a.name} />
            ) : (
              <a key={a.file_token ?? i} href={`/api/v1/files/${a.file_token}`} target="_blank" rel="noreferrer" className="name-link">
                {a.name}
              </a>
            ),
          )}
        </span>
      );
    }
    if (c.type === 'markdown') {
      const text = str(v);
      if (!text.trim()) return <span className="view-empty">—</span>;
      return (
        <div className="md-view">
          <Markdown>{text}</Markdown>
        </div>
      );
    }
    if (c.type === 'date') {
      const t = str(v);
      return t ? <span>{t}</span> : <span className="view-empty">—</span>;
    }
    if (c.type === 'datetime') {
      const t = str(v);
      return t ? <span>{t}</span> : <span className="view-empty">—</span>;
    }
    const text = str(v);
    return text ? <span>{text}</span> : <span className="view-empty">—</span>;
  }

  return (
    <div className="crud-view">
      {cols.map((c, ci) => (
        <Fragment key={c.key}>
          {/* 分区标题：与上一列分区不同时插入一行（跨整行），与**编辑表单**同一套分区语义。
              ⚠️ 比的是 `cols`（showIf 过滤后的实际渲染序列）而不是原始 columns：
              拿 columns[ci-1] 比会在有隐藏字段时**索引错位**，标题会重复或该有却没有。
              （表单侧此前就踩过这个坑，见 CrudPage 的 shownCols）
              没有标 section 的模块不受影响（undefined 不渲染）。 */}
          {c.section && c.section !== cols[ci - 1]?.section ? (
            <div
              style={{
                gridColumn: '1 / -1',
                marginTop: ci === 0 ? 0 : 'var(--space-md)',
                paddingBottom: 6,
                borderBottom: '1px solid var(--border)',
                fontSize: 'var(--font-sm)',
                fontWeight: 600,
                color: 'var(--fg-secondary)',
              }}
            >
              {c.section}
            </div>
          ) : null}
          <div
            className="crud-view-field"
            style={c.type === 'textarea' || c.type === 'markdown' ? { gridColumn: '1 / -1' } : undefined}
          >
            <div className="crud-view-label">{c.label}</div>
            <div className="crud-view-value">{disp(c)}</div>
          </div>
        </Fragment>
      ))}
    </div>
  );
}

function str(v: unknown): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : String((x as { text?: string })?.text ?? ''))).join('、');
  if (typeof v === 'object') return String((v as { text?: string })?.text ?? '');
  return String(v);
}

/** 附件项：`type` 要保留 —— 音频判定（isAudioFile）靠它，剥掉就只能按扩展名退化猜 */
function attachmentFiles(v: unknown): { file_token: string; name: string; type?: string }[] {
  if (Array.isArray(v)) return v as { file_token: string; name: string; type?: string }[];
  if (typeof v === 'string' && v.trim()) {
    try {
      const p = JSON.parse(v);
      if (Array.isArray(p)) return p as { file_token: string; name: string; type?: string }[];
    } catch {
      /* ignore */
    }
  }
  return [];
}
