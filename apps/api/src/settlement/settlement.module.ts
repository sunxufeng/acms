import { Module } from '@nestjs/common';
import { SettlementController } from './settlement.controller.js';
import { SettlementService } from './settlement.service.js';
import { baseClientProvider } from '../base.provider.js';

@Module({
  controllers: [SettlementController],
  providers: [SettlementService, baseClientProvider],
})
export class SettlementModule {}
