import { Module } from '@nestjs/common';
import { StudentController } from './student.controller.js';
import { StudentService } from './student.service.js';
import { baseClientProvider } from '../base.provider.js';

@Module({
  controllers: [StudentController],
  providers: [StudentService, baseClientProvider],
})
export class StudentModule {}
