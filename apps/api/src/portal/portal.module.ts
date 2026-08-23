import { Module } from '@nestjs/common';
import { PortalController } from './portal.controller.js';
import { PortalService } from './portal.service.js';
import { baseClientProvider } from '../base.provider.js';

@Module({
  controllers: [PortalController],
  providers: [PortalService, baseClientProvider],
})
export class PortalModule {}
