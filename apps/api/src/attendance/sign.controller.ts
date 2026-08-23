import { Controller, Post, Body, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { SessionUser } from '@acms/contracts';
import { SessionGuard } from '../auth/session.guard.js';
import { SignService } from './sign.service.js';
import { SignDto } from './sign.dto.js';

function userOf(req: Request): SessionUser {
  return (req as Request & { user: SessionUser }).user;
}

/** 移动端打卡（签到）入口，见 docs/student-portal-plan.md §9 / §10(P1)。
 *  路由挂在通用 CRUD 的 /student-attendances 之下，子路径 sign 不与 :id 冲突。 */
@Controller('student-attendances')
@UseGuards(SessionGuard)
export class SignController {
  constructor(private readonly svc: SignService) {}

  @Post('sign')
  sign(@Req() req: Request, @Body() dto: SignDto) {
    const user = userOf(req);
    // 学生会话：以会话绑定的 studentId 为准，避免客户端伪造他人学号
    if (user.studentId) dto.studentId = user.studentId;
    return this.svc.sign(user, dto);
  }
}
