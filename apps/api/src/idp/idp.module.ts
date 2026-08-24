/**
 * IDP 管理模块。
 *  - idp-plans：自定义服务（IdpPlanService 在 create 时校验「同一学生同一学期唯一」），
 *    自定义控制器复用 BaseRecordService 的 list/detail/update/archive/transition。
 *  - idp-communications：用泛型 CRUD 直接注册（子表，不进学生 360 聚合）。
 */
import {
  Controller, Get, Post, Put, Delete, Param, Query, Body, Req, UseGuards,
  Inject, Injectable, Module,
} from '@nestjs/common';
import type { Request } from 'express';
import { BadRequestException } from '@nestjs/common';
import type { SessionUser } from '@acms/contracts';
import { BaseClient } from '@acms/base-adapter';
import { BASE_CLIENT, baseClientProvider } from '../base.provider.js';
import { AuditService } from '../audit/audit.service.js';
import { SessionGuard } from '../auth/session.guard.js';
import { BaseRecordService, GenericCrudModule } from '../shared/generic-crud.module.js';
import { IDP_PLAN_META, IDP_COMM_META } from './idp.meta.js';

@Injectable()
export class IdpPlanService extends BaseRecordService {
  private readonly client: BaseClient;
  constructor(
    @Inject(BASE_CLIENT) base: BaseClient,
    @Inject(AuditService) audit: AuditService,
  ) {
    super(IDP_PLAN_META, base, audit);
    this.client = base;
  }

  /** 约束 1：一个学生同一学期只能有一个 IDP 方案 */
  async create(user: SessionUser, dto: Record<string, unknown>) {
    const student = String(dto['关联学生'] ?? '').trim();
    const semester = String(dto['学期'] ?? '').trim();
    if (student && semester) {
      const res = await this.client.search(IDP_PLAN_META.tableId, {
        pageSize: 1,
        filter: {
          conjunction: 'and',
          conditions: [
            { field: '关联学生', op: 'is', value: [student] },
            { field: '学期', op: 'is', value: [semester] },
          ],
        },
      });
      if (res.items.length > 0) {
        throw new BadRequestException('DUPLICATE_IDP: 该学生该学期已存在 IDP 方案，不能重复创建');
      }
    }
    return super.create(user, dto);
  }
}

@Controller('idp-plans')
@UseGuards(SessionGuard)
class IdpPlanController {
  constructor(private readonly svc: IdpPlanService) {}
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

@Module({
  imports: [GenericCrudModule.registerAll([IDP_COMM_META])],
  controllers: [IdpPlanController],
  providers: [IdpPlanService, baseClientProvider],
})
export class IdpModule {}
