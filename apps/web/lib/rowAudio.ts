'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 列表「操作」列的行内音频播放 —— 通用能力（2026-09-19 从「我的笔记」抽出）。
 *
 * 两个场景共用同一份逻辑，避免两份实现漂移：
 *   - 我的笔记（`app/getnote/page.tsx`）：播放地址是专用接口 `/getnote/notes/:id/audio`
 *   - 学生记录等附件字段：播放地址是通用附件接口 `/api/v1/files/:token`
 * 所以 hook 只收一个 `srcOf(row)`，地址怎么来由调用方决定。
 */

/** 附件项（后端附件字段里的单项） */
export interface AttachItem {
  file_token?: string;
  name?: string;
  size?: number;
  type?: string;
}

/**
 * 这个附件是不是音频 —— 决定渲染成**内联播放器**还是普通下载链接。
 *
 * 为什么要判：从「我的笔记」转出到业务模块时，录音会作为附件写进目标记录的附件字段
 * （见 contracts 的 `NoteConvertTarget.audioField`）。只给一个下载链接的话，
 * 同事还得下载下来用本地播放器听，等于白转。
 *
 * 🔴 双判据：MIME 优先（`audio/*`），拿不到 MIME 就按扩展名 —— 历史音频的 MIME 曾
 * 被写死成 `audio/ogg`（其中 40 个实为 MP3），且落库时一律以**文件头**为准，
 * 所以扩展名这条兜底不能省。
 */
export function isAudioFile(f: { name?: string; type?: string }): boolean {
  const mime = String(f.type ?? '').toLowerCase();
  if (mime.startsWith('audio/')) return true;
  const name = String(f.name ?? '').toLowerCase();
  return /\.(ogg|oga|opus|mp3|m4a|mp4|aac|wav|flac|weba|webm|amr)$/.test(name);
}

/** 把字段值当数组看：真数组直接用；JSON 字符串尝试解析；其余返回空数组 */
function asArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim().startsWith('[')) {
    try {
      const p: unknown = JSON.parse(v);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * 取某一行附件字段里的**音频**项。
 *
 * 判据只认 `file_token`（富文本元素只有 `{text}`，不会误判）—— 与后端
 * `isAttachmentArray` 同一套口径，读写两侧不会出现「写进去有、读出来没有」。
 */
export function audioAttachmentsOf(row: Record<string, unknown> | null, field: string): AttachItem[] {
  return asArray(row?.[field])
    .filter((x): x is AttachItem => !!x && typeof x === 'object' && !!(x as AttachItem).file_token)
    .filter((x) => isAudioFile(x));
}

/** 通用附件播放地址（`/files/:token` 已支持 Range/206 + inline，进度条可拖） */
export function attachmentAudioSrc(token: string): string {
  return `/api/v1/files/${encodeURIComponent(token)}`;
}

/**
 * 行内播放：**单个 Audio 实例** + 「同一时刻只播一个」。
 *
 * ⚠️ 不要给每行渲染一个 `<audio>` 元素：一页 20 行就是 20 个播放器，
 * 每个挂着几十上百 MB 的音频源，内存与网络开销不可接受（录音最长 3 小时 / 168 MB）。
 *
 * `playingId` 只用于**按钮外观**（▶ 播放 / ⏸ 停止），真正的播放靠 `elRef`。
 * 再点同一行 = 停止；点另一行 = 切歌（前一行自动停）；组件卸载时统一停掉。
 *
 * @param srcOf 从一行取出播放地址；返回空表示这行不可播（按钮应渲染为禁用或不渲染）
 */
export function useRowAudio(srcOf: (row: Record<string, unknown>) => string | null) {
  // 用 ref 存 srcOf：调用方通常在 render 里内联传函数，直接进 useCallback 依赖会每帧变
  const srcRef = useRef(srcOf);
  srcRef.current = srcOf;

  const elRef = useRef<HTMLAudioElement | null>(null);
  const [playingId, setPlayingId] = useState('');

  const stop = useCallback(() => {
    const el = elRef.current;
    if (el) {
      el.pause();
      // 断开 src 才能让浏览器立刻释放这个（可能上百 MB 的）连接
      el.removeAttribute('src');
      el.load();
      elRef.current = null;
    }
    setPlayingId('');
  }, []);

  const toggle = useCallback(
    (row: Record<string, unknown>) => {
      const id = String(row.id ?? '');
      if (!id) return;
      if (playingId === id) {
        stop();
        return;
      }
      const src = srcRef.current(row);
      if (!src) return;
      stop();
      const el = new Audio(src);
      el.preload = 'auto';
      const clear = () => {
        if (elRef.current === el) elRef.current = null;
        setPlayingId((cur) => (cur === id ? '' : cur));
      };
      el.onended = clear;
      // 播放失败（404 / 权限不足 / 格式不支持）也要把按钮复位，
      // 否则会一直显示「停止」，用户以为还在播
      el.onerror = clear;
      elRef.current = el;
      setPlayingId(id);
      void el.play().catch(clear);
    },
    [playingId, stop],
  );

  // 页面切走时停掉，避免「人走了还在响」
  useEffect(() => () => stop(), [stop]);

  return { playingId, toggle, stop };
}
