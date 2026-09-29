import { Module } from '@nestjs/common';
import { NoteArchiveController } from './note-archive.controller.js';
import { NoteArchiveService } from './note-archive.service.js';
import { StudentSupportModule } from '../student-support/student-support.module.js';

/**
 * 笔记归档到飞书云盘。
 *
 * ⚠️ 触发时间**不在这个模块里**了（2026-09-24）：改由 `ScheduledTasksRunner` 按
 *    「定时任务」页的任务行配置驱动（默认 01:00 IDP / 01:30 全量）。
 *    本模块只提供执行体 `start()` 与「上次运行」回写。
 *    `exports` 是给调度器注入用的，别删。
 *
 * 🆕 2026-09-30：`imports` 加了 `StudentSupportModule` —— 「看板快照」类任务的执行体
 *    在 `StudentSupportService` 里（同一张任务表、同一个调度器、同一个手动运行端点）。
 *    ⚠️ 依赖方向单向（本模块 → 学生支持），不会成环。
 */
@Module({
  imports: [StudentSupportModule],
  controllers: [NoteArchiveController],
  providers: [NoteArchiveService],
  exports: [NoteArchiveService],
})
export class NoteArchiveModule {}
