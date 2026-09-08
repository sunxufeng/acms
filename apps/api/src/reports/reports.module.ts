import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';
import { baseClientProvider } from '../base.provider.js';

@Module({
  controllers: [ReportsController],
  providers: [ReportsService, baseClientProvider],
})
export class ReportsModule {}
