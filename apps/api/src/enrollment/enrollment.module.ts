import { Module } from '@nestjs/common';
import { EnrollmentController } from './enrollment.controller.js';
import { EnrollmentService } from './enrollment.service.js';
import { baseClientProvider } from '../base.provider.js';

@Module({
  controllers: [EnrollmentController],
  providers: [EnrollmentService, baseClientProvider],
})
export class EnrollmentModule {}
