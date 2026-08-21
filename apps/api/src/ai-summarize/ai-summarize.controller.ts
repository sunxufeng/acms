// @ts-nocheck
import { Controller, Get, Post, Param, Req, Body, UseGuards, BadRequestException } from '@nestjs/common';
import type { Request } from 'express';
import { SessionGuard } from '../auth/session.guard.js';
import type { SessionUser } from '@acms/contracts';
import { AiSummarizeService } from './ai-summarize.service.js';
import { HOME_SCHOOL_COMMS_CONFIG, DAILY_FOLLOWUP_CONFIG, type AiSummarizeTableConfig } from './ai-summarize.config.js';

/** 通用 AI 总结控制器，由子类指定路由前缀与表配置 */
export class AiSummarizeController {
  constructor(
    protected readonly svc: AiSummarizeService,
    protected readonly cfg: AiSummarizeTableConfig,
  ) {}

  private user(req: Request): SessionUser {
    return (req as Request & { user: SessionUser }).user;
  }

  @Get(':id/prepare')
  async prepare(@Req() req: Request, @Param('id') id: string) {
    if (!id) throw new BadRequestException('缺少记录 id');
    return this.svc.prepare(this.cfg, this.user(req), id);
  }

  @Post(':id/summarize')
  async summarize(@Req() req: Request, @Param('id') id: string) {
    if (!id) throw new BadRequestException('缺少记录 id');
    return this.svc.aiSummarize(this.cfg, this.user(req), id);
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
    return this.svc.syncAttachment(this.cfg, this.user(req), id, fileToken, overwriteDetail);
  }

  @Post(':id/merge-all')
  async mergeAll(
    @Req() req: Request,
    @Param('id') id: string,
    @Body('overwriteDetail') overwriteDetail?: boolean,
    @Body('overwriteSummary') overwriteSummary?: boolean,
  ) {
    if (!id) throw new BadRequestException('缺少记录 id');
    return this.svc.mergeAll(this.cfg, this.user(req), id, overwriteDetail, overwriteSummary);
  }
}

@Controller('home-school-comms-ai')
@UseGuards(SessionGuard)
export class HomeSchoolCommsAiController extends AiSummarizeController {
  constructor(svc: AiSummarizeService) {
    super(svc, HOME_SCHOOL_COMMS_CONFIG);
  }
}

@Controller('daily-followups-ai')
@UseGuards(SessionGuard)
export class DailyFollowupAiController extends AiSummarizeController {
  constructor(svc: AiSummarizeService) {
    super(svc, DAILY_FOLLOWUP_CONFIG);
  }
}
