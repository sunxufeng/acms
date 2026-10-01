import { Module } from '@nestjs/common';
import { CodeRulesController } from './code-rules.controller.js';
import { CodeRulesService } from './code-rules.service.js';

/**
 * 「代码规则」模块（v14，2026-10-01）。
 *
 * 🔴 **不新建表** —— 配置存在系统配置表的一行里（固定 id 的 `createWithId` = 天然 upsert），
 *    与 `homepage_config` / `student_support_config` / `weiling_mapping_config` 同族。
 *    理由见 `CodeRulesService` 文件头（单行 JSON 配置已经有三个先例，再开表收益为零）。
 *
 * 🔴 `exports` 是必须的：`StudentModule` 要注入 `CodeRulesService`，
 *    在**新建学生时**给留空的学籍号自动生成（K1）。
 *    被别的模块注入就必须 `exports`，否则启动期
 *    `Nest can't resolve dependencies of StudentService` —— 而 tsc / 单测全绿
 *    （守卫 `apps/api/test/nest-module-di.test.ts` 会拦这一类）。
 */
@Module({
  controllers: [CodeRulesController],
  providers: [CodeRulesService],
  exports: [CodeRulesService],
})
export class CodeRulesModule {}
