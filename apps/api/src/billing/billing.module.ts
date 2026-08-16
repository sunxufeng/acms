import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller.js';
import { BillingService } from './billing.service.js';
import { baseClientProvider } from '../base.provider.js';

@Module({
  controllers: [BillingController],
  providers: [BillingService, baseClientProvider],
})
export class BillingModule {}
