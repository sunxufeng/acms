import { Module } from '@nestjs/common';
import { StudentModule } from '../student/student.module.js';
import { baseClientProvider } from '../base.provider.js';
import { Student360Service } from './student-360.service.js';
import { Student360Controller } from './student-360.controller.js';

@Module({
  imports: [StudentModule],
  controllers: [Student360Controller],
  providers: [Student360Service, baseClientProvider],
})
export class Student360Module {}
