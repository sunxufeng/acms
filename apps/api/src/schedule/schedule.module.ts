import { Module } from '@nestjs/common';
import { SessionController } from './session.controller.js';
import { SessionService } from './session.service.js';
import { ScheduleController } from './schedule.controller.js';
import { baseClientProvider } from '../base.provider.js';

@Module({
  controllers: [SessionController, ScheduleController],
  providers: [SessionService, baseClientProvider],
})
export class ScheduleModule {}
