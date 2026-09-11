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
  exports: [REDIS, BASE_CLIENT, SessionService, SessionGuard, RateLimitService, LoginLogService],
})
export class AuthModule {}
