import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 学生档案「相关邮件」区块的硬口径（2026-09-23）。
 *
 * 背景：峰哥反馈「邮件归档里明明关联了刘欣睿，学生档案的相关邮件却看不到」。
 * 根因是这个区块用了**等值筛选** `关联学生=<学生id>` —— 而「关联学生」是飞书
 * **单向关联字段（type=18）**，服务端对它的等值/contains 一律无效 ⇒ 恒 0 条。
 * 生产实测同一封已关联的邮件：等值筛 **0 条** / `__has` 筛 **2 条**。
 *
 * 本文件钉两类"改错了不会报错、只会静默失灵"的事：
 *   ① 筛选必须走 `关联学生__has`（多值字段成员包含），不能退回等值；
 *   ② 每封邮件必须渲染「发件人」与附件清单（含可下载的文件名）—— 这是明确要求过的信息。
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const page = readFileSync(path.join(here, '..', '..', 'web', 'app', 'students', '[id]', 'page.tsx'), 'utf8');

describe('学生档案「相关邮件」区块', () => {
  it('🔴 用 关联学生__has 精确筛（关联字段不能用等值筛 —— 等值恒 0 条）', () => {
    expect(page).toContain("'关联学生__has'");
    // 旧的错误写法：把「关联学生」当普通字段做等值匹配
    expect(page).not.toMatch(/'关联学生':\s*id/);
  });

  it('每封邮件给出「发件人」与附件（附件名可点下载）', () => {
    expect(page).toContain("t('mailFrom')");
    expect(page).toContain('parseMailAttachments');
    expect(page).toContain('getMailAttachmentUrl');
  });

  it('附件解析与学生档案共用同一份 lib，不各写一份', () => {
    expect(page).toContain("from '../../../lib/mailAttachments'");
  });

  it('发送时间只到年月日（走 formatDate，不是原样输出 ISO 串）', () => {
    expect(page).toContain('formatDate(');
  });
});
