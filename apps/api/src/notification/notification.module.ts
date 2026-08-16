import { Module } from '@nestjs/common';
import { NotificationController } from './notification.controller.js';
import { NotificationService } from './notification.service.js';
import { baseClientProvider } from '../base.provider.js';

@Module({
  controllers: [NotificationController],
  providers: [NotificationService, baseClientProvider],
})
export class NotificationModule {}
