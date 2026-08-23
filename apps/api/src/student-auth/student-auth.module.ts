import { Module } from '@nestjs/common';
import { StudentAuthController } from './student-auth.controller.js';
import { StudentAuthService } from './student-auth.service.js';

/** 学生密码登录账号模块（B1）。SessionService / BASE_CLIENT 由全局 AuthModule 提供。 */
@Module({
  controllers: [StudentAuthController],
  providers: [StudentAuthService],
})
export class StudentAuthModule {}
