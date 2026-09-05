import { Module, OnModuleInit } from '@nestjs/common';
import { Cron } from 'croner';
import { baseClientProvider } from '../base.provider.js';
import { GetnoteModule } from './getnote.module.js';
import { GetnoteSourceController } from './sources.controller.js';
import { GetnoteSourceService } from './sources.service.js';

/**
 * 知识库配置模块。
 * - CRUD：透传到 BaseRecordService（meta 描述字段约束，凭证字段加密）
 * - 测试连通性、立即收取（异步）、同步进度查询
 * - 定时调度：复用现有 croner（apps/api 已装 v10.0.1）。
 *   与 mail-archive 同模型：每 15 分钟扫描「启用」配置，按各配置自己的频率节流。
 *
 * ⚠️ 通过 imports 引入 GetnoteModule，SourcesService 依赖其 GetnoteService 做凭证探活与拉取。
 */
@Module({
  imports: [GetnoteModule],
  controllers: [GetnoteSourceController],
  providers: [GetnoteSourceService, baseClientProvider],
  exports: [GetnoteSourceService],
})
export class GetnoteSourceModule implements OnModuleInit {
  private readonly logger = console;
  private readonly scheduled = new Map<string, Cron>();

  constructor(private readonly svc: GetnoteSourceService) {}

  /**
   * 启动时注册一个 15 分钟跑一次的「扫描所有启用配置」的全局任务。
   * 各配置项按自己的「收取频率」节流（与 mail-archive 完全一致）。
   * 不为单条配置注册独立 Cron：cron 注册成本高，且源的增删改通过此扫描自驱。
   */
  onModuleInit() {
    try {
      new Cron(
        '*/15 * * * *',
        { name: 'getnote-source-sync', protect: true },
        () => {
          this.svc
            .syncAllDue()
            .then((r) =>
              this.logger.log(
                `[getnote-source] 调度扫描完成，触发 ${r.synced} 个，跳过 ${r.skipped} 个`,
              ),
            )
            .catch((e) =>
              this.logger.error(
                `[getnote-source] 调度扫描失败: ${(e as Error).message}`,
              ),
            );
        },
      );
      this.logger.log('[getnote-source] 已注册定时同步任务（每 15 分钟）');
    } catch (e) {
      this.logger.error(`[getnote-source] 定时任务注册失败: ${(e as Error).message}`);
    }
  }
}