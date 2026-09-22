import {
  Controller, Get, Post, Put, Delete, Param, Query, Body, Req, Res, UseGuards, HttpException, HttpStatus,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { authorize } from '@acms/domain';
import type { SessionUser } from '@acms/contracts';
import { SessionGuard } from '../auth/session.guard.js';
import { MailAccountService } from './mail-account.service.js';
import { MailArchiveService } from './mail-archive.service.js';

@Controller('mail-accounts')
@UseGuards(SessionGuard)
export class MailAccountController {
  constructor(
    private readonly svc: MailAccountService,
    private readonly archiveSvc: MailArchiveService,
  ) {}

  @Get() list(@Req() req: Request, @Query() q: Record<string, string | undefined>) {
    return this.svc.list((req as Request & { user: SessionUser }).user, q);
  }
  /** 导出 CSV（⚠️ 同样必须排在 `@Get(':id')` 之前，否则被吃成 id='export' → 404） */
  @Get('export')
  async exportCsv(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const user = (req as Request & { user: SessionUser }).user;
    const { csv, filename } = await this.svc.exportCsv(user);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    return csv;
  }
  @Get(':id') detail(@Req() req: Request, @Param('id') id: string) {
    return this.svc.detail((req as Request & { user: SessionUser }).user, id);
  }
  @Post() create(@Req() req: Request, @Body() body: Record<string, unknown>) {
    return this.svc.create((req as Request & { user: SessionUser }).user, body);
  }
  @Put(':id') update(@Req() req: Request, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.svc.update((req as Request & { user: SessionUser }).user, id, body);
  }
  @Delete(':id') archive(@Req() req: Request, @Param('id') id: string) {
    return this.svc.archive((req as Request & { user: SessionUser }).user, id);
  }
  /**
   * 立即收取该账户邮件。
   * 改为**异步**：立即返回 202，同步在后台跑，前端轮询 sync-status 展示进度。
   * 大邮箱（数百封）同步要几分钟，同步阻塞 HTTP 会被 nginx 掐断成 504。
   */
  @Post(':id/sync')
  async sync(@Req() req: Request, @Param('id') id: string) {
    const user = (req as Request & { user: SessionUser }).user;
    if (!authorize({ roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel }, 'module:mailArchive:update').allowed)
      throw new HttpException('FORBIDDEN:module:mailArchive:update', HttpStatus.FORBIDDEN);
    return this.archiveSvc.startSync(id);
  }

  /** 查询该账户当前/最近一次同步进度。⚠️ 必须声明在 @Get(':id') 之前，否则会被 :id 路由吃掉 */
  @Get(':id/sync-status')
  async syncStatus(@Req() req: Request, @Param('id') id: string) {
    const user = (req as Request & { user: SessionUser }).user;
    if (!authorize({ roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel }, 'module:mailArchive:read').allowed)
      throw new HttpException('FORBIDDEN:module:mailArchive:read', HttpStatus.FORBIDDEN);
    return this.archiveSvc.getSyncStatus(id);
  }
}

@Controller('mail-archive')
@UseGuards(SessionGuard)
export class MailArchiveController {
  constructor(private readonly svc: MailArchiveService) {}

  @Get() list(@Req() req: Request, @Query() q: Record<string, string | undefined>) {
    return this.svc.list((req as Request & { user: SessionUser }).user, q);
  }
  /**
   * 导出 CSV。
   *
   * ⚠️ 这个路由**必须声明在 `@Get(':id')` 之前**（Nest 按声明顺序匹配）：
   * 本模块用的是自建 controller，不走 GenericCrudModule 里那个已排好序的 GController，
   * 此前漏了这条 ⇒ `/mail-archive/export` 被 `@Get(':id')` 捕获成 id='export'，
   * 详情查不到记录直接 404，页面上点「导出」永远是 NOT_FOUND。
   * ⚠️ 范围由 `exportCsv` 内部的行级范围保证（与列表同源），不是导出全表。
   */
  @Get('export')
  async exportCsv(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const user = (req as Request & { user: SessionUser }).user;
    const { csv, filename } = await this.svc.exportCsv(user);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    return csv;
  }
  /** 列表页筛选下拉的动态候选项（发件人/收件人/归属账户/邮箱文件夹/关联学生的真实去重值） */
  @Get('filter-options')
  async filterOptions(@Req() req: Request) {
    const user = (req as Request & { user: SessionUser }).user;
    if (!authorize({ roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel }, 'module:mailArchive:read').allowed)
      throw new HttpException('FORBIDDEN:module:mailArchive:read', HttpStatus.FORBIDDEN);
    return this.svc.getFilterOptions(user);
  }
  /**
   * 列表页「邮箱」筛选的候选 = 当前用户**可见**的邮件账户（账户名称 + 邮箱地址）。
   *
   * 为什么要单独一个接口：列表页的下拉要「**显示邮箱地址、提交账户名称**」
   * （归档记录里存的「归属账户」是账户名，直接拿邮箱去等值匹配会一条都筛不出来），
   * 而 `filter-options` 返回的是 `Record<string, string[]>`，表达不了「值 → 显示名」的映射。
   *
   * ⚠️ 必须声明在 `@Get(':id')` **之前** —— Nest 按声明顺序匹配，否则被吃成
   *    id='account-options' → 404（filter-options / export 都踩过这个坑）。
   * 只回可见账户：否则非管理员的下拉里会列出全公司的邮箱账户（既是信息泄露，
   * 选了也筛不出东西 —— 会被行级范围 AND 掉）。
   */
  @Get('account-options')
  async accountOptions(@Req() req: Request) {
    const user = (req as Request & { user: SessionUser }).user;
    if (!authorize({ roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel }, 'module:mailArchive:read').allowed)
      throw new HttpException('FORBIDDEN:module:mailArchive:read', HttpStatus.FORBIDDEN);
    return this.svc.accountOptions(user);
  }
  @Get(':id') detail(@Req() req: Request, @Param('id') id: string) {
    return this.svc.detail((req as Request & { user: SessionUser }).user, id);
  }
  /**
   * 解析归档附件的临时下载链接（file_token 来自记录「附件信息」JSON）。
   *
   * ⚠️ 这里必须显式过一道**行级数据范围**：本路由是自建的，不经过 detail()，
   * 只判 mail:read 的话，任何一个持有 mail:read 的人拿到 (record id + file_token)
   * 就能把别人邮箱里的附件下走 —— 邮件隔离就白做了。越界按 404 处理。
   */
  @Get(':id/attachment-url')
  async attachmentUrl(@Req() req: Request, @Param('id') id: string, @Query('file_token') fileToken: string) {
    const user = (req as Request & { user: SessionUser }).user;
    if (!authorize({ roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel }, 'module:mailArchive:read').allowed)
      throw new HttpException('FORBIDDEN:module:mailArchive:read', HttpStatus.FORBIDDEN);
    if (!fileToken) throw new HttpException('MISSING_FILE_TOKEN', HttpStatus.BAD_REQUEST);
    if (!(await this.svc.rowVisible(user, id))) throw new HttpException('NOT_FOUND', HttpStatus.NOT_FOUND);
    const url = await this.svc.getAttachmentUrl(fileToken);
    return { url };
  }
  /** 立即同步全部启用账户 */
  @Post('sync-all')
  async syncAll(@Req() req: Request) {
    const user = (req as Request & { user: SessionUser }).user;
    if (!authorize({ roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel }, 'module:mailArchive:update').allowed)
      throw new HttpException('FORBIDDEN:module:mailArchive:update', HttpStatus.FORBIDDEN);
    return this.svc.syncAll();
  }

  /**
   * 手动关联/解除关联：body `{ studentIds?: string[]; contactIds?: string[] }`，传 [] 即清空。
   * 只传其中一类时另一类保持不动（前端「+ 学生」/「+ 联系人」两个入口共用本接口）。
   *
   * 🔴 判据是 **read** 而不是 update（2026-09-23 峰哥确认）。
   *
   * 起因：招生老师（角色 Phase1，只有 `mail:read`）点「+ 加入」被
   * `FORBIDDEN:module:mailArchive:update` 挡住 —— 而生产权限矩阵里 `update`
   * **只有系统管理员与院级管理两个角色有**（Phase1–Phase8 全都没有）。
   *
   * 为什么降到 read 是安全的：
   *  ① 本接口**自己过了行级数据范围**（`svc.link()` 里的 `rowVisible(user, recordId)`，
   *     见 mail-archive.service.ts 的注释）—— 越界记录一律 404，拦得住。
   *     所以实际效果是「**你看得见的邮件，你就能整理它的关联**」，不放大任何可见范围。
   *  ② `update` 在别处还被 `sync-all`（立即同步全部账户）与 `:id/sync`（单账户同步）复用，
   *     那两个动作会**取用 IMAP 凭证**，语义是「配置邮箱账户」；把 update 发给老师等于
   *     顺带把同步权给出去。而「把这封邮件挂到某个学生名下」是整理归档的业务动作，
   *     与「看归档」同一层级，不该要求账户配置权。
   *
   * ⚠️ 别"好心"改回 update：一改回去，招生/班主任等 11 个角色当天就不能用了。
   */
  @Put(':id/link')
  async link(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: { studentIds?: string[]; contactIds?: string[] },
  ) {
    const user = (req as Request & { user: SessionUser }).user;
    if (!authorize({ roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel }, 'module:mailArchive:read').allowed)
      throw new HttpException('FORBIDDEN:module:mailArchive:read', HttpStatus.FORBIDDEN);
    await this.svc.link(user, id, { studentIds: body?.studentIds, contactIds: body?.contactIds });
    return { ok: true };
  }
}
