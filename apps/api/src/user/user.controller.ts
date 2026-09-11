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

  /** ⚠️ 必须声明在 @Get(':id') 之前，否则 'names' 会被当成 id。
   *  人员姓名列表（全员可读），供主持人/记录人等下拉使用。 */
  @Get('names')
  listNames() {
    return this.svc.listNames();
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
