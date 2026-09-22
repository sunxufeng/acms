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
import { FieldMaskModule } from './shared/field-mask.module.js';
import { StudentScopeModule } from './shared/student-scope.module.js';
import { DepartmentModule } from './department/department.module.js';
import { MeetingRoomModule } from './meeting-room/meeting-room.module.js';
import { NoteArchiveModule } from './note-archive/note-archive.module.js';
import { MeetingMinutesModule } from './meeting-minutes/meeting-minutes.module.js';
import { SystemMonitorModule } from './system-monitor/system-monitor.module.js';
import { AuditModule } from './audit/audit.module.js';
import { Student360Module } from './student-360/student-360.module.js';
import { IdpModule } from './idp/idp.module.js';
import { MonitorModule } from './monitor/monitor.module.js';
import { UsersModule } from './user/user.module.js';
import { AiModule } from './ai/ai.module.js';
import { AiDocsModule } from './ai-docs/ai-docs.module.js';
import { AiSummarizeModule } from './ai-summarize/ai-summarize.module.js';
import { WechatBindingModule } from './wechat-binding/wechat-binding.module.js';
import { HomepageConfigModule } from './homepage-config/homepage-config.module.js';
import { StudentAuthModule } from './student-auth/student-auth.module.js';
import { RoleManagementModule } from './role-management/role-management.module.js';
import { MailArchiveModule } from './mail-archive/mail-archive.module.js';
import { AiRouteModule } from './ai-route/ai-route.module.js';
import { GetnoteModule } from './getnote/getnote.module.js';
import { NoteSnapshotModule } from './getnote/note-snapshot.module.js';
import { OpenPlatformModule } from './open-platform/open-platform.module.js';
import { WeilingModule } from './weiling/weiling.module.js';
import { GetnoteSourceModule } from './getnote/sources.module.js';
import { ReportsModule } from './reports/reports.module.js';
import {
  LIFECYCLE_METAS,
  CONFIG_METAS,
  AUDIT_METAS,
  AI_ROUTE_METAS,
  TEACHING_CONFIG_METAS,
} from './shared/lifecycle.meta.js';
// 教学域三块专用模块（2026-09-13 参照 GibbonEdu/core v31 移植）：
// 成绩册（加权汇总 + 二维录入）、课程规划（单元部署 + 作业）、行为记录（告警重算 + 信件）
import { MARKBOOK_METAS } from './markbook/markbook.meta.js';
import { MarkbookModule } from './markbook/markbook.module.js';
import { CURRICULUM_METAS } from './curriculum/curriculum.meta.js';
import { CurriculumModule } from './curriculum/curriculum.module.js';
import { BEHAVIOUR_METAS } from './behaviour/behaviour.meta.js';
import { BehaviourModule } from './behaviour/behaviour.module.js';
// 考试与成绩（2026-09-16 参照 RosarioSIS v13 Grades 移植）：期末总评结转 / 成绩单 / PDF 导出
import { EXAM_GRADE_METAS } from './exam-grade/exam-grade.meta.js';
import { ExamGradeModule } from './exam-grade/exam-grade.module.js';
import { SchemaModule } from './schema/schema.module.js';
// 身份模拟（2026-09-16）：系统管理员以任意账号身份浏览，用于排查权限/数据范围问题
import { ImpersonateModule } from './impersonate/impersonate.module.js';

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
    // AI 路由（分组/上游/模型路由/密钥/用量/操作日志）—— 自建 SQL 表
    GenericCrudModule.registerAll(AI_ROUTE_METAS),
    // 教学域配置（考勤码 / 成绩等级体系与等级 / 考核类型权重）—— 自建 SQL 表
    GenericCrudModule.registerAll(TEACHING_CONFIG_METAS),
    // 教学域三块主体表（成绩册列/条目/目标、课程规划 10 张、行为跟进/告警/信件）—— 自建 SQL 表
    GenericCrudModule.registerAll(MARKBOOK_METAS),
    GenericCrudModule.registerAll(CURRICULUM_METAS),
    GenericCrudModule.registerAll(BEHAVIOUR_METAS),
    // 考试与成绩（考核类型 / 成绩批次 / 期末总评 / 成绩单）—— 自建 SQL 表，
    // 建表在 ExamGradeModule（通用 CRUD 不建表）
    GenericCrudModule.registerAll(EXAM_GRADE_METAS),
    ExamGradeModule,
    // 身份模拟：建「身份模拟记录表」在模块内 onModuleInit（通用 CRUD 不建表）
    ImpersonateModule,
    // 能力发现（CLI / MCP / agent 用；仓库没有 OpenAPI，这份自建 schema 就是接口文档）
    SchemaModule,
    Student360Module,
    IdpModule,
    UsersModule,
    AiModule,
    AiSummarizeModule,
    WechatBindingModule,
    HomepageConfigModule,
    StudentAuthModule,
    RoleManagementModule,
    MailArchiveModule,
    AiRouteModule,
    GetnoteModule,
    NoteSnapshotModule,
    OpenPlatformModule,
    WeilingModule,
    GetnoteSourceModule,
    ReportsModule,
    FieldMaskModule,
    StudentScopeModule,
    DepartmentModule,
    MeetingRoomModule,
    NoteArchiveModule,
    MeetingMinutesModule,
    SystemMonitorModule,
    // 教学域三块（专用逻辑 + 建表）
    MarkbookModule,
    CurriculumModule,
    BehaviourModule,
  ],
})
export class AppModule {}
