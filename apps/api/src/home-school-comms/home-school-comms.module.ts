import { Module } from '@nestjs/common';
import { FileUploadModule } from '../file-upload/file-upload.module.js';
import { baseClientProvider } from '../base.provider.js';
import { HomeSchoolCommsController } from './home-school-comms.controller.js';
import { HomeSchoolCommsService } from './home-school-comms.service.js';

@Module({
  imports: [FileUploadModule],
  controllers: [HomeSchoolCommsController],
  providers: [HomeSchoolCommsService, baseClientProvider],
})
export class HomeSchoolCommsModule {}
