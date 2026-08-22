import { Module } from '@nestjs/common';
import { AttendanceController } from './attendance.controller.js';
import { AttendanceService } from './attendance.service.js';
import { SignController } from './sign.controller.js';
import { SignService } from './sign.service.js';
import { baseClientProvider } from '../base.provider.js';

@Module({
  controllers: [AttendanceController, SignController],
  providers: [AttendanceService, SignService, baseClientProvider],
})
export class AttendanceModule {}
