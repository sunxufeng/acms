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
import { AttendanceModule } from './attendance/attendance.module.js';
import { MiniProgramModule } from './mini-program/mini-program.module.js';
import { ParentModule } from './parent/parent.module.js';
import { PartnershipModule } from './partnership/partnership.module.js';
import { BillingModule } from './billing/billing.module.js';
import { SettlementModule } from './settlement/settlement.module.js';
import { AdjustmentModule } from './adjustment/adjustment.module.js';
import { NotificationModule } from './notification/notification.module.js';
import { DashboardModule } from './dashboard/dashboard.module.js';
import { ExportModule } from './export/export.module.js';
import { GenericCrudModule } from './shared/generic-crud.module.js';
import { AuditModule } from './audit/audit.module.js';
import { Student360Module } from './student-360/student-360.module.js';
import { MonitorModule } from './monitor/monitor.module.js';
import { UsersModule } from './user/user.module.js';
import { AiModule } from './ai/ai.module.js';
import { AiSummarizeModule } from './ai-summarize/ai-summarize.module.js';
import { LIFECYCLE_METAS, CONFIG_METAS, AUDIT_METAS } from './shared/lifecycle.meta.js';

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
    AttendanceModule,
    MiniProgramModule,
    ParentModule,
    PartnershipModule,
    BillingModule,
    SettlementModule,
    AdjustmentModule,
    NotificationModule,
    DashboardModule,
    ExportModule,
    AuditModule,
    MonitorModule,
    GenericCrudModule.registerAll(LIFECYCLE_METAS),
    GenericCrudModule.registerAll(CONFIG_METAS),
    GenericCrudModule.registerAll(AUDIT_METAS),
    Student360Module,
    UsersModule,
    AiModule,
    AiSummarizeModule,
  ],
})
export class AppModule {}
