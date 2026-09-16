import { Global, Module } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { SessionService } from './session.service.js';
import { AuthController } from './auth.controller.js';
import { SessionGuard } from './session.guard.js';
import { LoginRateLimitGuard, RateLimitService } from './rate-limit.guard.js';
import { redisProvider, REDIS } from '../redis.provider.js';
import { baseClientProvider, BASE_CLIENT } from '../base.provider.js';
import { LoginLogModule } from '../login-log/login-log.module.js';
import { LoginLogService } from '../login-log/login-log.service.js';
import { HighRiskGateService } from './high-risk-gate.js';
import { ApiTokenService } from './api-token.service.js';
import { ApiTokenController } from './api-token.controller.js';

@Global()
@Module({
  imports: [LoginLogModule],
  controllers: [AuthController, ApiTokenController],
  providers: [
    redisProvider,
    baseClientProvider,
    AuthService,
    SessionService,
    SessionGuard,
    RateLimitService,
    LoginRateLimitGuard,
    LoginLogService,
    // 高风险操作的二次密码闸：身份模拟与 API 令牌管理共用（scope 隔离）
    HighRiskGateService,
    // API 令牌：守卫用它校验 Bearer，令牌管理接口用它签发/吊销
    ApiTokenService,
  ],
  // AuthService 也导出：身份模拟（impersonate）要复用它的 resolvePrincipal()
  // ——「用户表 → 会话身份（角色/校区/密级）」的唯一口径，必须共用而不是各写一份。
  // ApiTokenService 同理要给 SessionGuard 用（守卫住在本模块，直接注入即可）。
  exports: [
    REDIS,
    BASE_CLIENT,
    AuthService,
    SessionService,
    SessionGuard,
    RateLimitService,
    LoginLogService,
    HighRiskGateService,
    ApiTokenService,
  ],
})
export class AuthModule {}
