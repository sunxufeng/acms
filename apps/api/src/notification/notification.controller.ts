import { Controller, Get, Post, Put, Delete, Param, Query, Body, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { SessionUser } from '@acms/contracts';
import { SessionGuard } from '../auth/session.guard.js';
import { NotificationService } from './notification.service.js';
import { CreateTemplateDto, UpdateTemplateDto, TemplateFilterDto, SendDto, BatchSendDto, LogFilterDto, TransitionDto } from './notification.dto.js';

function userOf(req: Request): SessionUser {
  return (req as Request & { user: SessionUser }).user;
}

@Controller('notifications')
@UseGuards(SessionGuard)
export class NotificationController {
  constructor(private readonly svc: NotificationService) {}

  // 模板
  @Get('templates') listTemplates(@Req() req: Request, @Query() q: TemplateFilterDto) { return this.svc.listTemplates(userOf(req), q); }
  @Get('templates/:id') detailTemplate(@Req() req: Request, @Param('id') id: string) { return this.svc.detailTemplate(userOf(req), id); }
  @Post('templates') createTemplate(@Req() req: Request, @Body() dto: CreateTemplateDto) { return this.svc.createTemplate(userOf(req), dto); }
  @Put('templates/:id') updateTemplate(@Req() req: Request, @Param('id') id: string, @Body() dto: UpdateTemplateDto) { return this.svc.updateTemplate(userOf(req), id, dto); }
  @Delete('templates/:id') archiveTemplate(@Req() req: Request, @Param('id') id: string) { return this.svc.archiveTemplate(userOf(req), id); }

  // 发送与回执
  @Get('logs') listLogs(@Req() req: Request, @Query() q: LogFilterDto) { return this.svc.listLogs(userOf(req), q); }
  @Get('logs/:id') detailLog(@Req() req: Request, @Param('id') id: string) { return this.svc.detailLog(userOf(req), id); }
  @Post('send') send(@Req() req: Request, @Body() dto: SendDto) { return this.svc.send(userOf(req), dto); }
  @Post('batch') batchSend(@Req() req: Request, @Body() dto: BatchSendDto) { return this.svc.batchSend(userOf(req), dto); }
  @Post('logs/:id/transition') transitionLog(@Req() req: Request, @Param('id') id: string, @Body() dto: TransitionDto) { return this.svc.transitionLog(userOf(req), id, dto); }
}
