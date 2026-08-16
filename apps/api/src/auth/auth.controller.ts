import {
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { SessionUser } from '@acms/contracts';
import { AuthService } from './auth.service.js';
import { SessionGuard } from './session.guard.js';
import { LoginRateLimitGuard } from './rate-limit.guard.js';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** 发起飞书 OAuth 登录（PKCE S256，双限流） */
  @Get('login')
  @UseGuards(LoginRateLimitGuard)
  async login(@Res() res: Response): Promise<void> {
    const url = await this.auth.buildAuthorizeUrl();
    res.redirect(url);
  }

  /** OAuth 回调：换 token、建会话、种 cookie、回前端（双限流） */
  @Get('callback')
  @UseGuards(LoginRateLimitGuard)
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: Response,
  ): Promise<void> {
    const user = await this.auth.handleCallback(code, state);
    const secure = process.env.NODE_ENV === 'production';
    res.cookie(process.env.SESSION_COOKIE ?? 'acms_sid', user.sessionId, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      maxAge: Number(process.env.SESSION_TTL_SECONDS ?? 3600) * 1000,
      path: '/',
    });
    res.redirect(`${process.env.WEB_ORIGIN ?? 'http://localhost:3100'}/`);
  }

  /** 当前会话用户（未登录 401） */
  @Get('me')
  @UseGuards(SessionGuard)
  me(@Req() req: Request & { user: SessionUser }): SessionUser {
    return req.user;
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async logout(@Req() req: Request & { sessionId: string }, @Res() res: Response): Promise<void> {
    await this.auth.logout(req.sessionId);
    res.clearCookie(process.env.SESSION_COOKIE ?? 'acms_sid', { path: '/' });
    res.status(204).send();
  }
}
