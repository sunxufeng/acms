import { Controller, Get, Post, Put, Delete, Param, Query, Body, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { SessionUser } from '@acms/contracts';
import { SessionGuard } from '../auth/session.guard.js';
import { UsersService } from './user.service.js';

@Controller('users')
@UseGuards(SessionGuard)
export class UsersController {
  constructor(private readonly svc: UsersService) {}

  @Get()
  list(@Req() req: Request & { user: SessionUser }, @Query() q: Record<string, string | undefined>) {
    return this.svc.list(req.user, q);
  }

  /** ⚠️ 必须声明在 @Get(':id') 之前，否则会被当成 id。
   *  人员姓名列表（全员可读），供主持人/记录人等纯姓名下拉使用。 */
  @Get('names')
  listNames() {
    return this.svc.listNames();
  }

  /** ⚠️ 同上，必须在 @Get(':id') 之前。
   *  人员目录（全员可读）：姓名 + Open ID + 教师类型 + 校区 + 角色，
   *  供班主任/招生老师选择器与筛选使用（这些字段存的是 Open ID，只给姓名不可用）。 */
  @Get('directory')
  listDirectory() {
    return this.svc.listDirectory();
  }

  @Get(':id')
  get(@Req() req: Request & { user: SessionUser }, @Param('id') id: string) {
    return this.svc.get(req.user, id);
  }

  @Post()
  create(@Req() req: Request & { user: SessionUser }, @Body() body: Record<string, unknown>) {
    return this.svc.create(req.user, body);
  }

  @Put(':id')
  update(
    @Req() req: Request & { user: SessionUser },
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.svc.update(req.user, id, body);
  }

  @Post(':id/status')
  setStatus(
    @Req() req: Request & { user: SessionUser },
    @Param('id') id: string,
    @Body() body: { status: string },
  ) {
    return this.svc.setStatus(req.user, id, body?.status);
  }

  @Delete(':id')
  remove(@Req() req: Request & { user: SessionUser }, @Param('id') id: string) {
    return this.svc.remove(req.user, id);
  }
}
