import { Module, OnModuleInit } from '@nestjs/common';
import { MarkbookController } from './markbook.controller.js';
import { MarkbookService } from './markbook.service.js';

/**
 * 成绩册模块（教学域第三块，参照 Gibbon v31 的 Markbook）。
 *
 * 分工：
 *  - **通用 CRUD**（成绩册列 / 条目 / 个人目标）由 `GenericCrudModule.registerAll(MARKBOOK_METAS)`
 *    承载，元数据在 `markbook.meta.ts` —— 需要在 app.module.ts 里注册：
 *      `GenericCrudModule.registerAll(MARKBOOK_METAS)`
 *  - **专用接口**（网格、批量录入、快照重算、列管理）由本模块的 controller/service 承载
 *  - **配置表**（等级体系 / 等级 / 类型权重）在 `TEACHING_CONFIG_METAS` 里，但**建表由本模块负责** ——
 *    通用 CRUD 只生成路由、不会建表，漏了的话那些接口会全线 500。
 *
 * 启动期幂等建 6 张自建表；建表失败不阻断启动（读取时返回空网格）。
 */
@Module({
  controllers: [MarkbookController],
  providers: [MarkbookService],
  exports: [MarkbookService],
})
export class MarkbookModule implements OnModuleInit {
  constructor(private readonly svc: MarkbookService) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.svc.ensureTables();
    } catch (e) {
      // 建表失败不阻断启动；日志里会提示，读取时返回空结果
      console.error(`[markbook] 启动建表失败: ${(e as Error).message}`);
    }
  }
}
