import { Controller, Get, Post, Body, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { SessionUser } from '@acms/contracts';
import { SessionGuard } from '../auth/session.guard.js';
import { PortalService, type PortalSignDto } from './portal.service.js';

function userOf(req: Request): SessionUser {
  return (req as Request & { user: SessionUser }).user;
}

@Controller('portal')
@UseGuards(SessionGuard)
export class PortalController {
  constructor(private readonly svc: PortalService) {}

  /** 本人档案 */
  @Get('me') me(@Req() req: Request) {
    return this.svc.me(userOf(req));
  }

  /** 学业成绩（只读） */
  @Get('grades') grades(@Req() req: Request) {
    return this.svc.grades(userOf(req));
  }

  /** 周课表 */
  @Get('schedule') schedule(@Req() req: Request) {
    return this.svc.schedule(userOf(req));
  }

  /** 授课教师简介 */
  @Get('teachers') teachers(@Req() req: Request) {
    return this.svc.teachers(userOf(req));
  }

  /** 本人考勤记录（只读） */
  @Get('attendances') attendances(@Req() req: Request) {
    return this.svc.attendances(userOf(req));
  }

  /** 一键打卡（学生本人，复用 SignService 围栏校验与去重） */
  @Post('sign') sign(@Req() req: Request, @Body() dto: PortalSignDto) {
    return this.svc.sign(userOf(req), dto);
  }
}
