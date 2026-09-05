import {
  Controller, Get, Post, Put, Delete, Param, Query, Body, Req, UseGuards, HttpException, HttpStatus,
} from '@nestjs/common';
import type { Request } from 'express';
import { authorize } from '@acms/domain';
import type { SessionUser } from '@acms/contracts';
import { SessionGuard } from '../auth/session.guard.js';
import { GetnoteService } from './getnote.service.js';

/**
 * 得到大脑（Get笔记）代理控制器。
 *
 * 本服务是**全局单账号**：一份 API Key 供全员使用，所有登录用户看到的是同一份笔记库。
 * 因此这里只做「有没有 getnote 权限」的校验，不做 per-user 数据隔离。
 *
 * ⚠️ 路由顺序：带后缀的子路由必须先声明，否则会被 `:id` 通配吃掉。
 */
@Controller('getnote')
@UseGuards(SessionGuard)
export class GetnoteController {
  constructor(private readonly svc: GetnoteService) {}

  private assert(user: SessionUser, perm: 'getnote:read' | 'getnote:write') {
    if (!authorize({ roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel }, perm).allowed)
      throw new HttpException(`FORBIDDEN:${perm}`, HttpStatus.FORBIDDEN);
  }

  /** 凭证是否已配置。前端据此显示「尚未授权」引导，而不是弹一堆 502。 */
  @Get('status')
  status(@Req() req: Request) {
    this.assert((req as Request & { user: SessionUser }).user, 'getnote:read');
    return { configured: this.svc.isConfigured() };
  }

  /** 笔记列表。cursor 透传；带 q 时改走语义搜索（见 service.list 注释）。 */
  @Get('notes')
  list(@Req() req: Request, @Query('cursor') cursor?: string, @Query('q') q?: string) {
    this.assert((req as Request & { user: SessionUser }).user, 'getnote:read');
    return this.svc.list(cursor, q);
  }

  /** ⚠️ 必须声明在 @Post('notes/:id/tags') 与 @Get('notes/:id') 之前 */
  @Post('notes/search')
  search(@Req() req: Request, @Body() body: { query?: string; top_k?: number }) {
    this.assert((req as Request & { user: SessionUser }).user, 'getnote:read');
    const q = String(body?.query ?? '').trim();
    if (!q) throw new HttpException('BAD_REQUEST:query required', HttpStatus.BAD_REQUEST);
    return this.svc.recall(q, body?.top_k);
  }

  @Post('notes')
  create(@Req() req: Request, @Body() body: Record<string, unknown>) {
    this.assert((req as Request & { user: SessionUser }).user, 'getnote:write');
    return this.svc.create({
      title: body?.title as string | undefined,
      content: body?.content as string | undefined,
      tags: Array.isArray(body?.tags) ? (body.tags as string[]) : undefined,
      topic_id: body?.topic_id as string | undefined,
      parent_id: body?.parent_id as string | undefined,
    });
  }

  @Get('notes/:id')
  detail(@Req() req: Request, @Param('id') id: string) {
    this.assert((req as Request & { user: SessionUser }).user, 'getnote:read');
    return this.svc.detail(id);
  }

  @Put('notes/:id')
  update(@Req() req: Request, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    this.assert((req as Request & { user: SessionUser }).user, 'getnote:write');
    return this.svc.update({
      note_id: id,
      title: body?.title as string | undefined,
      content: body?.content as string | undefined,
      tags: Array.isArray(body?.tags) ? (body.tags as string[]) : undefined,
    });
  }

  /** 删除 = 移入回收站。前端必须先让用户二次确认笔记标题。 */
  @Delete('notes/:id')
  remove(@Req() req: Request, @Param('id') id: string) {
    this.assert((req as Request & { user: SessionUser }).user, 'getnote:write');
    return this.svc.remove(id);
  }

  @Post('notes/:id/tags')
  addTags(@Req() req: Request, @Param('id') id: string, @Body() body: { tags?: string[] }) {
    this.assert((req as Request & { user: SessionUser }).user, 'getnote:write');
    const tags = Array.isArray(body?.tags) ? body.tags.filter((t) => String(t).trim()) : [];
    if (!tags.length) throw new HttpException('BAD_REQUEST:tags required', HttpStatus.BAD_REQUEST);
    return this.svc.addTags(id, tags);
  }

  /** ⚠️ 删的是 tag_id 不是标签名；system 类型标签删不掉。 */
  @Delete('notes/:id/tags/:tagId')
  removeTag(@Req() req: Request, @Param('id') id: string, @Param('tagId') tagId: string) {
    this.assert((req as Request & { user: SessionUser }).user, 'getnote:write');
    return this.svc.removeTag(id, tagId);
  }
}
