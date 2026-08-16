import { Controller, Get, Post, Param, UseGuards, HttpCode } from '@nestjs/common';
import { SessionGuard } from '../auth/session.guard.js';
import { DictService } from './dict.service.js';

@Controller('dictionaries')
@UseGuards(SessionGuard)
export class DictController {
  constructor(private readonly svc: DictService) {}

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

  /** 触发把字典候选项合并进飞书 Base 字段：POST /api/v1/dictionaries/sync */
  @Post('sync')
  @HttpCode(200)
  sync() {
    return this.svc.syncToBase();
  }
}
