import { Module } from '@nestjs/common';
import { FileUploadModule } from '../file-upload/file-upload.module.js';
import { baseClientProvider } from '../base.provider.js';
import { AiSummarizeService } from './ai-summarize.service.js';
import { HomeSchoolCommsAiController, DailyFollowupAiController } from './ai-summarize.controller.js';

@Module({
  imports: [FileUploadModule],
  controllers: [HomeSchoolCommsAiController, DailyFollowupAiController],
  providers: [AiSummarizeService, baseClientProvider],
})
export class AiSummarizeModule {}
