import {
  Controller, Get, Post, Put, Delete, Param, Query, Body, Req, UseGuards, HttpException, HttpStatus,
} from '@nestjs/common';
import type { Request } from 'express';
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
  /** 立即收取该账户邮件（fire & forget，返回触发结果） */
  @Post(':id/sync')
  async sync(@Req() req: Request, @Param('id') id: string) {
    const user = (req as Request & { user: SessionUser }).user;
    if (!authorize({ roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel }, 'mail:write').allowed)
      throw new HttpException('FORBIDDEN:mail:write', HttpStatus.FORBIDDEN);
    const r = await this.archiveSvc.syncAccount(id);
    return r;
  }
}

@Controller('mail-archive')
@UseGuards(SessionGuard)
export class MailArchiveController {
  constructor(private readonly svc: MailArchiveService) {}

  @Get() list(@Req() req: Request, @Query() q: Record<string, string | undefined>) {
    return this.svc.list((req as Request & { user: SessionUser }).user, q);
  }
  @Get(':id') detail(@Req() req: Request, @Param('id') id: string) {
    return this.svc.detail((req as Request & { user: SessionUser }).user, id);
  }
  /** 解析归档附件的临时下载链接（file_token 来自记录「附件信息」JSON） */
  @Get(':id/attachment-url')
  async attachmentUrl(@Req() req: Request, @Param('id') id: string, @Query('file_token') fileToken: string) {
    const user = (req as Request & { user: SessionUser }).user;
    if (!authorize({ roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel }, 'mail:read').allowed)
      throw new HttpException('FORBIDDEN:mail:read', HttpStatus.FORBIDDEN);
    if (!fileToken) throw new HttpException('MISSING_FILE_TOKEN', HttpStatus.BAD_REQUEST);
    const url = await this.svc.getAttachmentUrl(id, fileToken);
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

  /** 手动关联/解除关联学生：body { studentIds: string[] }，传 [] 即清空。需 mail:write。 */
  @Put(':id/link')
  async link(@Req() req: Request, @Param('id') id: string, @Body() body: { studentIds?: string[] }) {
    const user = (req as Request & { user: SessionUser }).user;
    if (!authorize({ roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel }, 'mail:write').allowed)
      throw new HttpException('FORBIDDEN:mail:write', HttpStatus.FORBIDDEN);
    await this.svc.linkStudents(id, body?.studentIds ?? []);
    return { ok: true };
  }
}
