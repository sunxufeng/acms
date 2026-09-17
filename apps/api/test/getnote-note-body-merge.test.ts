import { describe, expect, it } from 'vitest';
import { mergeNoteBodyPayload } from '../src/getnote/note-body-merge.js';

/**
 * 「落正文不能抹掉音频」的契约测试。
 *
 * 这条不变量很容易被无意破坏：`persistNoteBody()` 走 `createWithId`（**整体替换**），
 * 而 `detail()` 每次打开笔记都会落一次正文 —— 一旦 payload 里漏了音频字段，
 * 用户「点开一次笔记」就等于把音频删了。
 *
 * 2026-09-18 实测代价：全量抓完 533 条后打开十几篇验证，21 条音频被打回未抓取，
 * 播放接口返回 `404 AUDIO_NOT_FOUND`。
 */

/** 一条「已抓过音频」的正文行（字段名与生产一致） */
const PREV = {
  笔记ID: '1921583586373540256',
  标题: '某次会议',
  总结: '总结正文',
  原始记录: '逐字稿正文',
  归属人: '吴洁｜Joyce',
  音频附件: [{ file_token: 'loc_abc', name: 'x.ogg', size: 12345, type: 'audio/ogg' }],
  音频时长: 730720,
  音频状态: '已保存',
  音频抓取时间: 1789685935000,
};

describe('mergeNoteBodyPayload（落正文时保住音频）', () => {
  it('🔴 本次不带音频字段 ⇒ 四个音频字段全部保留旧值（核心回归）', () => {
    const out = mergeNoteBodyPayload(PREV, { 笔记ID: PREV.笔记ID, 标题: '某次会议（改名）', 总结: '新总结' });
    expect(out['音频状态']).toBe('已保存');
    expect(out['音频附件']).toEqual(PREV.音频附件);
    expect(out['音频时长']).toBe(730720);
    expect(out['音频抓取时间']).toBe(1789685935000);
    // 正文本身要以新的为准
    expect(out['总结']).toBe('新总结');
    expect(out['标题']).toBe('某次会议（改名）');
  });

  it('本次**带了**音频字段 ⇒ 以本次为准（音频任务自己写回时不能被旧值挡住）', () => {
    const out = mergeNoteBodyPayload(PREV, { 音频状态: '上游无音频', 音频附件: [] });
    expect(out['音频状态']).toBe('上游无音频');
    expect(out['音频附件']).toEqual([]);
    // 没带的两个仍然保住旧值
    expect(out['音频时长']).toBe(730720);
  });

  it('首次写入（没有旧行）⇒ 不凭空造出音频字段（否则会被误判成「抓过但失败」）', () => {
    const out = mergeNoteBodyPayload(null, { 笔记ID: 'x', 标题: '新笔记' });
    expect('音频状态' in out).toBe(false);
    expect('音频附件' in out).toBe(false);
    // 关键：JSON 序列化后这些键必须真的消失（值仍是 undefined 就不算干净）
    expect(Object.keys(JSON.parse(JSON.stringify(out)))).not.toContain('音频状态');
  });

  it('旧行存在但没有音频字段 ⇒ 不会塞进 undefined', () => {
    const out = mergeNoteBodyPayload({ 标题: '老笔记' }, { 标题: '新的' });
    expect('音频状态' in out).toBe(false);
  });

  it('不修改入参（避免调用方复用同一个对象时被串改）', () => {
    const prev = { ...PREV };
    const next = { 标题: 'x' };
    mergeNoteBodyPayload(prev, next);
    expect(prev['音频状态']).toBe('已保存');
    expect(Object.keys(next)).toEqual(['标题']);
  });

  it('旧值是空数组/0 也照样保留（「已保存 0 字节」与「没抓过」语义不同，不能混淆）', () => {
    const out = mergeNoteBodyPayload({ 音频状态: '', 音频时长: 0 }, { 标题: 'x' });
    expect(out['音频状态']).toBe('');
    expect(out['音频时长']).toBe(0);
  });
});
