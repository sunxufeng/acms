import { Controller, Post, Body, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { SessionUser } from '@acms/contracts';
import { SessionGuard } from '../auth/session.guard.js';
import { SessionService } from './session.service.js';
import type { PrecheckConflictDto } from './session.dto.js';
import { requireModule } from '../shared/require-module.js';

@Controller('schedule')
@UseGuards(SessionGuard)
export class ScheduleController {
  constructor(private readonly svc: SessionService) {}

  /** 排课冲突预检：传入拟排课次，返回 hard/soft 冲突（BR-006） */
  @Post('conflicts:precheck')
  async precheck(@Req() req: Request, @Body() body: PrecheckConflictDto) {
    const user = (req as Request & { user: SessionUser }).user;
    requireModule(user, 'schedule', 'read');
    return this.svc.precheckConflicts({
      id: body.id ?? '',
      课次日期: body.课次日期,
      开始时间: body.开始时间,
      结束时间: body.结束时间,
      教学班文本: body.教学班文本,
      授课教师文本: body.授课教师文本,
      场地文本: body.场地文本,
    });
  }
}
