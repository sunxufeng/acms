import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module.js';
import { HealthModule } from './health/health.module.js';
import { StudentModule } from './student/student.module.js';
import { DictModule } from './dictionary/dict.module.js';
import { TeacherModule } from './teacher/teacher.module.js';
import { TeachingModule } from './teaching/teaching.module.js';
import { VenueModule } from './venue/venue.module.js';
import { ScheduleModule } from './schedule/schedule.module.js';
import { EnrollmentModule } from './enrollment/enrollment.module.js';
import { PortalModule } from './portal/portal.module.js';

@Module({
  imports: [
    HealthModule,
    AuthModule,
    StudentModule,
    DictModule,
    TeacherModule,
    TeachingModule,
    VenueModule,
    ScheduleModule,
    EnrollmentModule,
    PortalModule,
  ],
})
export class AppModule {}
