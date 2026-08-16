import { Module } from '@nestjs/common';
import { CoursePlanController, TeachingClassController } from './teaching.controller.js';
import { CoursePlanService } from './course-plan.service.js';
import { TeachingClassService } from './teaching-class.service.js';
import { baseClientProvider } from '../base.provider.js';

@Module({
  controllers: [CoursePlanController, TeachingClassController],
  providers: [CoursePlanService, TeachingClassService, baseClientProvider],
})
export class TeachingModule {}
