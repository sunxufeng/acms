import { describe, expect, it } from 'vitest';
import {
  looksLikeAudio,
  sniffAudioFormat,
  withAudioExt,
} from '../src/file-storage/audio-format.js';
import { inlineDisposition, parseByteRange } from '../src/file-storage/byte-range.js';

/**
 * 音频容器嗅探 + HTTP Range 解析的契约测试。
 *
 * 这两块是 2026-09-18 修「部分音频没法播放」时新增的核心判据：
 *   - 落库时把 MIME 写死成 `audio/ogg`，而实际上游给的 554 个录音里有 40 个是 MP3
 *     ⇒ 浏览器按 audio/ogg 解 MP3，解码失败、播放器不出声；
 *   - 录音最长 3 小时 / 单文件 168 MB，服务端不支持 Range 时进度条拖不动，
 *     且 Safari 直接拒绝播放。
 *
 * **纯函数、不碰数据库与磁盘**，可随时重跑。样本用的都是真实文件头字节。
 */

/** 构造指定文件头的样本（内容无所谓，判定只看头部） */
function head(...bytes: number[]): Buffer {
  return Buffer.concat([Buffer.from(bytes), Buffer.alloc(64)]);
}

/** 'OggS' 等 ASCII 头的便捷构造 */
function asciiHead(s: string): Buffer {
  return Buffer.concat([Buffer.from(s, 'latin1'), Buffer.alloc(64)]);
}

describe('sniffAudioFormat：按文件头识别真实容器', () => {
  it('Ogg/Opus（绝大多数录音）', () => {
    expect(sniffAudioFormat(asciiHead('OggS'))).toEqual({ mime: 'audio/ogg', ext: 'ogg' });
  });

  it('MP3（ID3 标签开头）—— 就是报「没法播放」的那一批', () => {
    expect(sniffAudioFormat(asciiHead('ID3'))).toEqual({ mime: 'audio/mpeg', ext: 'mp3' });
  });

  it('MP3（裸帧同步 0xFF Ex）', () => {
    expect(sniffAudioFormat(head(0xff, 0xfb, 0x90, 0x00))).toEqual({
      mime: 'audio/mpeg',
      ext: 'mp3',
    });
  });

  it('WAV（RIFF....WAVE）', () => {
    expect(sniffAudioFormat(asciiHead('RIFF????WAVE'))).toEqual({
      mime: 'audio/wav',
      ext: 'wav',
    });
  });

  it('M4A/MP4（ftyp 在 4~8 字节）', () => {
    expect(sniffAudioFormat(asciiHead('????ftypM4A '))).toEqual({
      mime: 'audio/mp4',
      ext: 'm4a',
    });
  });

  it('FLAC / WebM / AMR', () => {
    expect(sniffAudioFormat(asciiHead('fLaC'))?.ext).toBe('flac');
    expect(sniffAudioFormat(head(0x1a, 0x45, 0xdf, 0xa3))?.ext).toBe('weba');
    expect(sniffAudioFormat(asciiHead('#!AMR'))?.ext).toBe('amr');
  });

  it('非音频容器返回 null（不能把 zip / 文本误判成音频）', () => {
    expect(sniffAudioFormat(asciiHead('PK\u0003\u0004'))).toBeNull();
    expect(sniffAudioFormat(asciiHead('%PDF-1.4'))).toBeNull();
    expect(sniffAudioFormat(Buffer.alloc(4))).toBeNull(); // 太短
  });
});

describe('withAudioExt：把写错的扩展名改回真实格式', () => {
  it('把 .ogg 改成 .mp3（历史数据里的错误名）', () => {
    expect(withAudioExt('1921409905412164160.ogg', 'mp3')).toBe('1921409905412164160.mp3');
  });
  it('已经是正确扩展名时保持不变', () => {
    expect(withAudioExt('a.ogg', 'ogg')).toBe('a.ogg');
  });
  it('没有扩展名时补上', () => {
    expect(withAudioExt('recording', 'mp3')).toBe('recording.mp3');
  });
  it('点开头的隐藏文件名不会被误截', () => {
    expect(withAudioExt('.hidden', 'ogg')).toBe('.hidden.ogg');
  });
});

