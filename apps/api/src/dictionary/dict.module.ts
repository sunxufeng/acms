import { Module } from '@nestjs/common';
import { DictController } from './dict.controller.js';
import { DictService } from './dict.service.js';
import { baseClientProvider } from '../base.provider.js';

@Module({
  controllers: [DictController],
  providers: [DictService, baseClientProvider],
  exports: [DictService],
})
export class DictModule {}
