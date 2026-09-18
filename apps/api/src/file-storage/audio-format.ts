/**
 * 按**文件头字节**判断音频真实格式。
 *
 * ── 为什么必须有这个 ────────────────────────────────────────────────
 * 笔记的原始音频是从得到 CDN 直链下载的，而上游对同一批录音**并不保证同一容器**：
 * 实测 554 个已落库音频里 514 个是 Ogg/Opus、**40 个其实是 MP3**。
 * 而落库代码当时把 MIME 与扩展名**写死**成 `audio/ogg`，于是那 40 个文件
 * 带着「我是 Ogg」的错误名片被存下来 —— 浏览器按 `audio/ogg` 解 MP3 字节流，
 * 解码器起不来，**播放器直接报错不出声**（2026-09-18 峰哥报「部分音频没法播放」）。
 *
 * 因此：下载时按内容命名、播放时按内容给 Content-Type，两处都以本函数为准。
 *
 * ⚠️ 用途边界：本函数只在「已知这是音频」的上下文里调用（笔记音频、音频附件）。
 *    不要拿它去判断任意附件 —— MP3 帧同步头（0xFF Ex）过于宽松，会把一些
 *    二进制文件误判成音频。
 */

export interface AudioFormat {
  /** 正确的 MIME，直接用于 Content-Type */
  mime: string;
  /** 正确的扩展名（不含点） */
  ext: string;
}

/** 常见的音频扩展名 —— 用于「文件名看起来是不是音频」的判断 */
const AUDIO_EXTS = new Set([
  'ogg',
  'oga',
  'opus',
  'mp3',
  'm4a',
  'mp4',
  'aac',
  'wav',
  'flac',
  'weba',
  'webm',
  'amr',
  'wma',
  '3gp',
]);

/**
 * 嗅探音频真实格式；不是已知音频容器则返回 null。
 *
 * 判定顺序有讲究：先认签名明确的容器（Ogg/RIFF/ftyp/flac/AMR/webm），
 * 最后才认宽松的 MP3 帧同步头，避免把别的格式误判成 MP3。
 */
export function sniffAudioFormat(buf: Buffer): AudioFormat | null {
  // 最短的签名判定需要 12 字节（RIFF + WAVE 在 8~12 字节）
  if (!buf || buf.length < 12) return null;

  const b0_4 = buf.subarray(0, 4).toString('latin1');
  const b4_8 = buf.subarray(4, 8).toString('latin1');
  const b8_12 = buf.subarray(8, 12).toString('latin1');

  // Ogg（Opus / Vorbis / FLAC-in-Ogg）
  if (b0_4 === 'OggS') return { mime: 'audio/ogg', ext: 'ogg' };
  // RIFF/WAVE
  if (b0_4 === 'RIFF' && b8_12 === 'WAVE') return { mime: 'audio/wav', ext: 'wav' };
  // ISO BMFF：M4A / MP4（AAC）
  if (b4_8 === 'ftyp') return { mime: 'audio/mp4', ext: 'm4a' };
  // FLAC
  if (b0_4 === 'fLaC') return { mime: 'audio/flac', ext: 'flac' };
  // WebM / Matroska
  if (buf.subarray(0, 4).toString('hex') === '1a45dfa3') return { mime: 'audio/webm', ext: 'weba' };
  // AMR（部分安卓录音笔）
  if (buf.subarray(0, 5).toString('latin1') === '#!AMR') return { mime: 'audio/amr', ext: 'amr' };
  // MP3：ID3v2 标签开头
  if (buf.subarray(0, 3).toString('latin1') === 'ID3') return { mime: 'audio/mpeg', ext: 'mp3' };
  // MP3：裸帧同步（11 位全 1 + 合法层/版本位）。放最后，因为它最宽松。
  if (buf[0] === 0xff && (buf[1] ?? 0) >= 0xe0) return { mime: 'audio/mpeg', ext: 'mp3' };

  return null;
}

/** 文件名（或 mime）看起来是不是音频 */
export function looksLikeAudio(filename?: string, mime?: string): boolean {
  if (mime && mime.toLowerCase().startsWith('audio/')) return true;
  const name = String(filename ?? '').toLowerCase();
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  return AUDIO_EXTS.has(name.slice(dot + 1));
}

/**
 * 把文件名换成与真实格式一致的扩展名。
 * `1921409905412164160.ogg` + mp3 → `1921409905412164160.mp3`
 * 名字里原本就没有扩展名时，直接补上。
 */
export function withAudioExt(filename: string, ext: string): string {
  const name = String(filename ?? '').trim() || 'audio';
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return `${stem}.${ext}`;
}
