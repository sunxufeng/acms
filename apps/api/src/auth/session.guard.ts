import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { SessionUser } from '@acms/contracts';
import { SessionService } from './session.service.js';
import { ApiTokenService } from './api-token.service.js';
import { actorFromUser, setActor } from '../shared/actor-context.js';
import { checkAccessLimits, normalizePath } from './access-limit.js';

/**
 * 凭证守卫：解析请求 → 得到**标准的 SessionUser** → 写 `req.user` 与操作人上下文。
 *
 * 两种凭证走同一条出口（这是整个接入方案的关键设计）：
 *
 * | 凭证 | 来源 | 身份怎么来 |
 * |---|---|---|
 * | Cookie `acms_sid` / 头 `x-acms-sid` | Redis 会话 | 登录时写进会话 |
 * | `Authorization: Bearer acms-sk-…`    | API 令牌   | `resolvePrincipal(绑定 openId)` |
 *
 * 为什么令牌**不另起一个守卫**：`req.user` 是标准 SessionUser 之后，
 * 学生档案行级数据范围、`requireModule()` 模块权限、审计操作人、`currentActor()`
 * **全部零改动自动生效**。另起守卫等于给系统开一条绕过这些约束的路 ——
 * 那条路日后没人敢动，也没人说得清哪些规则对它不适用。
 *
 * 对照：AI 网关（`ai-gateway.controller`）是**故意**绕过本守卫的 ——
 * 它要吐 OpenAI 原生格式、不能包 ACMS 信封。令牌恰好相反，它要的就是 ACMS 的全部规矩。
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly sessions: SessionService,
    private readonly tokens: ApiTokenService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest() as Request & { user?: unknown };
    const res = ctx.switchToHttp().getResponse() as Response;
    const started = Date.now();
    const rawUrl = req.originalUrl ?? req.url ?? '';

    const user = await this.authenticate(req);

    req.user = user;
    // 写入操作人上下文：后续所有写入的「创建人 / 更新人」都取这里的值
    setActor(actorFromUser(user));
    (req as Request & { sessionId?: string }).sessionId = user.sessionId;

    /**
     * 请求级访问限制（只读 / 模块白名单）在这里统一判定 ——
     * 业务接口零改动，也不会因为漏改某个路由而留下口子。
     *
     * 两类凭证共用同一条链路，`kind` 决定**放行规则**（故意不同）：
     *  - 模拟态必须放行 `/impersonate/*`（退出模拟是 POST，拦了人就困在里面出不来）
     *  - 令牌必须硬拒 `/impersonate/*`（令牌能模拟他人 = 权限放大链）
     * 详见 access-limit.ts 的 TOKEN_DENY 注释。
     *
     * `limits ?? impersonation`：`limits` 是令牌用的新字段名；`impersonation` 是身份模拟
     * 已落在 Redis 里的旧名（结构相同），保留是为了让线上在跑的模拟会话不掉线。
     */
    const kind = user.authVia === 'token' ? 'token' : 'impersonate';
    const verdict = checkAccessLimits(user.limits ?? user.impersonation, req.method, rawUrl, kind);
    if (!verdict.ok) throw new ForbiddenException(`${verdict.code}: ${verdict.message}`);

    // 令牌调用的留痕：默认只记写操作（读操作在 logCall 里直接短路返回）。
    // 挂在响应 finish 上是为了拿到真实状态码与耗时 —— 守卫执行时还不知道结果。
    if (user.authVia === 'token' && user.tokenId) {
      const tokenId = user.tokenId;
      res.on('finish', () => {
        void this.tokens.logCall({
          tokenId,
          method: req.method,
          path: normalizePath(rawUrl),
          status: res.statusCode,
          ms: Date.now() - started,
          ip: this.ipOf(req),
        });
      });
    }

    return true;
  }

  /** 解析凭证 → SessionUser。两种凭证都不认才抛 401。 */
  private async authenticate(req: Request): Promise<SessionUser> {
    const bearer = this.readBearer(req);
    if (this.tokens.looksLikeToken(bearer)) {
      // 令牌校验失败会抛 401/403，语义已在 ApiTokenService.verify 里分好
      return this.tokens.verify(bearer as string, this.ipOf(req));
    }

    const sid = this.readSid(req);
    if (!sid) throw new UnauthorizedException('UNAUTHENTICATED');
    const user = await this.sessions.get(sid);
    if (!user) throw new UnauthorizedException('UNAUTHENTICATED');
    await this.sessions.refresh(sid);
    // 会话认证：显式标注来源（Redis 里存的会话体没有这个字段，只存在于内存）
    return { ...user, authVia: 'session' };
  }

  /**
   * `Authorization: Bearer xxx`。
   * 只有前缀是我们的（`acms-sk-`）才走令牌分支，见 `looksLikeToken` ——
   * 避免误吞将来可能引入的其它 Bearer 凭证。
   */
  private readBearer(req: Request): string | null {
    const h = req.headers.authorization;
    if (typeof h !== 'string') return null;
    const m = /^Bearer\s+(.+)$/i.exec(h.trim());
    return m?.[1]?.trim() || null;
  }

  /**
   * 真实客户端 IP。
   * nginx 反代之后 `req.ip` 是 127.0.0.1，必须优先取 `X-Forwarded-For` 的第一段，
   * 否则 IP 白名单会把所有来源看成同一个（白名单反而变成「谁都能过」）。
   */
  private ipOf(req: Request): string {
    const xff = req.headers['x-forwarded-for'];
    const first = Array.isArray(xff) ? xff[0] : xff;
    const fromHeader = String(first ?? '')
      .split(',')[0]
      ?.trim();
    return fromHeader || req.ip || req.socket?.remoteAddress || '';
  }

  private readSid(req: Request): string | null {
    const cookie = req.headers.cookie ?? '';
    const name = process.env.SESSION_COOKIE ?? 'acms_sid';
    for (const part of cookie.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === name) return decodeURIComponent(v.join('='));
    }
    // 小程序端（微信/家长 H5）无法携带 httpOnly cookie，改用自定义请求头传递会话 id
    const headerSid = req.headers['x-acms-sid'];
    if (typeof headerSid === 'string' && headerSid) return headerSid;
    if (Array.isArray(headerSid) && headerSid[0]) return headerSid[0];
    return null;
  }
}
