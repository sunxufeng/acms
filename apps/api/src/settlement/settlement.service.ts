import { Inject, Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import type { SessionUser } from '@acms/contracts';
import { authorize, type Principal } from '@acms/domain';
import { BaseClient } from '@acms/base-adapter';
import { TABLES } from '@acms/contracts';
import { BASE_CLIENT } from '../base.provider.js';
import { buildWriteFields, toFlatRecord, buildFilter } from '../shared/record.util.js';
import { CreateSettlementDto, UpdateSettlementDto, SettlementFilterDto, TransitionDto, AggregateSettlementDto, SETTLEMENT_TRANSITIONS } from './settlement.dto.js';

const TABLE = TABLES.monthlySettlement.tableId;
const BILL_TABLE = TABLES.billingDetail.tableId;
const READONLY = new Set<string>(['创建时间', '更新时间']);
const NUMBERS = new Set(['明细数量', '总金额']);
const AMOUNT_FIELDS = new Set(['明细数量', '总金额']);

function toPrincipal(user: SessionUser): Principal {
  return { roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel };
}

@Injectable()
export class SettlementService {
  constructor(@Inject(BASE_CLIENT) private readonly base: BaseClient) {}

  async list(user: SessionUser, query: SettlementFilterDto) {
    if (!authorize(toPrincipal(user), 'billing:read').allowed) throw new ForbiddenException('FORBIDDEN:billing:read');
    const conditions: { field: string; op?: string; value: string[] }[] = [];
    if (query.q) conditions.push({ field: '结算主体', op: 'contains', value: [query.q] });
    if (query.结算状态) conditions.push({ field: '结算状态', value: [query.结算状态] });
    if (query.结算周期) conditions.push({ field: '结算周期', value: [query.结算周期] });
    const sort = query.sortBy
      ? [{ field: query.sortBy, desc: query.sortOrder !== 'asc' }]
      : [{ field: '结算周期', desc: true }];
    const res = await this.base.search(TABLE, { pageSize: 50, pageToken: query.pageToken, filter: buildFilter(conditions), sort });
    return { items: res.items.map((r) => toFlatRecord(r, READONLY, new Set())), total: res.total, hasMore: res.hasMore, pageToken: res.pageToken };
  }

  async detail(user: SessionUser, id: string) {
    if (!authorize(toPrincipal(user), 'billing:read').allowed) throw new ForbiddenException('FORBIDDEN:billing:read');
    const rec = await this.base.get(TABLE, id);
    if (!rec) throw new NotFoundException('NOT_FOUND');
    return toFlatRecord(rec, READONLY, new Set());
  }

  async create(user: SessionUser, dto: CreateSettlementDto) {
    if (!authorize(toPrincipal(user), 'billing:settle').allowed) throw new ForbiddenException('FORBIDDEN:billing:settle');
    const fields = buildWriteFields(dto as unknown as Record<string, unknown>, READONLY, NUMBERS);
    if (!fields['结算状态']) fields['结算状态'] = '草拟';
    const recordId = await this.base.create(TABLE, fields);
    return this.detail(user, recordId);
  }

  /** 按周期聚合已确认计费明细，生成结算草稿（真实数据聚合） */
  async aggregate(user: SessionUser, dto: AggregateSettlementDto) {
    if (!authorize(toPrincipal(user), 'billing:settle').allowed) throw new ForbiddenException('FORBIDDEN:billing:settle');
    if (!dto.结算周期?.trim()) throw new BadRequestException('VALIDATION:结算周期必填');
    const res = await this.base.search(BILL_TABLE, {
      pageSize: 100,
      filter: buildFilter([
        { field: '计费周期', value: [dto.结算周期] },
        { field: '计费状态', value: ['已确认'] },
      ]),
    });
    const count = res.items.length;
    const total = res.items.reduce((s, r) => s + (Number((r.fields as Record<string, unknown>)['金额'] ?? 0) || 0), 0);
    const fields: Record<string, unknown> = {
      结算周期: dto.结算周期,
      结算主体: dto.结算主体 ?? '',
      明细数量: count,
      总金额: Math.round(total * 100) / 100,
      结算状态: '草拟',
    };
    const recordId = await this.base.create(TABLE, fields);
    return this.detail(user, recordId);
  }

  async update(user: SessionUser, id: string, dto: UpdateSettlementDto) {
    const rec = await this.detail(user, id);
    if (!authorize(toPrincipal(user), 'billing:settle').allowed) throw new ForbiddenException('FORBIDDEN:billing:settle');
    const cur = (rec['结算状态'] as string) || '草拟';
    if (cur === '已关闭') throw new BadRequestException('BUSINESS_RULE:已关闭结算不可修改金额');
    const fields = buildWriteFields(dto as unknown as Record<string, unknown>, READONLY, NUMBERS);
    if (cur !== '草拟' && Object.keys(fields).some((k) => AMOUNT_FIELDS.has(k)))
      throw new BadRequestException('BUSINESS_RULE:非草拟状态不可修改金额');
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
    const cur = (rec['结算状态'] as string) || '草拟';
    const allowed = SETTLEMENT_TRANSITIONS[cur]?.find((t) => t.to === dto.to);
    if (!allowed) throw new BadRequestException('INVALID_TRANSITION:' + cur + '→' + dto.to);
    if (!authorize(toPrincipal(user), allowed.perm as 'billing:settle').allowed)
      throw new ForbiddenException('FORBIDDEN:' + allowed.perm);
    const fields: Record<string, unknown> = { 结算状态: dto.to };
    if (dto.to === '已批准' || dto.to === '已关闭') fields['审批人'] = (rec['审批人'] as string) || user.name || user.openId;
    await this.base.update(TABLE, id, fields);
    return this.detail(user, id);
  }
}
