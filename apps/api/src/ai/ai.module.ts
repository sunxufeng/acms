import { Module } from '@nestjs/common';
import { AiController } from './ai.controller.js';
import { AiService } from './ai.service.js';
import { StudentModule } from '../student/student.module.js';
import { AiDocsModule } from '../ai-docs/ai-docs.module.js';
import { baseClientProvider } from '../base.provider.js';

@Module({
  imports: [StudentModule, AiDocsModule],
  controllers: [AiController],
  providers: [AiService, baseClientProvider],
  exports: [AiService],
})
export class AiModule {}
