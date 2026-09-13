import { Module, OnModuleInit } from '@nestjs/common';
import { CurriculumController } from './curriculum.controller.js';
import { CurriculumService } from './curriculum.service.js';

/**
 * 课程规划模块（教学域第四块，参照 Gibbon v31 的 Planner）。
 *
 * 分工：
 *  - **通用 CRUD**（单元 / 单元环节 / 单元开课 / 部署环节 / 单元挂成果 / 学习成果 /
 *    课时教案 / 课时挂成果 / 作业提交 / 作业完成追踪）由 `GenericCrudModule.registerAll`
 *    承载，元数据在 `curriculum.meta.ts` 的 `CURRICULUM_METAS` —— 需要在 app.module.ts 里注册：
 *      `GenericCrudModule.registerAll(CURRICULUM_METAS)`
 *  - **专用接口**（部署、覆盖率、迟交重算）由本模块的 controller/service 承载
 *
 * 启动期幂等建 10 张自建表；建表失败不阻断启动（接口会返回 SQL_DISABLED 或空结果）。
 */
@Module({
  controllers: [CurriculumController],
  providers: [CurriculumService],
  exports: [CurriculumService],
})
export class CurriculumModule implements OnModuleInit {
  constructor(private readonly svc: CurriculumService) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.svc.ensureTables();
    } catch (e) {
      // 建表失败不应阻断启动；日志里会提示，读取时返回空列表
      console.error(`[curriculum] 启动建表失败: ${(e as Error).message}`);
    }
  }
}
