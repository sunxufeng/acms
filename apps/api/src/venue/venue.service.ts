import { Inject, Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import type { SessionUser } from '@acms/contracts';
import { authorize, type Principal } from '@acms/domain';
import { BaseClient } from '@acms/base-adapter';
import { TABLES } from '@acms/contracts';
import { BASE_CLIENT } from '../base.provider.js';
import { buildWriteFields, toFlatRecord, buildFilter } from '../shared/record.util.js';
import { CreateVenueDto, UpdateVenueDto, VenueFilterDto } from './venue.dto.js';

const TABLE = TABLES.venue.tableId;
const READONLY = new Set(['场地编号', '位置', '资源负责人', '关联课次', '创建时间', '更新时间']);
const MULTI = new Set<string>([]);
const NUMBERS = new Set(['容纳人数']);

function toPrincipal(user: SessionUser): Principal {
  return { roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel };
}

@Injectable()
export class VenueService {
  constructor(@Inject(BASE_CLIENT) private readonly base: BaseClient) {}

  async list(user: SessionUser, query: VenueFilterDto) {
    const principal = toPrincipal(user);
    if (!authorize(principal, 'venue:read').allowed) throw new ForbiddenException('FORBIDDEN:venue:read');
    const conditions: { field: string; op?: string; value: string[] }[] = [];
    if (query.q) conditions.push({ field: '场地名称', op: 'contains', value: [query.q] });
    if (query.场地类型) conditions.push({ field: '场地类型', value: [query.场地类型] });
    if (query.可用状态) conditions.push({ field: '可用状态', value: [query.可用状态] });
    const sort = query.sortBy
      ? [{ field: query.sortBy, desc: query.sortOrder !== 'asc' }]
      : [{ field: '更新时间', desc: true }];
    const res = await this.base.search(TABLE, { pageSize: Number((query as any).pageSize) || 50, pageToken: query.pageToken, filter: buildFilter(conditions), sort });
    return { items: res.items.map((r) => toFlatRecord(r, READONLY, MULTI)), total: res.total, hasMore: res.hasMore, pageToken: res.pageToken };
  }

  async detail(user: SessionUser, id: string) {
    if (!authorize(toPrincipal(user), 'venue:read').allowed) throw new ForbiddenException('FORBIDDEN:venue:read');
    const rec = await this.base.get(TABLE, id);
    if (!rec) throw new NotFoundException('NOT_FOUND');
    return toFlatRecord(rec, READONLY, MULTI);
  }

  async create(user: SessionUser, dto: CreateVenueDto) {
    const principal = toPrincipal(user);
    if (!authorize(principal, 'venue:write').allowed) throw new ForbiddenException('FORBIDDEN:venue:write');
    if (!dto.场地名称?.trim()) throw new BadRequestException('VALIDATION:场地名称必填');
    const fields = buildWriteFields(dto as unknown as Record<string, unknown>, READONLY, NUMBERS);
    if (!fields['可用状态']) fields['可用状态'] = '可用';
    const recordId = await this.base.create(TABLE, fields);
    return this.detail(user, recordId);
  }

  async update(user: SessionUser, id: string, dto: UpdateVenueDto) {
    const principal = toPrincipal(user);
    await this.detail(user, id);
    if (!authorize(principal, 'venue:write').allowed) throw new ForbiddenException('FORBIDDEN:venue:write');
    const fields = buildWriteFields(dto as unknown as Record<string, unknown>, READONLY, NUMBERS);
    if (Object.keys(fields).length === 0) throw new BadRequestException('VALIDATION:无可更新字段');
    await this.base.update(TABLE, id, fields);
    return this.detail(user, id);
  }

  async archive(user: SessionUser, id: string) {
    const principal = toPrincipal(user);
    if (!authorize(principal, 'venue:write').allowed) throw new ForbiddenException('FORBIDDEN:venue:write');
    await this.detail(user, id);
    await this.base.delete(TABLE, id);
    return { ok: true };
  }
}
