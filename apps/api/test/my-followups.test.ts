import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 「我的跟进」（招生管理 › 我的跟进）的硬口径 —— 2026-09-24 新增。
 *
 * 这是一个**跨四张表的聚合视图**：联系人（主体）+ 卫瓴跟进记录 + 招生跟进 + 邮件归档。
 * 下面每一条都是「写错了不会报错、只会静默少数据 / 静默失灵」的类型，所以用源码级守卫钉住。
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p: string[]) => readFileSync(path.join(here, '..', '..', ...p), 'utf8');

const svc = read('api', 'src', 'my-followups', 'my-followups.service.ts');
const ctrl = read('api', 'src', 'my-followups', 'my-followups.controller.ts');
const page = read('web', 'app', 'my-followups', 'page.tsx');

describe('我的跟进 · 后端聚合', () => {
  it('🔴 关联字段（招生跟进 / 邮件）必须用 idsOf 解析，不能当普通字段比', () => {
    // 「关联联系人」是飞书单向关联字段：原始值是 record id 数组（JSON 文本），
    // 等值 / contains 对它一律无效 —— 必须 idsOf 解析后按成员归到联系人头上。
    expect(svc).toContain("idsOf(r['关联联系人'])");
    expect(svc).toContain('sourceRows');
    expect(svc).toContain('mailRows');
  });

  it('🔴 时间一律走 toEpochMs（三类时间形态不同：毫秒戳 / ISO / UTC 串）', () => {
    expect(svc).toContain('function toEpochMs');
    expect(svc).toContain("toEpochMs(r['跟进时间'])");
    expect(svc).toContain("toEpochMs(r['发送时间'])");
    // 直接 Number() 会让整条记录被当成"没有时间"
    expect(svc).not.toMatch(/at:\s*Number\(/);
  });

  it('权限复用联系人读权限（不新增权限点，否则除管理员外谁都没有）', () => {
    expect(svc).toContain("requireModule(user, 'weilingContacts', 'read')");
    expect(ctrl).toContain('SessionGuard');
  });

  it('归属人：登录人姓名取主体后匹配，且允许 owner 参数覆盖（识别不准时能手动切）', () => {
    expect(svc).toContain('function nameCore');
    expect(svc).toContain('const asked = String(query.owner');
    expect(svc).toContain('asked || inferred');
  });

  it('索引带 TTL 缓存（全表扫约万行，不能每次翻页都重扫）', () => {
    expect(svc).toContain('INDEX_TTL_MS');
    expect(svc).toContain('this.index && Date.now() - this.index.at < INDEX_TTL_MS');
  });
});

describe('我的跟进 · 前端交互', () => {
  it('行内直接给「最近一条摘要」（0 次点击看进展）', () => {
    expect(page).toContain("t('lastPrefix')");
    expect(page).toContain('lastSummary');
  });

  it('展开是就地展开（不跳新页面），且状态写进地址栏', () => {
    expect(page).toContain('readOpenFromUrl');
    expect(page).toContain('writeOpenToUrl');
    expect(page).toContain('toggle(it.id)');
  });

  it('hover 预览只在支持悬停的设备上开（手机不做）', () => {
    expect(page).toContain("matchMedia('(hover: hover)')");
    expect(page).toContain('canHover');
  });

  it('「查看全部」的去处带上了该联系人筛选（招生跟进 / 邮件用 __has / related）', () => {
    expect(page).toContain('关联联系人__has=');
    expect(page).toContain('related=');
  });
});
