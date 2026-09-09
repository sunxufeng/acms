import { Module } from '@nestjs/common';
import { FileUploadService } from './file-upload.service.js';
import { FileController } from './file.controller.js';
import { FileStorageService } from '../file-storage/file-storage.service.js';

@Module({
  providers: [FileUploadService, FileStorageService],
  controllers: [FileController],
  exports: [FileUploadService, FileStorageService],
})
export class FileUploadModule {}
