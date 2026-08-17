import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/**
 * M7 安全加固中间件（全局生效，可直接传给 express 的 app.use）：
 *  1) 安全响应头：CSP / X-Frame-Options / X-Content-Type-Options / Referrer-Policy / Permissions-Policy
 *  2) 写接口跨域来源校验（Origin 白名单）：POST/PUT/PATCH/DELETE 必须来自受信前端域，
 *     否则 403。防止 CSRF 式跨站写操作（读 GET 不强制，便于健康拨测/内网调试）。
 *
 * 白名单取自 WEB_ORIGIN（逗号分隔），并自动放行同源（Origin 与 Host 同域）与无 Origin 的非浏览器调用。
 */
export function securityMiddleware(req: Request, res: Response, next: NextFunction): void {
  const logger = new Logger('SecurityMiddleware');

  const csp =
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'; " +
    "frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

  // 1) 安全响应头
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  );
  res.setHeader('Content-Security-Policy', csp);

  // 2) 写接口来源校验
  const method = req.method.toUpperCase();
  const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
  if (MUTATING.has(method)) {
    const origin = req.headers.origin;
    const host = req.headers.host ?? '';
    const allowed = (process.env.WEB_ORIGIN ?? 'http://localhost:3100')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const hostOf = (o: string | undefined): string | null => {
      if (!o) return null;
      try {
        return new URL(o).host;
      } catch {
        return null;
      }
    };
    const allowedHosts = new Set(allowed.map(hostOf).filter(Boolean) as string[]);
    const originHost = hostOf(origin);
    // 同源（前端与 API 同域，如经 nginx 反代）或白名单内 → 放行；否则 403
    const ok =
      originHost === null // 无 Origin：非浏览器/服务端调用，放行
      || originHost === host // 同源（Host 匹配）
      || allowedHosts.has(originHost); // 白名单域
    if (!ok) {
      logger.warn(`写接口被拒：Origin=${origin} Host=${host} ${req.method} ${req.originalUrl}`);
      res.status(403).json({ statusCode: 403, message: 'FORBIDDEN_ORIGIN' });
      return;
    }
  }
  next();
}
