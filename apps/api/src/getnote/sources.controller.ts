import {
  Controller, Get, Post, Put, Delete, Param, Query, Body, Req, UseGuards, Inject,
} from '@nestjs/common';
import type { Request } from 'express';
import type { SessionUser } from '@acms/contracts';
import { SessionGuard } from '../auth/session.guard.js';
import { GetnoteSourceService } from './sources.service.js';

/**
 * 知识库配置（getnote_source）控制器。
 *
 * 路由顺序：带后缀的子路由（test / sync / sync-status）必须先声明，
 * 否则会被 `@Get(':id')` / `@Put(':id')` 通配吃掉。
 */
@Controller('getnote-sources')
@UseGuards(SessionGuard)
export class GetnoteSourceController {
  constructor(@Inject(GetnoteSourceService) private readonly svc: GetnoteSourceService) {}

  // ── 标准 CRUD（透传到 BaseRecordService）────────────────────────

  @Get()
  list(@Req() req: Request, @Query() q: Record<string, string | undefined>) {
    return this.svc.list((req as Request & { user: SessionUser }).user, q);
  }

  @Get(':id')
  detail(@Req() req: Request, @Param('id') id: string) {
    return this.svc.detail((req as Request & { user: SessionUser }).user, id);
  }

  @Post()
  create(@Req() req: Request, @Body() body: Record<string, unknown>) {
    return this.svc.create((req as Request & { user: SessionUser }).user, body);
  }

  @Put(':id')
  update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.svc.update((req as Request & { user: SessionUser }).user, id, body);
  }

  @Delete(':id')
  archive(@Req() req: Request, @Param('id') id: string) {
    return this.svc.archive((req as Request & { user: SessionUser }).user, id);
  }

  // ── 同步动作（必须在 :id 之前）─────────────────────────────────────

  /** 测试连通性：按笔记类型分发。得到大脑调真实 API，其他类型返回 501 提示未接入 */
  @Post(':id/test')
  test(@Req() req: Request, @Param('id') id: string) {
    return this.svc.testSource((req as Request & { user: SessionUser }).user, id);
  }

  /** 立即收取：异步触发，立刻返回当前进度；前端轮询 sync-status 拿实时状态 */
  @Post(':id/sync')
  startSync(@Param('id') id: string) {
    return this.svc.startSync(id);
  }

  /** 同步进度（轮询）。无历史时返回 running:false 的初始状态 */
  @Get(':id/sync-status')
  syncStatus(@Param('id') id: string) {
    return this.svc.getSyncStatus(id);
  }
}