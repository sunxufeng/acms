import { Module } from '@nestjs/common';
import { NoteArchiveModule } from '../note-archive/note-archive.module.js';
import { WeilingModule } from '../weiling/weiling.module.js';
import { MailArchiveModule } from '../mail-archive/mail-archive.module.js';
import { GetnoteSourceModule } from '../getnote/sources.module.js';
import { GetnoteModule } from '../getnote/getnote.module.js';
import { StudentSupportModule } from '../student-support/student-support.module.js';
import { ScheduledTasksRunner } from './scheduled-tasks.runner.js';

/**
 * 定时任务统一调度（2026-09-24）。
 *
 * 只放调度器，不放执行体 —— 五类任务的业务逻辑仍在各自模块里
 * （笔记归档 / 卫瓴联系人同步 / 邮件收取 / 知识库同步 / **看板快照**，2026-09-30 加最后一类），
 * 这里只负责「按任务行配置的时间叫它们起来」。
 *
 * ⚠️ 各模块必须 `exports` 自己的 service，本模块才能注入；少一个就是启动期
 *    `Nest can't resolve dependencies` 直接起不来（好在是启动就炸，不会静默）。
 */
@Module({
  // 🔴 这里必须把**每一个**被注入的 service 所属的模块都写进来。
  //    2026-09-30 踩到：`GetnoteModule` 的 `import` 语句写了、但漏在下面的数组里，
  //    TS 编译、单测、typecheck 全绿（数组元素只是类引用），**只有启动时才炸**：
  //    `Nest can't resolve dependencies of ScheduledTasksRunner (…, GetnoteService)`。
  //    而且症状是「新 slot 起不来 ⇒ 探活恒 000」，若在蓝绿切换后才暴露就是线上 502。
  //    守卫见 `apps/api/test/scheduled-tasks-di.test.ts`。
  imports: [
    NoteArchiveModule,
    WeilingModule,
    MailArchiveModule,
    GetnoteSourceModule,
    GetnoteModule,
    StudentSupportModule,
  ],
  providers: [ScheduledTasksRunner],
})
export class ScheduledTasksModule {}
