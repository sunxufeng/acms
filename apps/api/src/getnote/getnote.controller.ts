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
 * ⚠️ 凭证模型（2026-09-05 二次修正）：**Client ID 与 API Key 都是每人一份**。
 * 官方「5 分钟快速上手」写明「创建应用 → 获取 Client ID 和 API Key」，两者是用户建
 * 应用时成对拿到的，所以不存在「应用级全局一份」的强约束。早期版本把 Client ID 塞进
 * .env，结果不配就整页阻塞在「请联系管理员」，用户什么也做不了 —— 已废弃。
 *
 * 每个请求都带当前用户，service 按 openId 取他自己的凭证对。一人一份还顺带解决了
 * 限流问题：官方限流是**按 Key 算**的（QPS 2 / 每天 5000 次），共用必然撞墙。
 *
 * 两条配置路径，互不依赖：
 * - **手动填入** —— 用户自己建应用，两个值都自己填。不依赖任何服务端配置
 * - **一键授权（OAuth 设备授权）** —— 需要 .env 配 GETNOTE_OAUTH_CLIENT_ID，
 *   这是 OAuth 的固有模型（设备授权需要一个应用身份）。没配时前端自动隐藏该入口
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

  /**
   * 保存自己的凭证（Client ID + API Key 都要）。
   * 存之前会先打一次真实请求验活，验不过不落库。
   */
  @Put('credential')
  saveCredential(@Req() req: Request, @Body() body: { apiKey?: string; clientId?: string }) {
    const user = (req as Request & { user: SessionUser }).user;
    this.assert(user, 'getnote:write');
    return this.svc.saveCredential(user, String(body?.apiKey ?? ''), String(body?.clientId ?? ''));
  }

  @Delete('credential')
  clearCredential(@Req() req: Request) {
    const user = (req as Request & { user: SessionUser }).user;
    this.assert(user, 'getnote:write');
    return this.svc.clearCredential(user);
  }

  // ── OAuth 设备授权（可选；未开启时 start 返回 503，前端据此隐藏入口） ──

  /** 第 1 步：换设备码。返回二维码与 user_code，一次性 code 不下发前端。 */
  @Post('oauth/start')
  startOAuth(@Req() req: Request) {
    const user = (req as Request & { user: SessionUser }).user;
    this.assert(user, 'getnote:write');
    return this.svc.startOAuth(user);
  }

  /** 第 2 步：前端按 interval 定时轮询，直到 success / expired / rejected。 */
  @Get('oauth/poll')
  pollOAuth(@Req() req: Request) {
    const user = (req as Request & { user: SessionUser }).user;
    this.assert(user, 'getnote:read');
    return this.svc.pollOAuth(user);
  }

  @Delete('oauth')
  cancelOAuth(@Req() req: Request) {
    const user = (req as Request & { user: SessionUser }).user;
    this.assert(user, 'getnote:write');
    return this.svc.cancelOAuth(user);
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

  /**
   * 笔记列表。
   *
   * ⚠️ 出站必须转成全站统一的 `Page<T>`（`items/total/hasMore/pageToken`）。
   * service 返回的是 Get笔记 原生结构（`notes/has_more/cursor`），直接透出去的话
   * 前端按 `res.items` 取会拿到 undefined，`res.items.map(...)` 当场抛
   * 「Cannot read properties of undefined (reading 'map')」—— 保存凭证后第一次渲染
   * 列表必炸（未连凭证时页面停在引导页，从没走到这一步，所以藏了很久）。
   *
   * 请求侧同理：CrudPage 翻页传的是 `pageToken`，这里映射成上游的 `cursor`。
   *
   * `total` 的估算：上游不保证返回总数，而 CrudPage 用 `total / pageSize` 推算页数，
   * 只给当前页条数会算出「只有 1 页」，用户永远翻不到下一页。所以 has_more 为真时
   * 按「已拿到的 + 一页」估，翻到下一页后 total 又会被刷新成更大的值（渐进式）。
   */
  @Get('notes')
  async list(
    @Req() req: Request,
    @Query('pageToken') pageToken?: string,
    @Query('q') q?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const user = (req as Request & { user: SessionUser }).user;
    this.assert(user, 'getnote:read');
    const r = await this.svc.list(user, pageToken, q);
    const items = r.notes ?? [];
    const hasMore = Boolean(r.has_more);
    const size = Math.min(Math.max(Number(pageSize) || 20, 1), 100);
    return {
      items,
      hasMore,
      pageToken: r.cursor,
      total: r.total ?? (hasMore ? items.length + size : items.length),
    };
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
