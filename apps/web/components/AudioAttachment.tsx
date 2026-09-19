'use client';

/**
 * 音频附件播放器（编辑表单 / 只读详情共用）。
 *
 * 为什么抽成独立组件（2026-09-19）：原来它只在 `CrudPage` 内部，只有**编辑表单**能用，
 * 而**只读详情页**（`CrudView`）只给下载链接 —— 同一个附件两种待遇，同事想听录音
 * 还得先下载再找播放器。抽出来后两处共用一份。
 *
 * `/api/v1/files/:token` 已支持 `Range` / 206 与 `inline`，进度条可拖、Safari 也能播；
 * ⚠️ 服务端按**文件头**嗅探真实容器（上游同批录音 Ogg/Opus 与 MP3 混杂），别在这里写死 MIME。
 */
export default function AudioAttachment({ token, name }: { token: string; name?: string }) {
  const src = `/api/v1/files/${encodeURIComponent(token)}`;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: 300 }}>
      <audio controls preload="none" src={src} style={{ height: 30, maxWidth: 240 }} />
      {name && (
        <a
          href={src}
          target="_blank"
          rel="noreferrer"
          style={{ color: 'var(--fg-tertiary)', fontSize: 11, whiteSpace: 'nowrap' }}
          title={name}
        >
          原始文件
        </a>
      )}
    </span>
  );
}
