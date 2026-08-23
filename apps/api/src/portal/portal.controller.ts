import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { SessionUser } from '@acms/contracts';
import { SessionGuard } from '../auth/session.guard.js';
import { PortalService } from './portal.service.js';

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
}
