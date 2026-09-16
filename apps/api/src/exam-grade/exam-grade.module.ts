import { Module, type OnModuleInit } from '@nestjs/common';
import { MarkbookModule } from '../markbook/markbook.module.js';
import { ExamGradeController } from './exam-grade.controller.js';
import { ExamGradeService } from './exam-grade.service.js';

/**
 * 考试与成绩模块（参照 RosarioSIS v13 Grades 模块，2026-09-16）。
 *
 * 分工：
 *  - **通用 CRUD**（考核类型 / 成绩批次 / 期末总评 / 成绩单）由
 *    `GenericCrudModule.registerAll(EXAM_GRADE_METAS)` 承载，元数据在 `exam-grade.meta.ts`
 *    —— 需要在 app.module.ts 里注册。
 *  - **专用接口**（结转预览、一键结转、确认/撤销、评语、成绩单、PDF 导出）由本模块承载。
 *  - **建表**只在本模块：通用 CRUD 只生成路由、不建表，漏了会导致接口全线 500。
 *
 * `imports: [MarkbookModule]` —— 结转要读成绩册的网格（列 + 单元格 + 等级 + 权重 + 目标），
 * 直接复用 `MarkbookService`，绝不重写一遍取数逻辑（那就是第二套口径）。
 *
 * 启动期幂等建 4 张自建表；建表失败不阻断启动（读取时返回空）。
 */
@Module({
  imports: [MarkbookModule],
  controllers: [ExamGradeController],
  providers: [ExamGradeService],
  exports: [ExamGradeService],
})
export class ExamGradeModule implements OnModuleInit {
  constructor(private readonly svc: ExamGradeService) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.svc.ensureTables();
    } catch (e) {
      // 建表失败不阻断启动；日志里会提示，读取时返回空结果
      console.error(`[exam-grade] 启动建表失败: ${(e as Error).message}`);
    }
  }
}
