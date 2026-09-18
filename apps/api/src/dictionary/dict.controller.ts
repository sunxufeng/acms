import {
  Controller,
  Get,
  Put,
  Param,
  Query,
  Body,
  Req,
  UseGuards,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import type { Request } from 'express';
import type { SessionUser } from '@acms/contracts';
import { rankOf, type FieldLevel } from '../shared/field-mask.js';
import type { DictOption } from './dict.data.js';
import { SessionGuard } from '../auth/session.guard.js';
import { DictService } from './dict.service.js';

@Controller('dictionaries')
@UseGuards(SessionGuard)
export class DictController {
  constructor(private readonly svc: DictService) {}

  private user(req: Request): SessionUser {
    return (req as Request & { user: SessionUser }).user;
  }

  /** 全部字典（仅 labels，兼容旧端点，6 个只读前端消费方零改动）：GET /api/v1/dictionaries */
  @Get()
  getAll() {
    return this.svc.getAllLabels();
  }

  /** 字典元数据（完整 DictOption[] + 旧值→当前名 resolve 映射）：GET /api/v1/dictionaries/meta */
  @Get('meta')
  getMeta() {
    return this.svc.getMeta();
  }

  /** 省 → 市级联映射：GET /api/v1/dictionaries/province-cities */
  @Get('province-cities')
  getProvinceCities() {
    return this.svc.getProvinceCities();
  }

  /** 字段密级表（Stage 4b）：GET /api/v1/dictionaries/field-levels */
  @Get('field-levels')
  getFieldLevels() {
    return this.svc.getFieldLevels();
  }

  /** 更新字段密级表（仅系统管理员）：PUT /api/v1/dictionaries/field-levels */
  @Put('field-levels')
  putFieldLevels(
    @Body() body: { levels?: FieldLevel[] },
    @Req() req: Request,
  ) {
    const user = this.user(req);
    if (!user.roles?.includes('系统管理员')) {
      throw new ForbiddenException('FORBIDDEN:admin');
    }
    if (!Array.isArray(body?.levels)) {
      throw new BadRequestException('levels 必须为 FieldLevel 数组');
    }
    return this.svc.setFieldLevels(body.levels);
  }

  /**
   * 字段密级配置目录：可配模块 + 每个模块的**真实字段**（含当前密级）。
   * GET /api/v1/dictionaries/field-levels/catalog
   *
   * ⚠️ 必须声明在 `@Get(':key')` **之前** —— 否则 `:key` 通配会把这条路由吃掉。
   */
  @Get('field-levels/catalog')
  fieldLevelCatalog(@Req() req: Request) {
    const user = this.user(req);
    if (!user.roles?.includes('系统管理员')) {
      throw new ForbiddenException('FORBIDDEN:admin');
    }
    return this.svc.fieldLevelCatalog();
  }

  /**
   * 打码预览：拿一条真实记录按「指定用户密级」跑一遍脱敏，返回前后对照。
   * GET /api/v1/dictionaries/field-levels/preview?module=students&userLevel=L1
   */
  @Get('field-levels/preview')
  fieldLevelPreview(
    @Req() req: Request,
    @Query('module') module?: string,
    @Query('userLevel') userLevel?: string,
  ) {
    const user = this.user(req);
    if (!user.roles?.includes('系统管理员')) {
      throw new ForbiddenException('FORBIDDEN:admin');
    }
    return this.svc.fieldLevelPreview(String(module ?? ''), rankOf(userLevel));
  }

  /** 单个字典（完整 DictOption[]）：GET /api/v1/dictionaries/:key */
  @Get(':key')
  getOne(@Param('key') key: string) {
    return { key, options: this.svc.getOptions(key) ?? [] };
  }

  /** 更新单个字典候选项（完整 DictOption[]，仅系统管理员）：PUT /api/v1/dictionaries/:key */
  @Put(':key')
  update(
    @Param('key') key: string,
    @Body() body: { options?: DictOption[] | string[] },
    @Req() req: Request,
  ) {
    const user = this.user(req);
    if (!user.roles?.includes('系统管理员')) {
      throw new ForbiddenException('FORBIDDEN:admin');
    }
    if (!Array.isArray(body?.options)) {
      throw new BadRequestException('options 必须为 DictOption 数组');
    }
    return this.svc.update(key, body.options);
  }
}
