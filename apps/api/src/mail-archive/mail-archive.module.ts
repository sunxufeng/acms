import { Module, OnModuleInit } from '@nestjs/common';
import { Cron } from 'croner';
import { baseClientProvider } from '../base.provider.js';
import { FileUploadModule } from '../file-upload/file-upload.module.js';
import { MailAccountService } from './mail-account.service.js';
import { MailArchiveService } from './mail-archive.service.js';
import { MailAccountController, MailArchiveController } from './mail-archive.controller.js';

/**
 * 邮件自动归档模块。
 *  - mail-accounts：IMAP 账户配置（密码 AES 加密入库，列表/详情以掩码返回）
 *  - mail-archive：归档邮件记录（由同步任务写入，前端只读）
 *  - 定时任务：每 15 分钟触发一次「同步全部启用账户」，各账户按自身收取频率节流
 */
@Module({
  imports: [FileUploadModule],
  controllers: [MailAccountController, MailArchiveController],
  providers: [MailAccountService, MailArchiveService, baseClientProvider],
})
export class MailArchiveModule implements OnModuleInit {
  private readonly logger = console;

  constructor(private readonly archive: MailArchiveService) {}

  onModuleInit() {
    // 每 15 分钟执行一次全量同步（账户级频率在 syncAll 内部节流）
    try {
      new Cron(
        '*/15 * * * *',
        { name: 'mail-archive-sync', protect: true },
        () => {
          this.archive
            .syncAll()
            .then((r) => this.logger.log(`[mail-archive] 定时同步完成，触发 ${r.synced} 个账户`))
            .catch((e) => this.logger.error(`[mail-archive] 定时同步失败: ${(e as Error).message}`));
        },
      );
      this.logger.log('[mail-archive] 已注册定时同步任务（每 15 分钟）');
    } catch (e) {
      this.logger.error(`[mail-archive] 定时任务注册失败: ${(e as Error).message}`);
    }
  }
}
