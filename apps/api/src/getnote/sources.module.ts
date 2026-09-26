import { Module } from '@nestjs/common';
import { baseClientProvider } from '../base.provider.js';
import { GetnoteModule } from './getnote.module.js';
import { GetnoteSourceController } from './sources.controller.js';
import { GetnoteSourceService } from './sources.service.js';

/**
 * 知识库配置模块（Get笔记）。
 *
 * - CRUD：透传到 BaseRecordService（meta 描述字段约束，凭证字段加密）
 * - 测试连通性、立即收取（异步）、同步进度查询
 *
 * ⚠️ 定时调度**已移出本模块**（2026-09-26）：原先是硬编码的「每 15 分钟」cron 表达式，
 *    现在由 `ScheduledTasksRunner` 按「定时任务」页的任务行驱动
 *    （默认任务「知识库同步」= 每15分钟，与改造前行为等价）。
 *    与「邮件收取」同模型：调度器只决定**多久检查一次**，每条知识库配置自己的
 *    「收取频率」仍然生效（节流在 `GetnoteSourceService.syncAllDue` 内）。
 *    这里若再自建一份，同一个同步会被调度两次（两边都判到点、都写同步记录）。
 *
 * ⚠️ `exports` 是给 `ScheduledTasksRunner` 注入用的，别删（少了就是启动期
 *    `Nest can't resolve dependencies` 直接起不来）。
 *
 * ⚠️ 通过 imports 引入 GetnoteModule：SourcesService 依赖其 GetnoteService 做凭证探活与拉取。
 */
@Module({
  imports: [GetnoteModule],
  controllers: [GetnoteSourceController],
  providers: [GetnoteSourceService, baseClientProvider],
  exports: [GetnoteSourceService],
})
export class GetnoteSourceModule {}
