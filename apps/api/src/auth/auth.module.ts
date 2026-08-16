import { Global, Module } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { SessionService } from './session.service.js';
import { AuthController } from './auth.controller.js';
import { SessionGuard } from './session.guard.js';
import { redisProvider } from '../redis.provider.js';

@Global()
@Module({
  controllers: [AuthController],
  providers: [redisProvider, AuthService, SessionService, SessionGuard],
  exports: [SessionService, SessionGuard],
})
export class AuthModule {}
