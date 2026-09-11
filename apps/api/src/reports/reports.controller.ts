import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { SessionUser } from '@acms/contracts';
import { SessionGuard } from '../auth/session.guard.js';
import { ReportsService } from './reports.service.js';

function userOf(req: Request): SessionUser {
  return (req as Request & { user: SessionUser }).user;
}

/**
 * 报表数据接口。
 * 独立权限点 report:read——让「只看报表」不必连带开放学生档案读取权限，
 * 且返回的是脱敏投影（维度真值 + 完整度占位符），不含学生明细。
 */
@Controller('reports')
@UseGuards(SessionGuard)
export class ReportsController {
  constructor(private readonly svc: ReportsService) {}

  @Get('students')
  students(@Req() req: Request) {
    return this.svc.studentRows(userOf(req));
  }

  /** 活跃时段统计：登录日志（登录时点）+ 审计日志（写操作） */
  @Get('activity')
  activity(@Req() req: Request, @Query('from') from?: string, @Query('to') to?: string) {
    return this.svc.activity(userOf(req), { from, to });
  }
}
