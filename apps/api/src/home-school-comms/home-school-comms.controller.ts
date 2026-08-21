// @ts-nocheck
import { Controller, Post, Param, Req, UseGuards, BadRequestException } from '@nestjs/common';
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

  @Post(':id/summarize')
  async summarize(@Req() req: Request, @Param('id') id: string) {
    if (!id) throw new BadRequestException('缺少记录 id');
    return this.svc.aiSummarize((req as Request & { user: SessionUser }).user, id);
  }
}
