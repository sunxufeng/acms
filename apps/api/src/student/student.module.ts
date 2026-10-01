import { Module } from '@nestjs/common';
import { StudentController } from './student.controller.js';
import { StudentService } from './student.service.js';
import { baseClientProvider } from '../base.provider.js';
import { FileUploadModule } from '../file-upload/file-upload.module.js';
import { DictModule } from '../dictionary/dict.module.js';
import { CodeRulesModule } from '../code-rules/code-rules.module.js';

/**
 * 🔴 `CodeRulesModule` 是「代码规则」（v14）要用的：`StudentService` 注入了
 *    `CodeRulesService`，在**新建学生**时给留空的「学籍号（脱敏）」自动生成（K1）。
 *    **import 了就必须写进下面的 `imports` 数组** —— 漏了的话 tsc / 单测全绿、
 *    只有启动期 `Nest can't resolve dependencies of StudentService`
 *    （守卫 `apps/api/test/nest-module-di.test.ts` 会拦这一类）。
 *    （它不反向依赖 StudentModule，所以没有循环。）
 */
@Module({
  imports: [FileUploadModule, DictModule, CodeRulesModule],
  controllers: [StudentController],
  providers: [StudentService, baseClientProvider],
  exports: [StudentService],
})
export class StudentModule {}
