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

  /** 根据请求 Host 推导回调地址，使 OAuth 对域名/IP、HTTP/HTTPS 均自适应 */
  private buildRedirectUri(req: Request): string {
    const protoRaw = (req.headers['x-forwarded-proto'] as string | undefined) ?? '';
    const proto = (protoRaw.split(',')[0] ?? 'http').trim() || 'http';
    const host = req.get('host') || 'localhost:3000';
    return `${proto}://${host}/api/v1/auth/callback`;
  }

  /** 发起飞书 OAuth 登录（PKCE S256，双限流） */
  @Get('login')
  @UseGuards(LoginRateLimitGuard)
  async login(@Req() req: Request, @Res() res: Response): Promise<void> {
    const redirectUri = this.buildRedirectUri(req);
    const url = await this.auth.buildAuthorizeUrl(redirectUri);
    res.redirect(url);
  }

  /** OAuth 回调：换 token、建会话、种 cookie、回前端（双限流） */
  @Get('callback')
  @UseGuards(LoginRateLimitGuard)
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const redirectUri = this.buildRedirectUri(req);
    const user = await this.auth.handleCallback(code, state, redirectUri);
    const secure = redirectUri.startsWith('https');
    res.cookie(process.env.SESSION_COOKIE ?? 'acms_sid', user.sessionId, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      maxAge: Number(process.env.SESSION_TTL_SECONDS ?? 3600) * 1000,
      path: '/',
    });
    const proto = secure ? 'https' : 'http';
    const host = req.get('host') || 'localhost:3100';
    res.redirect(`${proto}://${host}/`);
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
