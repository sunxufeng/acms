import {
  Body,
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
import { SessionGuard } from '../auth/session.guard.js';
import { ImpersonateService, IMPERSONATE_TTL_SECONDS } from './impersonate.service.js';

/**
 * 身份模拟接口（2026-09-16）。全部只对**系统管理员**开放。
 *
 * ⚠️ 路由顺序：本控制器没有 `:id` 之类的前缀通配，所以不存在"静态路由被参数路由吃掉"的问题；
 *    但以后若加了 `@Post(':xxx')`，必须把 `unlock` / `users` / `enter` / `exit`
 *    这些静态段写在它**之前**（ACMS 已有多次踩坑，见 markbook / exam-grade 的注释）。
 *
 * 认证全程走 SessionGuard（解析 Cookie `acms_sid` 或 `x-acms-sid` 头 → Redis 会话）。
 */
@Controller('impersonate')
@UseGuards(SessionGuard)
export class ImpersonateController {
  constructor(private readonly svc: ImpersonateService) {}

  /** 请求来源 IP（Nginx 反代后取 x-forwarded-for 首段），用于失败限流与留痕 */
  private ipOf(req: Request): string {
    return (
      (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ||
      req.socket?.remoteAddress ||
      'unknown'
    );
  }

  private secureCookie(req: Request): boolean {
    return ((req.headers['x-forwarded-proto'] as string | undefined) ?? 'http').includes('https');
  }

  /** ① 解锁：校验二次密码。密码错/被锁定也返回 200，由 body 里的 code 区分 */
  @Post('unlock')
  @HttpCode(200)
  unlock(
    @Req() req: Request & { user: SessionUser },
    @Body() body: { password?: string },
  ) {
    return this.svc.unlock(req.user, String(body?.password ?? ''), this.ipOf(req));
  }

  /** 主动锁定（页面上「立即锁定」）：清掉解锁凭证，回到密码屏 */
  @Post('lock')
  @HttpCode(200)
  lock(@Req() req: Request & { user: SessionUser }) {
    return this.svc.lock(req.user);
  }

  /**
   * ⑤ 模拟记录（只读审计，**不需要二次密码**）。
   * 与「进入」分开授权：查历史是低风险的只读操作，越方便查越好。
   */
  @Get('logs')
  logs(
    @Req() req: Request & { user: SessionUser },
    @Query('action') action?: string,
    @Query('actor') actor?: string,
    @Query('target') target?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.listLogs(req.user, { action, actor, target, from, to, limit: Number(limit) || undefined });
  }

  /** ⑥ 模块清单（模块白名单的候选项；不需要解锁） */
  @Get('modules')
  modules(@Req() req: Request & { user: SessionUser }) {
    return this.svc.listModuleOptions(req.user);
  }

  /** ② 账号清单（需解锁凭证；不含邮箱/手机/密级等敏感字段） */
  @Get('users')
  users(@Req() req: Request & { user: SessionUser }) {
    return this.svc.listUsers(req.user);
  }

  /**
   * ③ 进入模拟：建模拟会话并把 Cookie 换成它。
   * 管理员原会话**不销毁**，退出时能原样换回来。
   */
  @Post('enter')
  @HttpCode(200)
  async enter(
    @Req() req: Request & { user: SessionUser; sessionId: string },
    @Res({ passthrough: true }) res: Response,
    @Body() body: { openId?: string; readOnly?: boolean; modules?: string[] },
  ) {
    const { sessionId, result } = await this.svc.enter(
      req.user,
      req.sessionId,
      String(body?.openId ?? ''),
      this.ipOf(req),
      { readOnly: !!body?.readOnly, modules: body?.modules },
    );
    res.cookie(process.env.SESSION_COOKIE ?? 'acms_sid', sessionId, {
      httpOnly: true,
      secure: this.secureCookie(req),
      sameSite: 'lax',
      maxAge: IMPERSONATE_TTL_SECONDS * 1000,
      path: '/',
    });
    return { ok: true, ...result };
  }

  /** ④ 退出模拟：销毁模拟会话，Cookie 换回管理员原会话 */
  @Post('exit')
  @HttpCode(200)
  async exit(
    @Req() req: Request & { user: SessionUser; sessionId: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    const { adminSessionId } = await this.svc.exit(req.user, req.sessionId, this.ipOf(req));
    const name = process.env.SESSION_COOKIE ?? 'acms_sid';
    if (adminSessionId) {
      res.cookie(name, adminSessionId, {
        httpOnly: true,
        secure: this.secureCookie(req),
        sameSite: 'lax',
        maxAge: Number(process.env.SESSION_TTL_SECONDS ?? 3600) * 1000,
        path: '/',
      });
    } else {
      // 管理员原会话已过期：清 Cookie 让前端回登录页，不留下悬空会话
      res.clearCookie(name, { path: '/' });
    }
    return { ok: true, restored: !!adminSessionId };
  }
}
