import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module.js';
import { HealthModule } from './health/health.module.js';
import { StudentModule } from './student/student.module.js';

@Module({
  imports: [HealthModule, AuthModule, StudentModule],
})
export class AppModule {}
