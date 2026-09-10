import { Module, OnModuleInit } from '@nestjs/common';
import { DepartmentController } from './department.controller.js';
import { DepartmentService } from './department.service.js';

/**
 * 部门管理模块。
 *
 * 无依赖其它模块（飞书部门读取走直连 tenant token，不经 BaseClient）。
 * 启动期幂等建表（ensureDepartmentTable）；这里不做定时同步 —— 部门变更频率低，
 * 由用户在「部门管理」页点「同步飞书部门」按钮手动触发。
 */
@Module({
  controllers: [DepartmentController],
  providers: [DepartmentService],
  exports: [DepartmentService],
})
export class DepartmentModule implements OnModuleInit {
  constructor(private readonly svc: DepartmentService) {}

  async onModuleInit() {
    try {
      await this.svc.ensureDepartmentTable();
    } catch (e) {
      // 建表失败不应阻断启动；会在日志里提示，读取时返回空列表
      console.error(`[department] 启动建表失败: ${(e as Error).message}`);
    }
  }
}
