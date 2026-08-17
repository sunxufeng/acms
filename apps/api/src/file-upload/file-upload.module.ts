import { Module } from '@nestjs/common';
import { FileUploadService } from './file-upload.service.js';

@Module({
  providers: [FileUploadService],
  exports: [FileUploadService],
})
export class FileUploadModule {}
