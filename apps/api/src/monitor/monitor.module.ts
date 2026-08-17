import { Module } from '@nestjs/common';
import { MonitorService } from './monitor.service.js';
import { MonitorController } from './monitor.controller.js';

@Module({
  providers: [MonitorService],
  controllers: [MonitorController],
  exports: [MonitorService],
})
export class MonitorModule {}
