import { Module, OnModuleInit } from '@nestjs/common';
import { Cron } from 'croner';
import { AiRouteService } from './ai-route.service.js';
import { AiRouteAdminController } from './ai-route-admin.controller.js';
import { AiGatewayController } from './ai-gateway.controller.js';
import { runAs, systemActor } from '../shared/actor-context.js';

/**
 * AI 路由模块。
 *  - 启动期幂等建 6 张表（ensureTable 内部有 DDL + 元数据 upsert）
 *  - 每 10 分钟做一次上游健康检查（探测 /models），把连续失败的上游标成「异常」，
 *    路由选择会跳过异常上游 —— acapi 原版 health/failCount 是死字段，这里真跑
 *  - 通用 CRUD（分组/上游/模型路由/密钥/用量/日志）由 generic-crud 承载，
 *    见 shared/lifecycle.meta.ts 的 AI_ROUTE_METAS
 */
@Module({
  controllers: [AiGatewayController, AiRouteAdminController],
  providers: [AiRouteService],
  exports: [AiRouteService],
})
export class AiRouteModule implements OnModuleInit {
  constructor(private readonly svc: AiRouteService) {}

  async onModuleInit(): Promise<void> {
    // 建表放这里（而不是 service 构造期），失败也不影响 API 启动
    await this.svc.ensureTables().catch(() => undefined);

    new Cron(
      '*/10 * * * *',
      { name: 'ai-upstream-health', protect: true },
      () => {
        runAs(systemActor('ai-route', '系统 · AI 路由'), () => this.svc.healthCheckAll()).catch(() => undefined);
      },
    );
  }
}
