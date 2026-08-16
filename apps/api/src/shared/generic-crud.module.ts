/**
 * 通用记录 CRUD 模块（M1 学生生命周期域：生源跟进 / 学生考勤 / 学业成绩 / 实践活动 /
 * 家校沟通 / 阶段评价 / 校友跟进）。这些表结构高度同质，统一用一份泛型服务 + 动态
 * 控制器承载，避免 7×4 重复文件。每种表通过 RecordMeta 描述字段约束。
 */
import {
  Controller, Get, Post, Put, Delete, Param, Query, Body, Req, UseGuards,
  Inject, Injectable, Module, type DynamicModule, type Type,
} from '@nestjs/common';
import type { Request } from 'express';
import { ForbiddenException, NotFoundException, BadRequestException } from '@nestjs/common';
import type { SessionUser } from '@acms/contracts';
import { authorize, type Principal } from '@acms/domain';
import { BaseClient } from '@acms/base-adapter';
import { BASE_CLIENT, baseClientProvider } from '../base.provider.js';
import { SessionGuard } from '../auth/session.guard.js';
import { buildWriteFields, toFlatRecord, buildFilter } from './record.util.js';

export interface RecordMeta {
  /** 路由前缀，如 'source-followups' */
  path: string;
  /** TABLES 中的键或真实 tableId */
  tableId: string;
  readPerm: string;
  writePerm: string;
  /** 只读字段（含自增编号、附件等不写字段） */
  readonly?: string[];
  /** 数值字段 */
  numbers?: string[];
  /** 多值字段 */
  multi?: string[];
  /** 状态字段（展示 + 可编辑） */
  statusField?: string;
  defaultStatus?: string;
  /** q 关键字检索字段 */
  searchField?: string;
  /** 日期字段（写时字符串→毫秒时间戳） */
  dateFields?: string[];
  /** 列表默认排序字段 */
  sortField?: string;
}

function toPrincipal(user: SessionUser): Principal {
  return { roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel };
}

export class BaseRecordService {
  constructor(protected readonly meta: RecordMeta, @Inject(BASE_CLIENT) private readonly base: BaseClient) {}

  private get tableId() {
    return this.meta.tableId;
  }

  private readonlySet() {
    return new Set(this.meta.readonly ?? []);
  }
  private numberSet() {
    return new Set(this.meta.numbers ?? []);
  }
  private multiSet() {
    return new Set(this.meta.multi ?? []);
  }

  async list(user: SessionUser, query: Record<string, string | undefined>) {
    if (!authorize(toPrincipal(user), this.meta.readPerm as Parameters<typeof authorize>[1]).allowed)
      throw new ForbiddenException('FORBIDDEN:' + this.meta.readPerm);
    const conditions: { field: string; op?: string; value: string[] }[] = [];
    for (const [k, v] of Object.entries(query)) {
      if (['pageToken', 'sortBy', 'sortOrder', 'q'].includes(k)) continue;
      if (v) conditions.push({ field: k, value: [v] });
    }
    if (query.q && this.meta.searchField) {
      conditions.push({ field: this.meta.searchField, op: 'contains', value: [query.q] });
    }
    const sort = query.sortBy
      ? [{ field: query.sortBy, desc: query.sortOrder !== 'asc' }]
      : [{ field: this.meta.sortField ?? '更新时间', desc: true }];
    const res = await this.base.search(this.tableId, {
      pageSize: 50,
      pageToken: query.pageToken,
      filter: buildFilter(conditions),
      sort,
    });
    return {
      items: res.items.map((r) => toFlatRecord(r, this.readonlySet(), this.multiSet())),
      total: res.total,
      hasMore: res.hasMore,
      pageToken: res.pageToken,
    };
  }

  async detail(user: SessionUser, id: string) {
    if (!authorize(toPrincipal(user), this.meta.readPerm as Parameters<typeof authorize>[1]).allowed)
      throw new ForbiddenException('FORBIDDEN:' + this.meta.readPerm);
    const rec = await this.base.get(this.tableId, id);
    if (!rec) throw new NotFoundException('NOT_FOUND');
    return toFlatRecord(rec, this.readonlySet(), this.multiSet());
  }

