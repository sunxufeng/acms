import { Module } from '@nestjs/common';
import { TeacherController } from './teacher.controller.js';
import { TeacherService } from './teacher.service.js';
import { baseClientProvider } from '../base.provider.js';
import { DictModule } from '../dictionary/dict.module.js';

@Module({
  controllers: [TeacherController],
  imports: [DictModule],
  providers: [TeacherService, baseClientProvider],
})
export class TeacherModule {}
