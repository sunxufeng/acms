/**
 * 「笔记正文表」落库时的字段合并规则。
 *
 * 🔴 为什么需要这一层：`persistNoteBody()` 用的是 `sql.createWithId()`，在 SQL 侧是
 *   `ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data` —— **整体替换**，不是合并。
 *   而它的 payload 里只有正文/标题/归属等字段，**没有音频字段**。
 *
 *   偏偏「打开一篇笔记」这条最热的路径也会落一次正文（`detail()` 里 fire-and-forget），
 *   于是：**用户每点开一次笔记，已经抓好的原始音频就被清空一次**。
 *   2026-09-18 实测代价：全量抓完 533 条后随手打开十几篇做验证，
 *   21 条音频被静默打回「未抓取」，表现为播放接口 `404 AUDIO_NOT_FOUND`。
 *
 *   所以规则固定为：**本次没带音频字段 ⇒ 保住旧值；带了（音频任务自己写回）⇒ 以本次为准。**
 *   这样「先落正文、再写音频字段」的顺序才真正安全（原来只在 `grabNoteAudio()` 内部成立，
 *   从外部进来的 `detail()` 落库会把它抹掉）。
 *
 * ⚠️ 返回值里值为 `undefined` 的键会被 `JSON.stringify` 丢掉 —— 首次写入不会凭空造出
 *   空的音频字段（正文表的新行仍然是干净的）。
 */

/** 落在正文表上、且必须「只增不减」的音频相关字段。改字段名时两处一起改。 */
export const NOTE_BODY_AUDIO_FIELDS = [
  '音频附件',
  '音频时长',
  '音频状态',
  '音频抓取时间',
] as const;

export function mergeNoteBodyPayload(
  prev: Record<string, unknown> | null | undefined,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...next };
  const old = prev ?? {};
  for (const key of NOTE_BODY_AUDIO_FIELDS) {
    if (out[key] === undefined && old[key] !== undefined) out[key] = old[key];
  }
  return out;
}
