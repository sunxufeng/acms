import { Module } from '@nestjs/common';
import { NoteArchiveController } from './note-archive.controller.js';
import { NoteArchiveService } from './note-archive.service.js';

/**
 * 笔记归档到飞书云盘。
 *
 * ⚠️ 触发时间**不在这个模块里**了（2026-09-24）：改由 `ScheduledTasksRunner` 按
 *    「定时任务」页的任务行配置驱动（默认 01:00 IDP / 01:30 全量）。
 *    本模块只提供执行体 `start()` 与「上次运行」回写。
 *    `exports` 是给调度器注入用的，别删。
 */
@Module({
  controllers: [NoteArchiveController],
  providers: [NoteArchiveService],
  exports: [NoteArchiveService],
})
export class NoteArchiveModule {}
