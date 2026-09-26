'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import Markdown from './Markdown';
import { useTl } from '../lib/useTl';
import { api, type ApiRequestError } from '../lib/api';
import { audioOf, audioPendingOf, audioSrc, fmtDuration, plainTagsOf, sourceOf } from '../lib/getnoteNote';

export interface GetnoteNoteModalProps {
  /** 笔记 ID（为空时组件不渲染） */
  noteId: string;
  onClose: () => void;
  /** 标题，默认「笔记详情」 */
  title?: string;
  /** 加载完成回调（外层若要用到笔记数据，如音频补抓按钮、埋点） */
  onLoaded?: (note: Record<string, unknown>) => void;
  /** 标题右侧的附加控件（例：一条记录关联多篇笔记时的「上一篇 / 下一篇」） */
  switcher?: React.ReactNode;
}

/** 遮罩 / 容器：与「我的笔记」页的详情弹窗同一样式（--bg-elevated / --shadow-modal） */
const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  // 与「我的笔记」页的遮罩同值（那边是硬编码，不经 --overlay，避免两处深浅不一）
  background: 'rgba(0,0,0,0.45)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
  padding: 24,
};
const modalStyle: React.CSSProperties = {
  background: 'var(--bg-elevated, #fff)',
  borderRadius: 12,
  padding: 20,
  width: 'min(880px, 100%)',
  maxHeight: '90vh',
  overflow: 'auto',
  boxShadow: 'var(--shadow-modal)',
};
const boxStyle: React.CSSProperties = {
  maxHeight: '60vh',
  overflow: 'auto',
  border: '1px solid var(--border)',
  borderRadius: 8,
  padding: '12px 16px',
  background: 'var(--bg-subtle)',
};

/**
 * 笔记详情弹窗（**全站统一的一份**）。
 *
 * 两处入口共用：
 *   ① 「我的笔记」页点列表标题
 *   ② 「我的 IDP」里点沟通记录标题 —— 沟通记录若挂着得到大脑笔记，
 *      **直接**展示这篇笔记的详情（峰哥 2026-09-26 指定：不要中间再夹一层记录详情）
 *
 * 形态（与「我的笔记」页完全一致）：右上角 **×** 关闭 → 来源 / 标签 / 更新时间 →
 * 原始音频播放器（没有就显示「还没保存到系统」）→ 「总结 / 原始记录」两个 Tab。
 *
 * ⚠️ 关闭一律用右上角的 **×**（`btn btn-ghost btn-sm` 里放 ×），不要再放一个「关闭」文字按钮 ——
 *    全站弹窗统一这个定式。
 */
export default function GetnoteNoteModal({ noteId, onClose, title, onLoaded, switcher }: GetnoteNoteModalProps) {
  const t = useTranslations('getnote');
  const tl = useTl();
  const [note, setNote] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState<'summary' | 'raw'>('summary');

  useEffect(() => {
    if (!noteId) return;
    let alive = true;
    setNote(null);
    setErr('');
    setTab('summary');
    setLoading(true);
    api
      .getGetnote(noteId)
      .then((n) => {
        if (!alive) return;
        setNote(n);
        onLoaded?.(n);
      })
      .catch((e) => {
        if (alive) setErr(errText(e, t));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // onLoaded 刻意不进依赖：它在使用侧常是内联箭头函数，进来会变成每次渲染都重新拉详情
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId]);

  if (!noteId) return null;

  return (
    // 🔴 遮罩上必须 stopPropagation：这个弹窗会嵌在别的弹窗/面板里渲染
    //    （「我的 IDP」的沟通面板内），不拦住会一路冒泡上去把宿主一起关掉
    <div
      style={overlayStyle}
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 'var(--font-lg)', fontWeight: 700 }}>{title ?? t('noteDetail')}</h3>
          <span style={{ display: 'flex', alignItems: 'center' }}>
            {switcher}
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={onClose}
              title={tl('关闭')}
              aria-label={tl('关闭')}
            >
              ×
            </button>
          </span>
        </div>

        {err ? (
          <p style={{ color: 'var(--fg-error)', fontSize: 13, marginTop: 0, marginBottom: 8 }}>{err}</p>
        ) : null}
        {loading ? (
          <p className="muted" style={{ fontSize: 13 }}>
            {t('loading')}
          </p>
        ) : null}

        {note ? (
          <div>
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 16,
                fontSize: 12,
                color: 'var(--fg-tertiary)',
                marginBottom: 12,
              }}
            >
              <span>来源：{sourceOf(note)}</span>
              <span>标签：{plainTagsOf(note).join('、') || '—'}</span>
              <span>更新时间：{String(note.updated_at ?? '')}</span>
            </div>

            {/* 原始音频。只在真下载过时出现；播放走 /getnote/notes/:id/audio（带可见性校验） */}
            {audioOf(note) ? (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  marginBottom: 12,
                  padding: '8px 12px',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                }}
              >
                <span style={{ fontSize: 12, color: 'var(--fg-tertiary)', whiteSpace: 'nowrap' }}>
                  🎧 {t('audio')}
                  {fmtDuration(audioOf(note)?.durationMs) ? ` ${fmtDuration(audioOf(note)?.durationMs)}` : ''}
                </span>
                <audio
                  controls
                  preload="none"
                  style={{ flex: 1, height: 32 }}
                  src={audioSrc(String(note.id ?? noteId))}
                />
              </div>
            ) : audioPendingOf(note) ? (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  marginBottom: 12,
                  padding: '8px 12px',
                  border: '1px dashed var(--border)',
                  borderRadius: 8,
                  fontSize: 12,
                  color: 'var(--fg-tertiary)',
                }}
              >
                ⏳ {t('noAudioYet')}
              </div>
            ) : null}

            <div style={{ display: 'flex', gap: 8, marginBottom: 12, borderBottom: '1px solid var(--border)', paddingBottom: 8 }}>
              <button
                type="button"
                className={tab === 'summary' ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-ghost'}
                onClick={() => setTab('summary')}
              >
                {t('summary')}
              </button>
              <button
                type="button"
                className={tab === 'raw' ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-ghost'}
                onClick={() => setTab('raw')}
              >
                {t('rawRecord')}
              </button>
            </div>

            {tab === 'summary' ? (
              <div className="md" style={boxStyle}>
                <Markdown>{String((note.content as string) ?? '')}</Markdown>
              </div>
            ) : (
              <div style={boxStyle}>
                {String((note.rawRecord as string) ?? '').trim() ? (
                  <pre
                    style={{
                      margin: 0,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      fontSize: 13,
                      lineHeight: 1.7,
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                      color: 'var(--fg)',
                    }}
                  >
                    {String(note.rawRecord as string)}
                  </pre>
                ) : (
                  <p className="muted" style={{ fontSize: 13, margin: 0 }}>
                    {t('noRawRecord')}
                  </p>
                )}
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * 把后端的结构化错误码翻成人话。光看 message 区分不了「非会员」和「Key 无效」。
 * 与「我的笔记」页的 `errorText` 同源（那边是页面级函数，这里自带一份用于详情拉取）。
 */
function errText(e: unknown, t: (k: string) => string): string {
  const code = (e as ApiRequestError)?.apiCode;
  if (code === 'GETNOTE_NOT_MEMBER') return t('errNotMember');
  if (code === 'GETNOTE_AUTH_FAILED') return t('errAuthFailed');
  if (code === 'GETNOTE_RATE_LIMITED') return t('errRateLimited');
  if (code === 'GETNOTE_BAD_INPUT') return (e as Error).message || t('errAuthFailed');
  return (e as Error)?.message || t('errGeneric');
}
