import { Controller, Get, Post, Body, Req, Res, UseGuards, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { SessionUser } from '@acms/contracts';
import { SessionGuard } from '../auth/session.guard.js';
import { ParentService } from './parent.service.js';

/**
 * 家长 H5 端接口（P3）。
 *  - POST /parent/auth/bind   学号 + 姓名绑定，签发 cookie 会话（角色 parent）
 *  - GET  /parent/attendances 仅读所绑定子女考勤
 *  - POST /parent/feedback    提交家长反馈（写家校沟通表）
 */
@Controller('parent')
export class ParentController {
  constructor(private readonly svc: ParentService) {}

  @Post('auth/bind')
  async bind(
    @Body() body: { studentNo?: string; name?: string },
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const user = await this.svc.bind(body.studentNo ?? '', body.name ?? '');
    const secure = (req.headers['x-forwarded-proto'] as string)?.split(',')[0]?.trim() === 'https';
    res.cookie(process.env.SESSION_COOKIE ?? 'acms_sid', user.sessionId, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      maxAge: Number(process.env.SESSION_TTL_SECONDS ?? 3600) * 1000,
      path: '/',
    });
    res.json({
      ok: true,
      studentId: user.studentId,
      name: user.name,
      campus: user.campuses[0] ?? '',
    });
  }

  @Get('attendances')
  @UseGuards(SessionGuard)
  attendances(@Req() req: Request & { user: SessionUser }) {
    const sid = req.user.studentId;
    if (!sid) throw new UnauthorizedException('UNAUTHENTICATED');
    return this.svc.listAttendances(sid);
  }

  @Post('feedback')
  @UseGuards(SessionGuard)
  feedback(@Req() req: Request & { user: SessionUser }, @Body() body: { content?: string; contact?: string }) {
    const sid = req.user.studentId;
    if (!sid) throw new UnauthorizedException('UNAUTHENTICATED');
    return this.svc.submitFeedback(sid, body.content ?? '', body.contact);
  }
}
