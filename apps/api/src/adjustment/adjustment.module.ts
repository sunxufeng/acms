import { Module } from '@nestjs/common';
import { AdjustmentController } from './adjustment.controller.js';
import { AdjustmentService } from './adjustment.service.js';
import { baseClientProvider } from '../base.provider.js';

@Module({
  controllers: [AdjustmentController],
  providers: [AdjustmentService, baseClientProvider],
})
export class AdjustmentModule {}
