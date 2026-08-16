import {
  Controller,
  Get,
  Post,
  Put,
  Param,
  Body,
  Req,
  UseGuards,
  HttpCode,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import type { Request } from 'express';
import type { SessionUser } from '@acms/contracts';
import { SessionGuard } from '../auth/session.guard.js';
import { DictService } from './dict.service.js';

@Controller('dictionaries')
@UseGuards(SessionGuard)
export class DictController {
  constructor(private readonly svc: DictService) {}

  private user(req: Request): SessionUser {
    return (req as Request & { user: SessionUser }).user;
  }

  /** 全部字典：GET /api/v1/dictionaries */
  @Get()
  getAll() {
    return this.svc.getAll();
  }

  /** 单个字典：GET /api/v1/dictionaries/:key */
  @Get(':key')
  getOne(@Param('key') key: string) {
    return { key, options: this.svc.get(key) ?? [] };
  }

  /** 更新单个字典候选项（仅系统管理员）：PUT /api/v1/dictionaries/:key */
  @Put(':key')
  update(
    @Param('key') key: string,
    @Body() body: { options?: string[] },
    @Req() req: Request,
  ) {
    const user = this.user(req);
    if (!user.roles?.includes('系统管理员')) {
      throw new ForbiddenException('FORBIDDEN:admin');
    }
    if (!Array.isArray(body?.options)) {
      throw new BadRequestException('options 必须为字符串数组');
    }
    return this.svc.update(key, body.options);
  }

  /** 触发把字典候选项合并进飞书 Base 字段：POST /api/v1/dictionaries/sync */
  @Post('sync')
  @HttpCode(200)
  sync() {
    return this.svc.syncToBase();
  }
}
