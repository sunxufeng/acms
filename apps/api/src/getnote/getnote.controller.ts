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
 * ⚠️ 凭证模型（2026-09-05 修正）：
 * - **Client ID 是应用级的**（官方文档：在「应用管理」创建应用拿到），全局一份，存 .env
 * - **API Key 是用户级的**，一人一份，存服务端加密文件（见 credential.ts）
 *
 * 所以每个请求都必须带上当前用户，service 侧按 openId 取他自己的 Key。
 * 早期版本把两份都塞进 .env 全员共用，不只归属不对 —— 官方限流是**按 Key 算**的
 * （QPS 2 / 每天 5000 次），一份 Key 给全校用会直接撞墙。
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

  // ── 用户凭证（API Key 一人一份） ────────────────────────────────────

  /** 当前用户的凭证状态 + 服务器 Client ID 是否已配。不返回任何明文。 */
  @Get('credential')
  credential(@Req() req: Request) {
    const user = (req as Request & { user: SessionUser }).user;
    this.assert(user, 'getnote:read');
    return this.svc.credentialStatus(user);
  }

  /** 保存自己的 API Key。存之前会先打一次真实请求验活，验不过不落库。 */
  @Put('credential')
  saveCredential(@Req() req: Request, @Body() body: { apiKey?: string }) {
    const user = (req as Request & { user: SessionUser }).user;
    this.assert(user, 'getnote:write');
    return this.svc.saveCredential(user, String(body?.apiKey ?? ''));
  }

  @Delete('credential')
  clearCredential(@Req() req: Request) {
    const user = (req as Request & { user: SessionUser }).user;
    this.assert(user, 'getnote:write');
    return this.svc.clearCredential(user);
  }

  // ── 笔记 ↔ 业务实体 关联 ────────────────────────────────────────────

  /** 某业务实体（如某个学生）当前关联的笔记。关联记录全员可见，chip 上标注归属人。 */
  @Get('links')
  listLinks(@Req() req: Request, @Query('entityType') entityType?: string, @Query('entityId') entityId?: string) {
    this.assert((req as Request & { user: SessionUser }).user, 'getnote:read');
    if (!entityType || !entityId)
      throw new HttpException('BAD_REQUEST:entityType/entityId required', HttpStatus.BAD_REQUEST);
    return this.svc.listLinks(entityType, entityId);
  }

  /** 全量覆盖式写入关联（传空数组即清空）。与邮件归档「手动关联学生」同一范式。 */
  @Put('links')
  replaceLinks(@Req() req: Request, @Body() body: Record<string, unknown>) {
    const user = (req as Request & { user: SessionUser }).user;
    this.assert(user, 'getnote:write');
    const entityType = String(body?.entityType ?? '');
    const entityId = String(body?.entityId ?? '');
    if (!entityType || !entityId)
      throw new HttpException('BAD_REQUEST:entityType/entityId required', HttpStatus.BAD_REQUEST);
    const links = Array.isArray(body?.links) ? (body.links as { noteId: string; title?: string }[]) : [];
    return this.svc.replaceLinks(
      user,
      entityType,
      entityId,
      String(body?.entityName ?? ''),
      links,
    );
  }

  // ── 笔记 ────────────────────────────────────────────────────────────

  /** 笔记列表。cursor 透传；带 q 时改走语义搜索（见 service.list 注释）。 */
  @Get('notes')
  list(@Req() req: Request, @Query('cursor') cursor?: string, @Query('q') q?: string) {
    const user = (req as Request & { user: SessionUser }).user;
    this.assert(user, 'getnote:read');
    return this.svc.list(user, cursor, q);
  }

  /** ⚠️ 必须声明在 @Post('notes/:id/tags') 与 @Get('notes/:id') 之前 */
  @Post('notes/search')
  search(@Req() req: Request, @Body() body: { query?: string; top_k?: number }) {
    const user = (req as Request & { user: SessionUser }).user;
    this.assert(user, 'getnote:read');
    const q = String(body?.query ?? '').trim();
    if (!q) throw new HttpException('BAD_REQUEST:query required', HttpStatus.BAD_REQUEST);
    return this.svc.recall(user, q, body?.top_k);
  }

  @Post('notes')
  create(@Req() req: Request, @Body() body: Record<string, unknown>) {
    const user = (req as Request & { user: SessionUser }).user;
    this.assert(user, 'getnote:write');
    return this.svc.create(user, {
      title: body?.title as string | undefined,
      content: body?.content as string | undefined,
      tags: Array.isArray(body?.tags) ? (body.tags as string[]) : undefined,
      topic_id: body?.topic_id as string | undefined,
      parent_id: body?.parent_id as string | undefined,
    });
  }

  @Get('notes/:id')
  detail(@Req() req: Request, @Param('id') id: string) {
    const user = (req as Request & { user: SessionUser }).user;
    this.assert(user, 'getnote:read');
    return this.svc.detail(user, id);
  }

  @Put('notes/:id')
  update(@Req() req: Request, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    const user = (req as Request & { user: SessionUser }).user;
    this.assert(user, 'getnote:write');
    return this.svc.update(user, {
      note_id: id,
      title: body?.title as string | undefined,
      content: body?.content as string | undefined,
      tags: Array.isArray(body?.tags) ? (body.tags as string[]) : undefined,
    });
  }

  /** 删除 = 移入回收站。前端必须先让用户二次确认笔记标题。 */
  @Delete('notes/:id')
  remove(@Req() req: Request, @Param('id') id: string) {
    const user = (req as Request & { user: SessionUser }).user;
    this.assert(user, 'getnote:write');
    return this.svc.remove(user, id);
  }

  /** ⚠️ 必须声明在 @Post('notes/:id/tags') 之前 —— 否则 'link' 会被当成 :id */
  @Post('notes/link')
  createAndLink(@Req() req: Request, @Body() body: Record<string, unknown>) {
    const user = (req as Request & { user: SessionUser }).user;
    this.assert(user, 'getnote:write');
    const entityType = String(body?.entityType ?? '');
    const entityId = String(body?.entityId ?? '');
    if (!entityType || !entityId)
      throw new HttpException('BAD_REQUEST:entityType/entityId required', HttpStatus.BAD_REQUEST);
    return this.svc.createAndLink(user, {
      title: body?.title as string | undefined,
      content: body?.content as string | undefined,
      tags: Array.isArray(body?.tags) ? (body.tags as string[]) : undefined,
      entityType,
      entityId,
      entityName: String(body?.entityName ?? ''),
    });
  }

  @Post('notes/:id/tags')
  addTags(@Req() req: Request, @Param('id') id: string, @Body() body: { tags?: string[] }) {
    const user = (req as Request & { user: SessionUser }).user;
    this.assert(user, 'getnote:write');
    const tags = Array.isArray(body?.tags) ? body.tags.filter((t) => String(t).trim()) : [];
    if (!tags.length) throw new HttpException('BAD_REQUEST:tags required', HttpStatus.BAD_REQUEST);
    return this.svc.addTags(user, id, tags);
  }

  /** ⚠️ 删的是 tag_id 不是标签名；system 类型标签删不掉。 */
  @Delete('notes/:id/tags/:tagId')
  removeTag(@Req() req: Request, @Param('id') id: string, @Param('tagId') tagId: string) {
    const user = (req as Request & { user: SessionUser }).user;
    this.assert(user, 'getnote:write');
    return this.svc.removeTag(user, id, tagId);
  }
}
