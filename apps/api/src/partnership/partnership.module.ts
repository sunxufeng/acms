import { Module } from '@nestjs/common';
import { PartnershipController } from './partnership.controller.js';
import { PartnershipService } from './partnership.service.js';
import { baseClientProvider } from '../base.provider.js';

@Module({
  controllers: [PartnershipController],
  providers: [PartnershipService, baseClientProvider],
})
export class PartnershipModule {}