  private writeFields(dto: Record<string, unknown>) {
    const fields = buildWriteFields(dto, this.readonlySet(), this.numberSet());
    for (const k of this.meta.dateFields ?? []) {
      const v = fields[k];
      if (typeof v === 'string') {
        if (v.trim() === '') delete fields[k];
        else {
          const t = new Date(v.trim()).getTime();
          if (!Number.isNaN(t)) fields[k] = t;
          else delete fields[k];
        }
      }
    }
    return fields;
  }

  async create(user: SessionUser, dto: Record<string, unknown>) {
    if (!authorize(toPrincipal(user), this.meta.writePerm as Parameters<typeof authorize>[1]).allowed)
      throw new ForbiddenException('FORBIDDEN:' + this.meta.writePerm);
    const fields = this.writeFields(dto);
    if (this.meta.statusField && !fields[this.meta.statusField] && this.meta.defaultStatus) {
      fields[this.meta.statusField] = this.meta.defaultStatus;
    }
    const recordId = await this.base.create(this.tableId, fields);
    return this.detail(user, recordId);
  }

  async update(user: SessionUser, id: string, dto: Record<string, unknown>) {
    if (!authorize(toPrincipal(user), this.meta.writePerm as Parameters<typeof authorize>[1]).allowed)
      throw new ForbiddenException('FORBIDDEN:' + this.meta.writePerm);
    await this.detail(user, id);
    const fields = this.writeFields(dto);
    if (Object.keys(fields).length === 0) throw new BadRequestException('VALIDATION:无可更新字段');
    await this.base.update(this.tableId, id, fields);
    return this.detail(user, id);
  }

  async archive(user: SessionUser, id: string) {
    if (!authorize(toPrincipal(user), this.meta.writePerm as Parameters<typeof authorize>[1]).allowed)
      throw new ForbiddenException('FORBIDDEN:' + this.meta.writePerm);
    await this.detail(user, id);
    await this.base.delete(this.tableId, id);
    return { ok: true };
  }

  async transition(user: SessionUser, id: string, to: string) {
    if (!authorize(toPrincipal(user), this.meta.writePerm as Parameters<typeof authorize>[1]).allowed)
      throw new ForbiddenException('FORBIDDEN:' + this.meta.writePerm);
    if (!this.meta.statusField) throw new BadRequestException('NO_STATUS_FIELD');
    await this.detail(user, id);
    await this.base.update(this.tableId, id, { [this.meta.statusField]: to });
    return this.detail(user, id);
  }
}

function makeService(meta: RecordMeta): Type<BaseRecordService> {
  @Injectable()
  class GService extends BaseRecordService {
    constructor(@Inject(BASE_CLIENT) base: BaseClient) {
      super(meta, base);
    }
  }
  return GService as unknown as Type<BaseRecordService>;
}

function makeController(meta: RecordMeta, SvcClass: Type<BaseRecordService>) {
  @Controller(meta.path)
  @UseGuards(SessionGuard)
  class GController {
    constructor(@Inject(SvcClass) private readonly svc: BaseRecordService) {}
    @Get() list(@Req() req: Request, @Query() q: Record<string, string | undefined>) {
      return this.svc.list((req as Request & { user: SessionUser }).user, q);
    }
    @Get(':id') detail(@Req() req: Request, @Param('id') id: string) {
      return this.svc.detail((req as Request & { user: SessionUser }).user, id);
    }
    @Post() create(@Req() req: Request, @Body() body: Record<string, unknown>) {
      return this.svc.create((req as Request & { user: SessionUser }).user, body);
    }
    @Put(':id') update(@Req() req: Request, @Param('id') id: string, @Body() body: Record<string, unknown>) {
      return this.svc.update((req as Request & { user: SessionUser }).user, id, body);
    }
    @Delete(':id') archive(@Req() req: Request, @Param('id') id: string) {
      return this.svc.archive((req as Request & { user: SessionUser }).user, id);
    }
    @Post(':id/transition') transition(@Req() req: Request, @Param('id') id: string, @Body() body: { to: string }) {
      return this.svc.transition((req as Request & { user: SessionUser }).user, id, body.to);
    }
  }
  return GController;
}

@Module({})
export class GenericCrudModule {
  static registerAll(metas: RecordMeta[]): DynamicModule {
    const controllers: Type[] = [];
    const providers: Type[] = [];
    for (const meta of metas) {
      const SvcClass = makeService(meta);
      controllers.push(makeController(meta, SvcClass));
      providers.push(SvcClass);
    }
    return {
      module: GenericCrudModule,
      controllers,
      providers: [...providers, baseClientProvider],
    };
  }
}