describe('looksLikeAudio：判断某个附件是不是音频', () => {
  it('MIME 或扩展名任一命中即为音频', () => {
    expect(looksLikeAudio('x.bin', 'audio/ogg')).toBe(true);
    expect(looksLikeAudio('1921409905412164160.ogg')).toBe(true);
    expect(looksLikeAudio('clip.MP3')).toBe(true);
    expect(looksLikeAudio('doc.pdf')).toBe(false);
    expect(looksLikeAudio('noext')).toBe(false);
    expect(looksLikeAudio('')).toBe(false);
  });
});

describe('parseByteRange：单段 Range 解析', () => {
  const SIZE = 1000;

  it('bytes=0- → 全量', () => {
    expect(parseByteRange('bytes=0-', SIZE)).toEqual({ start: 0, end: 999, length: 1000 });
  });

  it('bytes=0-99 → 前 100 字节', () => {
    expect(parseByteRange('bytes=0-99', SIZE)).toEqual({ start: 0, end: 99, length: 100 });
  });

  it('bytes=100-199 → 中段', () => {
    expect(parseByteRange('bytes=100-199', SIZE)).toEqual({ start: 100, end: 199, length: 100 });
  });

  it('bytes=-100 → 末尾 100 字节（浏览器 seek 到尾部时会用）', () => {
    expect(parseByteRange('bytes=-100', SIZE)).toEqual({ start: 900, end: 999, length: 100 });
  });

  it('end 超出文件长度时裁剪到末尾', () => {
    expect(parseByteRange('bytes=900-99999', SIZE)).toEqual({ start: 900, end: 999, length: 100 });
  });

  it('多段只取第一段（媒体元素不会发多段）', () => {
    expect(parseByteRange('bytes=0-9,20-29', SIZE)).toEqual({ start: 0, end: 9, length: 10 });
  });

  it('Safari 探路用的 bytes=0-1 也要能解析', () => {
    expect(parseByteRange('bytes=0-1', SIZE)).toEqual({ start: 0, end: 1, length: 2 });
  });

  it('无 Range / 非法 / 越界一律返回 null（退化为 200 全量，比 416 更能保证「至少能播」）', () => {
    expect(parseByteRange(undefined, SIZE)).toBeNull();
    expect(parseByteRange('', SIZE)).toBeNull();
    expect(parseByteRange('items=0-10', SIZE)).toBeNull();
    expect(parseByteRange('bytes=abc-def', SIZE)).toBeNull();
    expect(parseByteRange('bytes=5-3', SIZE)).toBeNull(); // end < start
    expect(parseByteRange('bytes=1000-', SIZE)).toBeNull(); // start 越界
    expect(parseByteRange('bytes=-0', SIZE)).toBeNull(); // 后缀为 0
    expect(parseByteRange('bytes=0-', 0)).toBeNull(); // 空文件
  });
});

describe('inlineDisposition：音视频内联播放、其余下载', () => {
  it('音频 / 视频 / 图片内联', () => {
    expect(inlineDisposition('audio/ogg')).toBe('inline');
    expect(inlineDisposition('audio/mpeg')).toBe('inline');
    expect(inlineDisposition('video/mp4')).toBe('inline');
    expect(inlineDisposition('image/jpeg')).toBe('inline');
  });
  it('其余保持 attachment（点击即下载）', () => {
    expect(inlineDisposition('application/pdf')).toBe('attachment');
    expect(inlineDisposition('application/octet-stream')).toBe('attachment');
    expect(inlineDisposition(undefined)).toBe('attachment');
  });
});
