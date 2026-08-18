import { Module } from '@nestjs/common';
import { FileUploadService } from './file-upload.service.js';
import { FileController } from './file.controller.js';

@Module({
  providers: [FileUploadService],
  controllers: [FileController],
  exports: [FileUploadService],
})
export class FileUploadModule {}
