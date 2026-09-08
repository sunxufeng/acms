import { Module } from '@nestjs/common';
import { baseClientProvider } from '../base.provider.js';
import { FileUploadService } from './file-upload.service.js';
import { FileController } from './file.controller.js';

@Module({
  // FileController 需要 BASE_CLIENT 来解析 bitablePerm 鉴权上下文
  providers: [FileUploadService, baseClientProvider],
  controllers: [FileController],
  exports: [FileUploadService],
})
export class FileUploadModule {}
