import { Module } from '@nestjs/common';
import { SystemMonitorController } from './system-monitor.controller.js';
import { SystemMonitorService } from './system-monitor.service.js';

@Module({
  controllers: [SystemMonitorController],
  providers: [SystemMonitorService],
  exports: [SystemMonitorService],
})
export class SystemMonitorModule {}
