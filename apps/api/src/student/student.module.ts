import { Module } from '@nestjs/common';
import { StudentController } from './student.controller.js';
import { StudentService } from './student.service.js';
import { baseClientProvider } from '../base.provider.js';
import { FileUploadModule } from '../file-upload/file-upload.module.js';
import { DictModule } from '../dictionary/dict.module.js';

@Module({
  imports: [FileUploadModule, DictModule],
  controllers: [StudentController],
  providers: [StudentService, baseClientProvider],
  exports: [StudentService],
})
export class StudentModule {}
