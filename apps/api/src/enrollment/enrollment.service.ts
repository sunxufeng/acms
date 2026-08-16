import { Inject, Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import type { SessionUser } from '@acms/contracts';
import { authorize, type Principal } from '@acms/domain';
import { BaseClient } from '@acms/base-adapter';
import { TABLES } from '@acms/contracts';
import { BASE_CLIENT } from '../base.provider.js';
import { buildWriteFields, toFlatRecord, buildFilter } from '../shared/record.util.js';
import {
  CreateEnrollmentDto,
  UpdateEnrollmentDto,
  EnrollmentFilterDto,
  ENROLLMENT_TRANSITIONS,
} from './enrollment.dto.js';

const TABLE = TABLES.enrollment.tableId;
const READONLY = new Set([
  '修读编号', '关联学生', '关联教学班', '创建时间', '更新时间',
]);
const MULTI = new Set<string>([]);
const NUMBERS = new Set<string>([]);

function toPrincipal(user: SessionUser): Principal {
  return { roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel };
}

@Injectable()
export class EnrollmentService {
  constructor(@Inject(BASE_CLIENT) private readonly base: BaseClient) {}

  async list(user: SessionUser, query: EnrollmentFilterDto) {
    const principal = toPrincipal(user);
    if (!authorize(principal, 'course:read').allowed) throw new ForbiddenException('FORBIDDEN:course:read');
    const conditions: { field: string; op?: string; value: string[] }[] = [];
    if (query.q) conditions.push({ field: '修读关系名称', op: 'contains', value: [query.q] });
    if (query.修读类型) conditions.push({ field: '修读类型', value: [query.修读类型] });
    if (query.修读状态) conditions.push({ field: '修读状态', value: [query.修读状态] });
    if (query.收费状态) conditions.push({ field: '收费状态', value: [query.收费状态] });
    const sort = query.sortBy
      ? [{ field: query.sortBy, desc: query.sortOrder !== 'asc' }]
      : [{ field: '更新时间', desc: true }];
    const res = await this.base.search(TABLE, { pageSize: 50, pageToken: query.pageToken, filter: buildFilter(conditions), sort });
    return { items: res.items.map((r) => toFlatRecord(r, READONLY, MULTI)), total: res.total, hasMore: res.hasMore, pageToken: res.pageToken };
  }

  async detail(user: SessionUser, id: string) {
    if (!authorize(toPrincipal(user), 'course:read').allowed) throw new ForbiddenException('FORBIDDEN:course:read');
    const rec = await this.base.get(TABLE, id);
    if (!rec) throw new NotFoundException('NOT_FOUND');
    return toFlatRecord(rec, READONLY, MULTI);
  }

  async create(user: SessionUser, dto: CreateEnrollmentDto) {
    const principal = toPrincipal(user);
    if (!authorize(principal, 'course:write').allowed) throw new ForbiddenException('FORBIDDEN:course:write');
    if (!dto.修读关系名称?.trim()) throw new BadRequestException('VALIDATION:修读关系名称必填');
    const fields = buildWriteFields(dto as unknown as Record<string, unknown>, READONLY, NUMBERS);
    if (!fields['修读状态']) fields['修读状态'] = '待确认';
    const recordId = await this.base.create(TABLE, fields);
    return this.detail(user, recordId);
  }

  async update(user: SessionUser, id: string, dto: UpdateEnrollmentDto) {
    const principal = toPrincipal(user);
    await this.detail(user, id);
    if (!authorize(principal, 'course:write').allowed) throw new ForbiddenException('FORBIDDEN:course:write');
    const fields = buildWriteFields(dto as unknown as Record<string, unknown>, READONLY, NUMBERS);
    if (Object.keys(fields).length === 0) throw new BadRequestException('VALIDATION:无可更新字段');
    await this.base.update(TABLE, id, fields);
    return this.detail(user, id);
  }

  async archive(user: SessionUser, id: string) {
    const principal = toPrincipal(user);
    if (!authorize(principal, 'course:write').allowed) throw new ForbiddenException('FORBIDDEN:course:write');
    await this.detail(user, id);
    await this.base.delete(TABLE, id);
    return { ok: true };
  }

  /** 状态机转移（修读关系生命周期） */
  async transition(user: SessionUser, id: string, to: string) {
    const principal = toPrincipal(user);
    if (!authorize(principal, 'course:write').allowed) throw new ForbiddenException('FORBIDDEN:course:write');
    const cur = (await this.detail(user, id)) as Record<string, unknown>;
    const from = (cur['修读状态'] as string) ?? '待确认';
    const allowed = ENROLLMENT_TRANSITIONS[from] ?? [];
    if (!allowed.includes(to)) {
      throw new BadRequestException(`BUSINESS_RULE_VIOLATION:不可从「${from}」直接转移到「${to}」`);
    }
    await this.base.update(TABLE, id, { 修读状态: to });
    return this.detail(user, id);
  }
}
