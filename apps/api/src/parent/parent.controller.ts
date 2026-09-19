import { Controller, Get, Post, Body, Req, Res, UseGuards, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { SessionUser } from '@acms/contracts';
import { SessionGuard } from '../auth/session.guard.js';
import { ParentService } from './parent.service.js';

/** `SessionGuard` 挂在 req 上的会话 id（非标准字段，与 auth.controller 同一写法） */
type AuthedRequest = Request & { user: SessionUser; sessionId: string };

/**
 * 家长 H5 端接口（P3 + 2026-09-19 issue #2）。
 *
 *  - POST /parent/auth/bind        学号 + 姓名（+ 可选手机号）绑定，签发 cookie 会话
 *  - GET  /parent/children         名下子女列表（多子女切换器用）
 *  - POST /parent/children/switch  切换当前子女
 *  - GET  /parent/grades           成绩（家长可见 + 完成闸门过滤）
 *  - GET  /parent/homework         作业布置（已发布 + 家长可见）
 *  - GET  /parent/comms            家校沟通记录
 *  - GET  /parent/attendances      考勤记录
 *  - POST /parent/feedback         提交家长反馈（写家校沟通记录）
 *
 * 🔴 除 bind 外**一律先 `requireParent`**：
 *    这些接口只判断了「会话里有没有 studentId」，而**学生会话也带 studentId**
 *    （学生自助登录签的会话），于是学生能直接调家长接口。
 *    对只读查询影响不大（都是自己的数据），但 `/parent/feedback` 会以家长的身份往
 *    「家校沟通」写入带「家长反馈」标签的记录 —— 学生自己造家长反馈，业务上是错的。
 */
@Controller('parent')
export class ParentController {
  constructor(private readonly svc: ParentService) {}

  /** 家长专用接口的统一前置：必须是以 parent 角色登录的会话 */
  private requireParent(req: Request): AuthedRequest {
    const r = req as AuthedRequest;
    if (!r.user?.roles?.includes('parent')) throw new ForbiddenException('FORBIDDEN:仅家长账号可访问');
    if (!r.user.studentId) throw new UnauthorizedException('UNAUTHENTICATED');
    return r;
  }

  @Post('auth/bind')
  async bind(
    @Body() body: { studentNo?: string; name?: string; phone?: string },
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const user = await this.svc.bind(body.studentNo ?? '', body.name ?? '', body.phone);
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
      studentIds: user.studentIds ?? (user.studentId ? [user.studentId] : []),
      name: user.name,
      campus: user.campuses[0] ?? '',
    });
  }

  /** 名下子女（多子女切换器；只有一个孩子时 `multi=false`，前端不显示切换条） */
  @Get('children')
  @UseGuards(SessionGuard)
  children(@Req() req: Request) {
    return this.svc.children(this.requireParent(req).user);
  }

  /** 切换当前子女（只允许切到自己绑定的孩子） */
  @Post('children/switch')
  @UseGuards(SessionGuard)
  switchChild(@Req() req: Request, @Body() body: { studentId?: string }) {
    const r = this.requireParent(req);
    return this.svc.switchChild(r.sessionId, r.user, body.studentId ?? '');
  }

  @Get('grades')
  @UseGuards(SessionGuard)
  grades(@Req() req: Request) {
    return this.svc.grades(this.requireParent(req).user.studentId as string);
  }

  @Get('homework')
  @UseGuards(SessionGuard)
  homework(@Req() req: Request) {
    return this.svc.homework(this.requireParent(req).user.studentId as string);
  }

  @Get('comms')
  @UseGuards(SessionGuard)
  comms(@Req() req: Request) {
    return this.svc.comms(this.requireParent(req).user.studentId as string);
  }

  @Get('attendances')
  @UseGuards(SessionGuard)
  attendances(@Req() req: Request) {
    return this.svc.listAttendances(this.requireParent(req).user.studentId as string);
  }

  @Post('feedback')
  @UseGuards(SessionGuard)
  feedback(@Req() req: Request, @Body() body: { content?: string; contact?: string }) {
    const r = this.requireParent(req);
    return this.svc.submitFeedback(r.user, r.user.studentId as string, body.content ?? '', body.contact);
  }
}
