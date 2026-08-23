import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { SessionUser } from '@acms/contracts';
import { authorize } from '@acms/domain';
import { SessionGuard } from '../auth/session.guard.js';
import { WechatBindingService } from './wechat-binding.service.js';

function toPrincipal(user: SessionUser) {
  return { roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel };
}

/**
 * 微信登录用户的后台管理动作（解绑 / 强制下线）。
 * 与通用 CRUD 的 /wechat-bindings 列表接口分离路由，避免路径冲突；
 * 需要 config:write 权限（与「微信登录用户」菜单一致，仅管理员可见可操作）。
 */
@Controller('wechat-binding-actions')
@UseGuards(SessionGuard)
export class WechatBindingController {
  constructor(private readonly svc: WechatBindingService) {}

  @Post('unbind')
  unbind(@Req() req: Request, @Body() body: { id: string }) {
    if (!authorize(toPrincipal((req as Request & { user: SessionUser }).user), 'config:write').allowed)
      throw new Error('FORBIDDEN:config:write');
    return this.svc.unbind(body.id);
  }

  @Post('force-logout')
  forceLogout(@Req() req: Request, @Body() body: { id: string }) {
    if (!authorize(toPrincipal((req as Request & { user: SessionUser }).user), 'config:write').allowed)
      throw new Error('FORBIDDEN:config:write');
    return this.svc.forceLogout(body.id);
  }
}
