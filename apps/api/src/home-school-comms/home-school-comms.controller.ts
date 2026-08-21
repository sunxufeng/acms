// @ts-nocheck
import { Controller, Get, Post, Param, Req, Body, Query, UseGuards, BadRequestException } from '@nestjs/common';
import type { Request } from 'express';
import { SessionGuard } from '../auth/session.guard.js';
import type { SessionUser } from '@acms/contracts';
import { HomeSchoolCommsService } from './home-school-comms.service.js';

/**
 * 家校沟通 AI 增强接口。
 * 独立前缀 home-school-comms-ai，避免与通用 CRUD 的 /home-school-comms 路由冲突。
 */
@Controller('home-school-comms-ai')
@UseGuards(SessionGuard)
export class HomeSchoolCommsController {
  constructor(private readonly svc: HomeSchoolCommsService) {}

  private user(req: Request): SessionUser {
    return (req as Request & { user: SessionUser }).user;
  }

  @Get(':id/prepare')
  async prepare(@Req() req: Request, @Param('id') id: string) {
    if (!id) throw new BadRequestException('缺少记录 id');
    return this.svc.prepare(this.user(req), id);
  }

  @Post(':id/summarize')
  async summarize(@Req() req: Request, @Param('id') id: string) {
    if (!id) throw new BadRequestException('缺少记录 id');
    return this.svc.aiSummarize(this.user(req), id);
  }

  @Post(':id/sync-attachment')
  async syncAttachment(
    @Req() req: Request,
    @Param('id') id: string,
    @Body('fileToken') fileToken: string,
    @Body('overwriteDetail') overwriteDetail?: boolean,
  ) {
    if (!id) throw new BadRequestException('缺少记录 id');
    if (!fileToken) throw new BadRequestException('缺少 fileToken');
    return this.svc.syncAttachment(this.user(req), id, fileToken, overwriteDetail);
  }

  @Post(':id/merge-all')
  async mergeAll(
    @Req() req: Request,
    @Param('id') id: string,
    @Body('overwriteDetail') overwriteDetail?: boolean,
    @Body('overwriteSummary') overwriteSummary?: boolean,
  ) {
    if (!id) throw new BadRequestException('缺少记录 id');
    return this.svc.mergeAll(this.user(req), id, overwriteDetail, overwriteSummary);
  }
}
