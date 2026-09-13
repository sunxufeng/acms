import { Module, OnModuleInit } from '@nestjs/common';
import { BehaviourController, BehaviourRecordService } from './behaviour.controller.js';
import { BehaviourService } from './behaviour.service.js';
import { baseClientProvider } from '../base.provider.js';

/**
 * 行为记录模块（教学域第三块，参照 GibbonEdu/core v31 的 Behaviour）。
 *
 * 分工：
 *  - **通用 CRUD**（跟进流水 / 学生告警 / 通知信件）由 `GenericCrudModule.registerAll(BEHAVIOUR_METAS)`
 *    承载，元数据在 `behaviour.meta.ts` —— 需要在 app.module.ts 里注册：
 *      `GenericCrudModule.registerAll(BEHAVIOUR_METAS)`
 *  - **行为记录**（写入后要重算告警）与**专用接口**（重算、生成信件、统计、取跟进流水）
 *    由本模块的 controller/service 承载 —— 需要在 app.module.ts 里注册：`BehaviourModule`
 *
 * 启动期幂等建 4 张自建表；建表失败不阻断启动（接口会返回 SQL_DISABLED）。
 */
@Module({
  controllers: [BehaviourController],
  providers: [BehaviourService, BehaviourRecordService, baseClientProvider],
  exports: [BehaviourService],
})
export class BehaviourModule implements OnModuleInit {
  constructor(private readonly svc: BehaviourService) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.svc.ensureTables();
    } catch (e) {
      // 建表失败不应阻断启动；日志里会提示，读取时返回 SQL_DISABLED
      console.error(`[behaviour] 启动建表失败: ${(e as Error).message}`);
    }
  }
}
