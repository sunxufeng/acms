import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';
import { baseClientProvider } from '../base.provider.js';
import { StudentScopeModule } from '../shared/student-scope.module.js';

@Module({
  // 成绩类报表含学生明细，要套学生档案行级范围（见 ReportsService 的 scopeExamRows）
  imports: [StudentScopeModule],
  controllers: [ReportsController],
  providers: [ReportsService, baseClientProvider],
})
export class ReportsModule {}
