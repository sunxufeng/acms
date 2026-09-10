import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { SessionGuard } from '../auth/session.guard.js';
import { DepartmentService } from './department.service.js';

/**
 * 部门管理控制器。
 *
 * 路由顺序：带后缀的子路由（sync / sync-status）必须先声明，否则会被 GET 通配吃掉。
 * 仅用 SessionGuard（校验登录态）→ 所有已登录用户可读（菜单 perm 为空 = 全员可见）。
 * 不调用 authorize：本模块只读、无写权限点，与「全员只读」需求一致。
 */
@Controller('departments')
@UseGuards(SessionGuard)
export class DepartmentController {
  constructor(private readonly svc: DepartmentService) {}

  /** 读取全部部门（前端构建树） */
  @Get()
  list() {
    return this.svc.list();
  }

  /** 立即同步飞书部门：异步触发，立刻返回当前进度；前端轮询 /departments/sync-status */
  @Post('sync')
  sync() {
    return this.svc.sync();
  }

  /** 同步进度（轮询） */
  @Get('sync-status')
  syncStatus() {
    return this.svc.getSyncStatus();
  }
}
