/**
 * HTTP Range 请求支持（音频 / 视频等需要边下边播的附件）。
 *
 * ── 为什么必须有 ────────────────────────────────────────────────────
 * `<audio>` / `<video>` 元素不是「先下完再放」：浏览器会先发一个 `Range: bytes=0-`
 * 探路，播放中拖动进度条再发新的 Range。
 *
 * 服务端如果忽略 Range、对每个请求都回 200 + 整个文件：
 *   - Chrome / Firefox 一般还能从头播，但**拖动进度条会失效**（每次重新拉全量）；
 *   - **Safari / iOS 直接拒绝播放**（它要求服务端支持 Range）。
 * 笔记录音动辄 2~3 小时、单文件最大 168 MB，靠「全量返流」体验极差，
 * 所以这里按 RFC 7233 实现单段 Range。
 *
 * ⚠️ 只支持**单段** Range（多段 `bytes=0-1,5-6` 只取第一段）。
 *    媒体元素从不用多段，multi-part/byteranges 的实现成本不划算。
 */

export interface ByteRange {
  start: number;
  /** 闭区间上界（含），已按文件大小裁剪 */
  end: number;
  /** 本次返回的字节数 */
  length: number;
}

/**
 * 解析 Range 头。
 *
 * 返回 null 表示「没有可用的 Range」—— 调用方回 200 + 全量。
 * ⚠️ 刻意**不返回 416**：Range 写坏 / 越界时，回全量比回 416 更能保证「至少能播」，
 *    而媒体播放器对 200 全量的接受度远高于对 416 的。只有文件本身缺失才 404。
 */
export function parseByteRange(header: string | undefined, size: number): ByteRange | null {
  const raw = String(header ?? '').trim();
  if (!raw || size <= 0) return null;
  if (!raw.toLowerCase().startsWith('bytes=')) return null;

  // 多段只取第一段（媒体元素不会发多段）
  const spec = raw.slice(6).split(',')[0]?.trim() ?? '';
  if (!spec) return null;

  const dash = spec.indexOf('-');
  if (dash < 0) return null;
  const startRaw = spec.slice(0, dash).trim();
  const endRaw = spec.slice(dash + 1).trim();

  let start: number;
  let end: number;

  if (startRaw === '') {
    // `bytes=-N`：最后 N 字节
    const suffix = Number(endRaw);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startRaw);
    if (!Number.isFinite(start) || start < 0) return null;
    if (start >= size) return null;
    if (endRaw === '') {
      end = size - 1;
    } else {
      end = Number(endRaw);
      if (!Number.isFinite(end) || end < start) return null;
      end = Math.min(end, size - 1);
    }
  }

  return { start, end, length: end - start + 1 };
}

/** 文件是否需要按音频内联播放（而非作为附件下载） */
export function inlineDisposition(mime: string | undefined): 'inline' | 'attachment' {
  const m = String(mime ?? '').toLowerCase();
  if (m.startsWith('audio/') || m.startsWith('video/') || m.startsWith('image/')) return 'inline';
  return 'attachment';
}
