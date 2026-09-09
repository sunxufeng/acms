import { Module } from '@nestjs/common';
import { baseClientProvider } from '../base.provider.js';
import { FileUploadService } from './file-upload.service.js';
import { FileController } from './file.controller.js';
import { FileStorageService } from '../file-storage/file-storage.service.js';

@Module({
  // FileController 需要 BASE_CLIENT 来解析 bitablePerm 鉴权上下文（仅历史 Drive 文件使用）
  providers: [FileUploadService, FileStorageService, baseClientProvider],
  controllers: [FileController],
  exports: [FileUploadService, FileStorageService],
})
export class FileUploadModule {}
