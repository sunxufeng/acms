import { Controller, Get, Post, Body, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { SessionGuard } from '../auth/session.guard.js';
import { LoginRateLimitGuard } from '../auth/rate-limit.guard.js';
import { MiniProgramService } from './mini-program.service.js';
import type { WechatLoginDto, ZoneQueryDto } from './mini-program.dto.js';

/**
 * 微信小程序端接口。
 *  - POST /student/auth/wechat-login  微信登录 / 学号绑定（无会话守卫，登录入口本身）
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

  @Get('zones')
  @UseGuards(SessionGuard)
  zones(@Req() req: Request & { user: { studentId?: string } }, @Query() query: ZoneQueryDto) {
    return this.svc.listZones(query);
  }
}
