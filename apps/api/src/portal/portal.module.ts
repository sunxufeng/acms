import { Module } from '@nestjs/common';
import { PortalController } from './portal.controller.js';
import { PortalService } from './portal.service.js';
import { SignService } from '../attendance/sign.service.js';
import { baseClientProvider } from '../base.provider.js';

@Module({
  controllers: [PortalController],
  providers: [PortalService, SignService, baseClientProvider],
})
export class PortalModule {}
