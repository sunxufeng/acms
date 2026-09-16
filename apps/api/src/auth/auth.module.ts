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

@Global()
@Module({
  imports: [LoginLogModule],
  controllers: [AuthController],
  providers: [redisProvider, baseClientProvider, AuthService, SessionService, SessionGuard, RateLimitService, LoginRateLimitGuard, LoginLogService],
  // AuthService 也导出：身份模拟（impersonate）要复用它的 resolvePrincipal()
  // ——「用户表 → 会话身份（角色/校区/密级）」的唯一口径，必须共用而不是各写一份。
  exports: [REDIS, BASE_CLIENT, AuthService, SessionService, SessionGuard, RateLimitService, LoginLogService],
})
export class AuthModule {}
