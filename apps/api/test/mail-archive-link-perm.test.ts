import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * 邮件归档「关联学生 / 联系人」的权限口径（2026-09-23）。
 *
 * 背景：招生老师（角色 Phase1）点「+ 加入」报 `FORBIDDEN:module:mailArchive:update`。
 * 查生产权限矩阵：`update` **只有系统管理员与院级管理两个角色有**，Phase1–Phase8 全都没有
 * ⇒ 除管理员外，谁都用不了这个功能。
 *
 * 定案（峰哥确认）：该接口判 `read` —— 它**自己过了行级数据范围**（`svc.link()` 里的
 * `rowVisible`），所以「看得见的邮件就能整理它的关联」，不放大可见范围；
 * 而 `update` 在别处还被 `sync-all` / `:id/sync` 复用（会取用 IMAP 凭证），不该发给老师。
 *
 * 这几条是**源码级守卫**（与学生档案的自动带出守卫同一思路）：本文件的价值不在"现在对"，
 * 而在**别人改回去时立刻红**——因为改回去不会有任何类型错误，只会让 11 个角色静默失效。
 */

const ctrl = readFileSync(new URL('../src/mail-archive/mail-archive.controller.ts', import.meta.url), 'utf8');
const svc = readFileSync(new URL('../src/mail-archive/mail-archive.service.ts', import.meta.url), 'utf8');

describe('邮件归档 link 接口的权限判据', () => {
  it('🔴 判 module:mailArchive:read，不判 update（判 update ⇒ 除管理员外全部 403）', () => {
    const i = ctrl.indexOf("@Put(':id/link')");
    expect(i, '找不到 @Put(\':id/link\') 路由').toBeGreaterThan(-1);
    const body = ctrl.slice(i, i + 1400);
    expect(body).toContain("'module:mailArchive:read'");
    expect(body).not.toContain("'module:mailArchive:update'");
  });

  it('同一文件里仍然保留 update 判据的其它接口（说明降级是「只动 link」，不是全站放宽）', () => {
    // sync-all / :id/sync 会取用 IMAP 凭证 ⇒ 必须继续要求 update
    expect(ctrl).toContain("'module:mailArchive:update'");
  });
});

describe('邮件归档 account-options 路由', () => {
  it("🔴 静态路由排在 @Get(':id') 之前（否则被吃成 id='account-options' → 404）", () => {
    // ⚠️ 必须在 **MailArchiveController 这一段之内**比较：
    //    同一文件里 MailAccountController 也有自己的 @Get(':id')，从文件头 indexOf 会取到那一个。
    const archivePart = ctrl.slice(ctrl.indexOf("@Controller('mail-archive')"));
    expect(archivePart.length, "找不到 @Controller('mail-archive') 段").toBeGreaterThan(0);
    const mine = archivePart.indexOf("@Get('account-options')");
    // ⚠️ 锚点要带处理函数名：文件里多处**注释**也写着 `@Get(':id')`（提醒路由顺序），
    //    光找 `@Get(':id')` 会命中注释、得到恒真/恒假的假结论。
    const dyn = archivePart.indexOf("@Get(':id') detail(");
    expect(mine, 'account-options 路由不存在').toBeGreaterThan(-1);
    expect(dyn).toBeGreaterThan(-1);
    expect(mine).toBeLessThan(dyn);
  });

  it('候选只回「可见账户」：复用 visibleAccounts，不另写一份可见性判据', () => {
    const i = svc.indexOf('async accountOptions(');
    expect(i, 'accountOptions 方法不存在').toBeGreaterThan(-1);
    const body = svc.slice(i, i + 1200);
    expect(body).toContain('this.visibleAccounts(');
    // 一旦有人在这里另写「按创建者查账户」之类的第二份判据，就会与行级范围分叉
    expect(body).not.toContain('创建者openId');
  });
});

describe('列表注入的「邮箱」字段', () => {
  it('按「归属账户」（账户名称）换算，而不是拿邮箱直接去匹配记录字段', () => {
    const i = svc.indexOf("it['邮箱']");
    expect(i, '列表没有注入「邮箱」字段').toBeGreaterThan(-1);
    const around = svc.slice(Math.max(0, i - 400), i + 200);
    expect(around).toContain("it['归属账户']");
  });
});
