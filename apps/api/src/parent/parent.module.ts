import { Module } from '@nestjs/common';
import { ParentController } from './parent.controller.js';
import { ParentService } from './parent.service.js';

@Module({
  controllers: [ParentController],
  providers: [ParentService],
})
export class ParentModule {}
