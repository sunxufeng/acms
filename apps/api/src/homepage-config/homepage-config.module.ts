import { Module } from '@nestjs/common';
import { baseClientProvider } from '../base.provider.js';
import { FileUploadModule } from '../file-upload/file-upload.module.js';
import { HomepageConfigController } from './homepage-config.controller.js';
import { HomepageConfigService } from './homepage-config.service.js';

@Module({
  imports: [FileUploadModule],
  controllers: [HomepageConfigController],
  providers: [HomepageConfigService, baseClientProvider],
})
export class HomepageConfigModule {}
