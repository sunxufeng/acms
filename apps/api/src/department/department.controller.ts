import { Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { SessionUser } from '@acms/contracts';
import { SessionGuard } from '../auth/session.guard.js';
import { requireModule } from '../shared/require-module.js';
import { DepartmentService } from './department.service.js';

/**
 * 部门管理控制器。
 *
 * 路由顺序：带后缀的子路由（sync / sync-status）必须先声明，否则会被 GET 通配吃掉。
 *
 * 权限分两档：
 * - **读**（部门树 / 成员 / 同步进度）：只要求登录态。部门与成员属公开组织信息（页面下拉、
 *   「点部门看员工」都要用），与菜单「部门管理」的可见性一致。
 * - **写**（`POST /departments/sync`）：`module:departmentManagement:update`。
 *   ⚠️ 2026-09-14 之前这里**没有任何权限守卫**，只挂 SessionGuard ⇒ 任何已登录用户
 *   （含 student / parent 角色）都能触发飞书通讯录同步（会打上游并改写本地部门/成员快照）。
 *   现在收口到 update，默认只有系统管理员持有；需要给别的角色用就在权限矩阵里勾。
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
  sync(@Req() req: { user: SessionUser }) {
    requireModule(req.user, 'departmentManagement', 'update');
    return this.svc.sync();
  }

  /** 同步进度（轮询） */
  @Get('sync-status')
  syncStatus() {
    return this.svc.getSyncStatus();
  }

  /**
   * 成员快照的轻量索引 `[{ departmentId, openId }]`（读本地快照，只读、不打上游）。
   * 供用户管理页左树一次算清「每个部门能筛出几个系统账号」——
   * 逐部门调下面的 :id/members 会发 N 次请求。
   * ⚠️ 静态路由必须排在带参数的路由之前（同 sync / sync-status 的约定）。
   */
  @Get('member-index')
  memberIndex() {
    return this.svc.memberIndex();
  }

  /**
   * 当前用户**所属**的部门（`{ ids, names }`）。
   * 用途：新建会议纪要选「指定部门可见」时**预填默认选中自己部门**（用户看得见、可改）。
   * 静态路由，必须排在下面的 `:id/members` 之前。
   */
  @Get('my-departments')
  myDepartments(@Req() req: { user: SessionUser }) {
    return this.svc.myDepartments(req.user);
  }

  /**
   * 某部门下的员工（读本地成员快照，不打上游）。
   * includeSub 默认 **true**：飞书的按部门取人只给直属成员，
   * 不含下级的话点「公司」/中间层部门永远是空的。传 0 只看直属。
   */
  @Get(':id/members')
  members(@Param('id') id: string, @Query('includeSub') includeSub?: string) {
    return this.svc.listMembers(id, includeSub !== '0' && includeSub !== 'false');
  }
}
