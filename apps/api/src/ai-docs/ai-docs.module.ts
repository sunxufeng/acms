import { Module } from '@nestjs/common';
import { AiDocsController } from './ai-docs.controller.js';
import { AiDocsService } from './ai-docs.service.js';

@Module({
  controllers: [AiDocsController],
  providers: [AiDocsService],
  exports: [AiDocsService],
})
export class AiDocsModule {}
