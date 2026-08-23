import { Module } from '@nestjs/common';
import { TeacherController } from './teacher.controller.js';
import { TeacherService } from './teacher.service.js';
import { baseClientProvider } from '../base.provider.js';

@Module({
  controllers: [TeacherController],
  providers: [TeacherService, baseClientProvider],
})
export class TeacherModule {}
