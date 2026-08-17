import { Controller, Get, Param, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { SessionUser } from '@acms/contracts';
import { SessionGuard } from '../auth/session.guard.js';
import { Student360Service } from './student-360.service.js';

@Controller('student-360')
@UseGuards(SessionGuard)
export class Student360Controller {
  constructor(private readonly svc: Student360Service) {}

  private user(req: Request): SessionUser {
    return (req as Request & { user: SessionUser }).user;
  }

  /** 学生 360 视图：聚合某学生的全生命周期记录 */
  @Get(':studentId')
  get(@Req() req: Request, @Param('studentId') studentId: string) {
    return this.svc.getByStudent(this.user(req), studentId);
  }
}
