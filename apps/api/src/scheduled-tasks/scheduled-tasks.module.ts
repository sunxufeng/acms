import { Module } from '@nestjs/common';
import { NoteArchiveModule } from '../note-archive/note-archive.module.js';
import { WeilingModule } from '../weiling/weiling.module.js';
import { MailArchiveModule } from '../mail-archive/mail-archive.module.js';
import { GetnoteSourceModule } from '../getnote/sources.module.js';
import { ScheduledTasksRunner } from './scheduled-tasks.runner.js';

/**
 * 定时任务统一调度（2026-09-24）。
 *
 * 只放调度器，不放执行体 —— 四类任务的业务逻辑仍在各自模块里
 * （笔记归档 / 卫瓴联系人同步 / 邮件收取 / 知识库同步），这里只负责「按任务行配置的时间叫它们起来」。
 *
 * ⚠️ 各模块必须 `exports` 自己的 service，本模块才能注入；少一个就是启动期
 *    `Nest can't resolve dependencies` 直接起不来（好在是启动就炸，不会静默）。
 */
@Module({
  imports: [NoteArchiveModule, WeilingModule, MailArchiveModule, GetnoteSourceModule],
  providers: [ScheduledTasksRunner],
})
export class ScheduledTasksModule {}
