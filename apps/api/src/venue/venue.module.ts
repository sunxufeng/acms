import { Module } from '@nestjs/common';
import { VenueController } from './venue.controller.js';
import { VenueService } from './venue.service.js';
import { baseClientProvider } from '../base.provider.js';

@Module({
  controllers: [VenueController],
  providers: [VenueService, baseClientProvider],
})
export class VenueModule {}
