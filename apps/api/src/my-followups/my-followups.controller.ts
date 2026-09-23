import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { SessionUser } from '@acms/contracts';
import { SessionGuard } from '../auth/session.guard.js';
import { MyFollowupsService } from './my-followups.service.js';

function userOf(req: Request): SessionUser {
  return (req as Request & { user: SessionUser }).user;
}

/**
 * 「我的跟进」（招生管理 › 我的跟进）。
 *
 * 权限与「联系人管理」一致（`module:weilingContacts:read`）—— 它本质上是联系人维度的聚合视图，
 * 没有联系人读权限就不该看到这些数据。**复用现有权限点**（不新增），
 * 所以有联系人权限的角色立刻就能用，不需要抬权限版本、也不需要去角色管理逐个补勾。
 */
@Controller('my-followups')
@UseGuards(SessionGuard)
export class MyFollowupsController {
  constructor(private readonly svc: MyFollowupsService) {}

  /**
   * 归属人候选（当前联系人表里出现过的值）—— 供「归属人映射」页配置选择。
   * ⚠️ 静态路由要排在 `@Get()` 之前（这里没有 `:id`，但保持一致纪律）。
   */
  @Get('owners')
  owners(@Req() req: Request) {
    return this.svc.ownerOptions(userOf(req));
  }

  /** 有映射关系的用户列表 —— 「我的跟进」顶部的「用户」筛选用它（筛选用用户，不用归属人） */
  @Get('users')
  users(@Req() req: Request) {
    return this.svc.userOptions(userOf(req));
  }

  @Get()
  list(@Req() req: Request, @Query() q: Record<string, string | undefined>) {
    return this.svc.list(userOf(req), q);
  }
}
