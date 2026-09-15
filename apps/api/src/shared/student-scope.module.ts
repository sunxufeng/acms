import { Global, Module } from '@nestjs/common';
import { baseClientProvider } from '../base.provider.js';
import { StudentScopeService } from './student-scope.service.js';

/**
 * 学生档案「数据范围」全局模块。
 *
 * 以 @Global 注册（与 FieldMaskModule 同一模式），这样两类调用方都能直接注入：
 *  - `student.service.ts`（学生档案自建接口）
 *  - `generic-crud` 动态生成的各模块 service（考勤/成绩/家校沟通/… 按学生过滤）
 */
@Global()
@Module({
  providers: [StudentScopeService, baseClientProvider],
  exports: [StudentScopeService],
})
export class StudentScopeModule {}
