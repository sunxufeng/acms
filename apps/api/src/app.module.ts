import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module.js';
import { HealthModule } from './health/health.module.js';

@Module({
  imports: [HealthModule, AuthModule],
})
export class AppModule {}
