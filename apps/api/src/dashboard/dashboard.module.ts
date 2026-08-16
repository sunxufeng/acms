import { Module } from '@nestjs/common';
import { DashboardController, SearchController } from './dashboard.controller.js';
import { DashboardService } from './dashboard.service.js';
import { baseClientProvider } from '../base.provider.js';

@Module({
  controllers: [DashboardController, SearchController],
  providers: [DashboardService, baseClientProvider],
})
export class DashboardModule {}
