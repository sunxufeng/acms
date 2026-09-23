import { Module } from '@nestjs/common';
import { MyFollowupsController } from './my-followups.controller.js';
import { MyFollowupsService } from './my-followups.service.js';
import { baseClientProvider } from '../base.provider.js';

@Module({
  controllers: [MyFollowupsController],
  providers: [MyFollowupsService, baseClientProvider],
})
export class MyFollowupsModule {}
