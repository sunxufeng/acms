import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Req,
  UseGuards,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { Request } from 'express';
import type { SessionUser } from '@acms/contracts';
import { SessionGuard } from '../auth/session.guard.js';
import { AiDocsService } from './ai-docs.service.js';

@Controller('ai-docs')
@UseGuards(SessionGuard)
export class AiDocsController {
  constructor(private readonly svc: AiDocsService) {}

  private user(req: Request): SessionUser {
    return (req as Request & { user: SessionUser }).user;
  }

  private assertOwner(doc: { ownerOpenId: string | null } | null, u: SessionUser): void {
    if (!doc) throw new NotFoundException('文档不存在');
    const isAdmin = u.roles?.includes('系统管理员');
    if (doc.ownerOpenId && doc.ownerOpenId !== u.openId && !isAdmin) {
      throw new ForbiddenException('FORBIDDEN:not-owner');
    }
  }

  /** 创建文档（归属当前用户）：POST /api/v1/ai-docs */
  @Post()
  create(
    @Body() body: { title?: string; content?: string; refTable?: string; refRecord?: string },
    @Req() req: Request,
  ) {
    const u = this.user(req);
    return this.svc.create({
      title: body.title,
      content: body.content,
      ownerOpenId: u.openId,
      refTable: body.refTable,
      refRecord: body.refRecord,
    });
  }

  /** 列表（管理员可见全部，其余仅自己）：GET /api/v1/ai-docs */
  @Get()
  list(@Req() req: Request) {
    const u = this.user(req);
    return this.svc.list(u.openId, u.roles?.includes('系统管理员') ?? false);
  }

  /** 详情：GET /api/v1/ai-docs/:id */
  @Get(':id')
  async get(@Param('id') id: string, @Req() req: Request) {
    const u = this.user(req);
    const doc = await this.svc.get(id);
    this.assertOwner(doc, u);
    return doc;
  }

  /** 更新：PUT /api/v1/ai-docs/:id */
  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() body: { title?: string; content?: string },
    @Req() req: Request,
  ) {
    const u = this.user(req);
    const doc = await this.svc.get(id);
    this.assertOwner(doc, u);
    await this.svc.update(id, body);
    return { ok: true };
  }

  /** 删除：DELETE /api/v1/ai-docs/:id */
  @Delete(':id')
  async remove(@Param('id') id: string, @Req() req: Request) {
    const u = this.user(req);
    const doc = await this.svc.get(id);
    this.assertOwner(doc, u);
    await this.svc.remove(id);
    return { ok: true };
  }
}
