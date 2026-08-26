import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { hasPermission } from '@acms/domain';
import type { Permission, SessionUser } from '@acms/contracts';
import { SessionGuard } from '../auth/session.guard.js';
import {
  RoleManagementService,
  type CreateRoleInput,
  type UpdateRoleInput,
} from './role-management.service.js';

@Controller('role-management')
@UseGuards(SessionGuard)
export class RoleManagementController {
  constructor(private readonly svc: RoleManagementService) {}

  /** 仅系统管理员（持有 admin:user）可管理角色 */
  private requireAdmin(req: Request & { user: SessionUser }): void {
    const user = req.user;
    const allowed = hasPermission(
      { roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel },
      'admin:user' as Permission,
    );
    if (!allowed) throw new ForbiddenException('需要 admin:user 权限（系统管理员）');
  }

  @Get()
  list(@Req() req: Request & { user: SessionUser }) {
    this.requireAdmin(req);
    return this.svc.getConfig();
  }

  @Post()
  create(@Req() req: Request & { user: SessionUser }, @Body() dto: CreateRoleInput) {
    this.requireAdmin(req);
    return this.svc.createRole(dto);
  }

  @Put(':key')
  update(
    @Req() req: Request & { user: SessionUser },
    @Param('key') key: string,
    @Body() dto: UpdateRoleInput,
  ) {
    this.requireAdmin(req);
    return this.svc.updateRole(decodeURIComponent(key), dto);
  }

  @Delete(':key')
  remove(@Req() req: Request & { user: SessionUser }, @Param('key') key: string) {
    this.requireAdmin(req);
    return this.svc.deleteRole(decodeURIComponent(key));
  }
}
