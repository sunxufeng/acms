import { Module } from '@nestjs/common';
import { baseClientProvider } from '../base.provider.js';
import { FileUploadModule } from '../file-upload/file-upload.module.js';
import { MailAccountService } from './mail-account.service.js';
import { MailArchiveService } from './mail-archive.service.js';
import { MailAccountController, MailArchiveController } from './mail-archive.controller.js';

/**
 * 邮件自动归档模块。
 *  - mail-accounts：IMAP 账户配置（密码 AES 加密入库，列表/详情以掩码返回）
 *  - mail-archive：归档邮件记录（由同步任务写入，前端只读）
 *
 * ⚠️ 触发时间**不在这个模块里**了（2026-09-24）：原来是硬编码的「每 15 分钟」cron 表达式，
 *    现在由 `ScheduledTasksRunner` 按「定时任务」页的任务行驱动
 *    （默认任务「邮件收取」= 每15分钟，与改造前行为等价）。
 *    每个账户**是否真去收**仍由它自己的「收取频率」决定（节流在 `syncAll` 内）。
 *    `exports` 是给调度器注入用的，别删。
 */
@Module({
  imports: [FileUploadModule],
  controllers: [MailAccountController, MailArchiveController],
  providers: [MailAccountService, MailArchiveService, baseClientProvider],
  exports: [MailArchiveService],
})
export class MailArchiveModule {}
