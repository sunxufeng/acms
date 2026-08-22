import { Inject, Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import type { SessionUser } from '@acms/contracts';
import { authorize, type Principal } from '@acms/domain';
import { BaseClient, type FilterCondition, type FilterGroup } from '@acms/base-adapter';
import { TABLES } from '@acms/contracts';
import { BASE_CLIENT } from '../base.provider.js';
import { buildWriteFields, toFlatRecord, buildFilter } from '../shared/record.util.js';
import { CreateAdjustmentDto, UpdateAdjustmentDto, AdjustmentFilterDto, TransitionDto, ADJUSTMENT_TRANSITIONS } from './adjustment.dto.js';

const TABLE = TABLES.adjustment.tableId;
const READONLY = new Set<string>(['创建时间', '更新时间', '发起人']);
const NUMBERS = new Set(['金额']);

function toPrincipal(user: SessionUser): Principal {
  return { roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel };
}

@Injectable()
export class AdjustmentService {
  constructor(@Inject(BASE_CLIENT) private readonly base: BaseClient) {}

  async list(user: SessionUser, query: AdjustmentFilterDto) {
    if (!authorize(toPrincipal(user), 'finance:read').allowed) throw new ForbiddenException('FORBIDDEN:finance:read');
    const conditions: (FilterCondition | FilterGroup)[] = [];
    if (query.q) {
      const q = query.q;
      conditions.push({
        conjunction: 'or',
        conditions: [
          { field: '关联结算文本', op: 'contains', value: [q] },
          { field: '关联计费文本', op: 'contains', value: [q] },
        ],
      });
    }
    if (query.关联结算文本) conditions.push({ field: '关联结算文本', op: 'contains', value: [query.关联结算文本] });
    if (query.方向) conditions.push({ field: '方向', value: [query.方向] });
    if (query.状态) conditions.push({ field: '状态', value: [query.状态] });
    const sort = [{ field: '更新时间', desc: query.sortOrder !== 'asc' }];
    const res = await this.base.search(TABLE, { pageSize: Number((query as any).pageSize) || 50, pageToken: query.pageToken, filter: buildFilter(conditions), sort });
    return { items: res.items.map((r) => toFlatRecord(r, READONLY, new Set())), total: res.total, hasMore: res.hasMore, pageToken: res.pageToken };
  }

  async detail(user: SessionUser, id: string) {
    if (!authorize(toPrincipal(user), 'finance:read').allowed) throw new ForbiddenException('FORBIDDEN:finance:read');
    const rec = await this.base.get(TABLE, id);
    if (!rec) throw new NotFoundException('NOT_FOUND');
    return toFlatRecord(rec, READONLY, new Set());
  }

  async create(user: SessionUser, dto: CreateAdjustmentDto) {
    if (!authorize(toPrincipal(user), 'billing:settle').allowed) throw new ForbiddenException('FORBIDDEN:billing:settle');
    if (!dto.关联结算文本?.trim() && !dto.关联计费文本?.trim()) throw new BadRequestException('VALIDATION:需关联结算或计费明细');
    if (!dto.方向 || !['调整', '冲销'].includes(dto.方向)) throw new BadRequestException('VALIDATION:方向须为调整或冲销');
    const fields = buildWriteFields(dto as unknown as Record<string, unknown>, READONLY, NUMBERS);
    fields['发起人'] = user.openId;
    fields['状态'] = '待审核';
    const recordId = await this.base.create(TABLE, fields);
    return this.detail(user, recordId);
  }

  async update(user: SessionUser, id: string, dto: UpdateAdjustmentDto) {
    await this.detail(user, id);
    if (!authorize(toPrincipal(user), 'billing:settle').allowed) throw new ForbiddenException('FORBIDDEN:billing:settle');
    const fields = buildWriteFields(dto as unknown as Record<string, unknown>, READONLY, NUMBERS);
    if (Object.keys(fields).length === 0) throw new BadRequestException('VALIDATION:无可更新字段');
    await this.base.update(TABLE, id, fields);
    return this.detail(user, id);
  }

  async archive(user: SessionUser, id: string) {
    if (!authorize(toPrincipal(user), 'billing:settle').allowed) throw new ForbiddenException('FORBIDDEN:billing:settle');
    await this.detail(user, id);
    await this.base.delete(TABLE, id);
    return { ok: true };
  }

  async transition(user: SessionUser, id: string, dto: TransitionDto) {
    const rec = await this.detail(user, id);
    const cur = (rec['状态'] as string) || '待审核';
    const allowed = ADJUSTMENT_TRANSITIONS[cur]?.find((t) => t.to === dto.to);
    if (!allowed) throw new BadRequestException('INVALID_TRANSITION:' + cur + '→' + dto.to);
    if (!authorize(toPrincipal(user), allowed.perm as 'finance:approve').allowed)
      throw new ForbiddenException('FORBIDDEN:' + allowed.perm);
    // SoD：审核人不得为发起人（BR-009 不相容职责分离）
    if ((rec['发起人'] as string) === user.openId)
      throw new ForbiddenException('SOD_VIOLATION:审核人不得为发起人');
    await this.base.update(TABLE, id, { 状态: dto.to, 审核人: user.openId });
    return this.detail(user, id);
  }
}
