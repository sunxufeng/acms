import { NOTE_SOURCE_TYPES, noteTagNames } from '@acms/contracts';

/**
 * 「我的笔记」相关的**展示层共用件**。
 *
 * 为什么抽出来：笔记详情弹窗有两处入口 ——
 *   ① 「我的笔记」页（`app/getnote/page.tsx`，点列表标题）
 *   ② 「我的 IDP」里点沟通记录标题（沟通记录挂着的那篇笔记）
 * 两处都要展示「来源 / 标签 / 更新时间 / 音频 / 总结 / 原始记录」。
 * 各写一份必然漂移（本项目反复踩过：判据或展示只能有一份）。
 *
 * ⚠️ 这里只放**纯函数**，不放组件 —— 组件见 `components/GetnoteNoteModal.tsx`。
 */

/** 来源候选与「来源/标签」的拆分规则统一在 contracts（后端筛选用同一份） */
export const NOTE_TYPES: string[] = [...NOTE_SOURCE_TYPES];

/** 笔记的 tags → 标签名数组（「来源」也是靠 tags 承载的，见 page.tsx 说明） */
export function tagNames(n: Record<string, unknown>): string[] {
  return noteTagNames(n.tags);
}

/** 从标签里挑出「来源」（命中 NOTE_TYPES 的那个），挑不到按得到大脑兜底 */
export function sourceOf(n: Record<string, unknown>): string {
  return tagNames(n).find((x) => NOTE_TYPES.includes(x)) ?? '得到大脑';
}

/** 去掉「来源」之后的普通标签 */
export function plainTagsOf(n: Record<string, unknown>): string[] {
  return tagNames(n).filter((x) => !NOTE_TYPES.includes(x));
}

/**
 * 详情 / 列表行里「已落库的原始音频」元信息。
 *
 * 后端在**详情与列表**返回里都附 `_audio`（只有真下载落库过才有）。没有就返回 null ——
 * 弹窗据此**不渲染播放器**、列表行据此**不渲染播放按钮**，
 * 避免给用户一个点了报错的空壳控件。
 *
 * ⚠️ 播放地址是 `/api/v1/getnote/notes/:id/audio`，**不是**通用的 `/files/:token`：
 *    那个接口登录即可下载，而录音是私密内容；专用接口会做笔记级可见性校验。
 */
export interface NoteAudioMeta {
  token?: string;
  name?: string;
  size?: number;
  type?: string;
  durationMs?: number;
}

export function audioOf(n: Record<string, unknown> | null): NoteAudioMeta | null {
  const a = n?._audio as NoteAudioMeta | null | undefined;
  return a && a.token ? a : null;
}

/**
 * 「这条笔记**有录音、但音频还没抓下来**」（未抓 / 上次失败）—— 后端 `_audioPending`。
 *
 * 🔴 判据必须在**后端**，不能靠前端猜 `note_type`（2026-09-22 修）：
 *    原先操作列只看 `note_type === 'recorder_audio'`，而峰哥报障的那 8 条
 *    **笔记类型并不是 recorder_audio**（正文字段由同步写回，各来源不一）
 *    ⇒ 这些「有录音却没抓」的行在列表里**什么都不显示**，跟纯文本笔记长得一样，
 *    只能靠人工全库体检才发现。
 *    后端用的是正文表里更硬的证据：`附件数 > 0 或 录音卡SN 非空`，且音频未入库。
 */
export function audioPendingOf(n: Record<string, unknown> | null): boolean {
  return Boolean(n?._audioPending);
}

/** 音频播放地址（专用接口，带笔记级可见性校验） */
export function audioSrc(noteId: string): string {
  return `/api/v1/getnote/notes/${encodeURIComponent(noteId)}/audio`;
}

/** 毫秒 → `12:34`（音频播放器旁边显示时长用） */
export function fmtDuration(ms?: number): string {
  const sec = Math.round((Number(ms) || 0) / 1000);
  if (sec <= 0) return '';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
