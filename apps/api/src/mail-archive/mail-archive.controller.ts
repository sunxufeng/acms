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
    if (!authorize({ roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel }, 'mail:write').allowed)
      throw new HttpException('FORBIDDEN:mail:write', HttpStatus.FORBIDDEN);
    return this.archiveSvc.startSync(id);
  }

  /** 查询该账户当前/最近一次同步进度。⚠️ 必须声明在 @Get(':id') 之前，否则会被 :id 路由吃掉 */
  @Get(':id/sync-status')
  async syncStatus(@Req() req: Request, @Param('id') id: string) {
    const user = (req as Request & { user: SessionUser }).user;
    if (!authorize({ roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel }, 'mail:read').allowed)
      throw new HttpException('FORBIDDEN:mail:read', HttpStatus.FORBIDDEN);
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
    if (!authorize({ roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel }, 'mail:read').allowed)
      throw new HttpException('FORBIDDEN:mail:read', HttpStatus.FORBIDDEN);
    return this.svc.getFilterOptions(user);
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
    if (!authorize({ roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel }, 'mail:read').allowed)
      throw new HttpException('FORBIDDEN:mail:read', HttpStatus.FORBIDDEN);
    if (!fileToken) throw new HttpException('MISSING_FILE_TOKEN', HttpStatus.BAD_REQUEST);
    if (!(await this.svc.rowVisible(user, id))) throw new HttpException('NOT_FOUND', HttpStatus.NOT_FOUND);
    const url = await this.svc.getAttachmentUrl(fileToken);
    return { url };
  }
  /** 立即同步全部启用账户 */
  @Post('sync-all')
  async syncAll(@Req() req: Request) {
    const user = (req as Request & { user: SessionUser }).user;
    if (!authorize({ roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel }, 'mail:write').allowed)
      throw new HttpException('FORBIDDEN:mail:write', HttpStatus.FORBIDDEN);
    return this.svc.syncAll();
  }

  /**
   * 手动关联/解除关联：body `{ studentIds?: string[]; contactIds?: string[] }`，传 [] 即清空。
   * 只传其中一类时另一类保持不动（前端「+ 学生」/「+ 联系人」两个入口共用本接口）。
   */
  @Put(':id/link')
  async link(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: { studentIds?: string[]; contactIds?: string[] },
  ) {
    const user = (req as Request & { user: SessionUser }).user;
    if (!authorize({ roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel }, 'mail:write').allowed)
      throw new HttpException('FORBIDDEN:mail:write', HttpStatus.FORBIDDEN);
    await this.svc.link(user, id, { studentIds: body?.studentIds, contactIds: body?.contactIds });
    return { ok: true };
  }
}
