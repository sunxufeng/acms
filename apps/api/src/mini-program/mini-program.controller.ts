import { Controller, Get, Post, Body, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { SessionGuard } from '../auth/session.guard.js';
import { LoginRateLimitGuard } from '../auth/rate-limit.guard.js';
import { MiniProgramService } from './mini-program.service.js';
import type { WechatLoginDto, ZoneQueryDto } from './mini-program.dto.js';

/**
 * 微信小程序端接口。
 *  - POST /student/auth/wechat-login  微信登录 / 学号绑定（无会话守卫，登录入口本身）
 *  - POST /student/auth/bind          学生网页自助登录（学号 + 姓名，签发 cookie 会话，角色 student）
 *  - GET  /student/zones?campus=      学生可读围栏（需学生会话，复用 x-acms-sid 头）
 */
@Controller('student')
export class MiniProgramController {
  constructor(private readonly svc: MiniProgramService) {}

  @Post('auth/wechat-login')
  @UseGuards(LoginRateLimitGuard)
  wechatLogin(@Body() dto: WechatLoginDto) {
    return this.svc.login(dto);
  }

  @Post('auth/bind')
  @UseGuards(LoginRateLimitGuard)
  async bind(
    @Body() body: { studentNo?: string; name?: string },
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const user = await this.svc.bindByCredentials(body.studentNo ?? '', body.name ?? '');
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

  @Get('zones')
  @UseGuards(SessionGuard)
  zones(@Req() req: Request & { user: { studentId?: string } }, @Query() query: ZoneQueryDto) {
    return this.svc.listZones(query);
  }
}
