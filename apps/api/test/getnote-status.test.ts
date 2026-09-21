import { describe, expect, it } from 'vitest';
import {
  NOTE_STATUS_ACTIVE,
  NOTE_STATUS_ALL,
  NOTE_STATUS_ARCHIVED,
  NOTE_STATUS_FILTER_OPTIONS,
  isArchivedNote,
  normalizeNoteStatus,
  noteStatusMatches,
} from '@acms/contracts';

/**
 * 「我的笔记」状态（有效 / 归档）判据的契约测试（2026-09-21）。
 *
 * 为什么这些判据值得单独锁死：状态是**纯 ACMS 侧的标记**，历史笔记在上线时
 * 一条状态行都没有 —— 只要判据写成「等于有效」，历史笔记就会被整体筛掉，
 * 界面症状是「筛了『有效』之后一条笔记都没有」，而服务端不报任何错。
 * 前端（列表页的客户端内存筛选分支）与本文件用的是同一份实现，
 * 所以这里锁的是**前后端共用的口径**。
 *
 * 本文件不连数据库、不改任何数据（纯函数），可随时重跑。
 */

describe('normalizeNoteStatus（只有明确「归档」才算归档）', () => {
  it('🔴 历史笔记：undefined / 空串 / 缺字段 ⇒ 一律「有效」', () => {
    // 上线时没有任何状态行，列表接口读到的是 undefined —— 必须归成「有效」
    expect(normalizeNoteStatus(undefined)).toBe(NOTE_STATUS_ACTIVE);
    expect(normalizeNoteStatus(null)).toBe(NOTE_STATUS_ACTIVE);
    expect(normalizeNoteStatus('')).toBe(NOTE_STATUS_ACTIVE);
    expect(normalizeNoteStatus('   ')).toBe(NOTE_STATUS_ACTIVE);
  });

  it('「归档」原样返回；未知值（含历史脏值）保守归成「有效」', () => {
    expect(normalizeNoteStatus(NOTE_STATUS_ARCHIVED)).toBe(NOTE_STATUS_ARCHIVED);
    expect(normalizeNoteStatus(' 归档 ')).toBe(NOTE_STATUS_ARCHIVED);
    // 未知值不隐藏笔记：宁可让它显出来（用户能自己再归档一次），也不要静默藏起来
    expect(normalizeNoteStatus('作废')).toBe(NOTE_STATUS_ACTIVE);
    expect(normalizeNoteStatus(NOTE_STATUS_ACTIVE)).toBe(NOTE_STATUS_ACTIVE);
  });
});

describe('isArchivedNote（列表行标记、按钮互斥、转换闸门共用）', () => {
  it('只有归档为真', () => {
    expect(isArchivedNote(NOTE_STATUS_ARCHIVED)).toBe(true);
    expect(isArchivedNote(NOTE_STATUS_ACTIVE)).toBe(false);
    expect(isArchivedNote(undefined)).toBe(false);
    expect(isArchivedNote('')).toBe(false);
  });
});

describe('noteStatusMatches（筛选：不传 = 不限制）', () => {
  it('want 为空 / 未传 / 「全部」⇒ 不限制', () => {
    expect(noteStatusMatches(NOTE_STATUS_ARCHIVED, undefined)).toBe(true);
    expect(noteStatusMatches(NOTE_STATUS_ARCHIVED, '')).toBe(true);
    expect(noteStatusMatches(NOTE_STATUS_ARCHIVED, NOTE_STATUS_ALL)).toBe(true);
  });

  it('🔴 筛「有效」时，没有状态行的历史笔记必须**留下**（写成等值就会被全筛掉）', () => {
    expect(noteStatusMatches(undefined, NOTE_STATUS_ACTIVE)).toBe(true);
    expect(noteStatusMatches('', NOTE_STATUS_ACTIVE)).toBe(true);
    expect(noteStatusMatches('作废', NOTE_STATUS_ACTIVE)).toBe(true);
    expect(noteStatusMatches(NOTE_STATUS_ACTIVE, NOTE_STATUS_ACTIVE)).toBe(true);
    // 真正的归档笔记才被挡掉
    expect(noteStatusMatches(NOTE_STATUS_ARCHIVED, NOTE_STATUS_ACTIVE)).toBe(false);
  });

  it('筛「归档」只出归档的笔记', () => {
    expect(noteStatusMatches(NOTE_STATUS_ARCHIVED, NOTE_STATUS_ARCHIVED)).toBe(true);
    expect(noteStatusMatches(NOTE_STATUS_ACTIVE, NOTE_STATUS_ARCHIVED)).toBe(false);
    expect(noteStatusMatches(undefined, NOTE_STATUS_ARCHIVED)).toBe(false);
  });
});

describe('筛选下拉候选', () => {
  /**
   * 🔴 候选里**不能有「全部」**（2026-09-21 峰哥报障：下拉里出现两个「全部」）：
   * 通用筛选控件 `FilterSelect` 自己就会在最前面渲染一项「全部」（值是空串 = 不筛），
   * 候选里再放一个同名的就成了两项。判据侧仍认「全部」（见上面的 noteStatusMatches 用例）。
   */
  it('只列真实状态值（「全部」由筛选控件自己提供）', () => {
    expect([...NOTE_STATUS_FILTER_OPTIONS]).toEqual([NOTE_STATUS_ACTIVE, NOTE_STATUS_ARCHIVED]);
    expect([...NOTE_STATUS_FILTER_OPTIONS]).not.toContain(NOTE_STATUS_ALL);
  });
});
