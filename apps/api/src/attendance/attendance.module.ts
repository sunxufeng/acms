import { Module } from '@nestjs/common';
import { AttendanceController } from './attendance.controller.js';
import { AttendanceService } from './attendance.service.js';
import { baseClientProvider } from '../base.provider.js';

@Module({
  controllers: [AttendanceController],
  providers: [AttendanceService, baseClientProvider],
})
export class AttendanceModule {}
