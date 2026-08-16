import { Inject, Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import type { SessionUser } from '@acms/contracts';
import { authorize, type Principal } from '@acms/domain';
import { BaseClient } from '@acms/base-adapter';
import { TABLES } from '@acms/contracts';
import { BASE_CLIENT } from '../base.provider.js';
import { buildWriteFields, toFlatRecord, buildFilter } from '../shared/record.util.js';
import { CreatePartnershipDto, UpdatePartnershipDto, PartnershipFilterDto } from './partnership.dto.js';

const TABLE = TABLES.partnership.tableId;
const READONLY = new Set<string>(['创建时间', '更新时间']);
const NUMBERS = new Set(['费率']);

function toPrincipal(user: SessionUser): Principal {
  return { roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel };
}

@Injectable()
export class PartnershipService {
  constructor(@Inject(BASE_CLIENT) private readonly base: BaseClient) {}

  async list(user: SessionUser, query: PartnershipFilterDto) {
    if (!authorize(toPrincipal(user), 'partnership:read').allowed) throw new ForbiddenException('FORBIDDEN:partnership:read');
    const conditions: { field: string; op?: string; value: string[] }[] = [];
    if (query.q) conditions.push({ field: '教师文本', op: 'contains', value: [query.q] });
    if (query.计费方式) conditions.push({ field: '计费方式', value: [query.计费方式] });
    if (query.合作状态) conditions.push({ field: '合作状态', value: [query.合作状态] });
    if (query.教师文本) conditions.push({ field: '教师文本', op: 'contains', value: [query.教师文本] });
    const sort = query.sortBy
      ? [{ field: query.sortBy, desc: query.sortOrder !== 'asc' }]
      : [{ field: '生效开始', desc: true }];
    const res = await this.base.search(TABLE, { pageSize: 50, pageToken: query.pageToken, filter: buildFilter(conditions), sort });
    return { items: res.items.map((r) => toFlatRecord(r, READONLY, new Set())), total: res.total, hasMore: res.hasMore, pageToken: res.pageToken };
  }

  async detail(user: SessionUser, id: string) {
    if (!authorize(toPrincipal(user), 'partnership:read').allowed) throw new ForbiddenException('FORBIDDEN:partnership:read');
    const rec = await this.base.get(TABLE, id);
    if (!rec) throw new NotFoundException('NOT_FOUND');
    return toFlatRecord(rec, READONLY, new Set());
  }

  async create(user: SessionUser, dto: CreatePartnershipDto) {
    if (!authorize(toPrincipal(user), 'partnership:write').allowed) throw new ForbiddenException('FORBIDDEN:partnership:write');
    if (!dto.教师文本?.trim()) throw new BadRequestException('VALIDATION:教师必填');
    const fields = buildWriteFields(dto as unknown as Record<string, unknown>, READONLY, NUMBERS);
    if (!fields['合作状态']) fields['合作状态'] = '生效中';
    const recordId = await this.base.create(TABLE, fields);
    return this.detail(user, recordId);
  }

  async update(user: SessionUser, id: string, dto: UpdatePartnershipDto) {
    await this.detail(user, id);
    if (!authorize(toPrincipal(user), 'partnership:write').allowed) throw new ForbiddenException('FORBIDDEN:partnership:write');
    const fields = buildWriteFields(dto as unknown as Record<string, unknown>, READONLY, NUMBERS);
    if (Object.keys(fields).length === 0) throw new BadRequestException('VALIDATION:无可更新字段');
    await this.base.update(TABLE, id, fields);
    return this.detail(user, id);
  }

  async archive(user: SessionUser, id: string) {
    if (!authorize(toPrincipal(user), 'partnership:write').allowed) throw new ForbiddenException('FORBIDDEN:partnership:write');
    await this.detail(user, id);
    await this.base.delete(TABLE, id);
    return { ok: true };
  }
}
