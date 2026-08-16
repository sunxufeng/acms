import { Inject, Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import type { SessionUser } from '@acms/contracts';
import { authorize, type Principal } from '@acms/domain';
import { BaseClient } from '@acms/base-adapter';
import { TABLES } from '@acms/contracts';
import { BASE_CLIENT } from '../base.provider.js';
import { buildWriteFields, toFlatRecord, buildFilter } from '../shared/record.util.js';
import {
  CreateTeachingClassDto,
  UpdateTeachingClassDto,
  TeachingClassFilterDto,
  TEACHING_CLASS_TRANSITIONS,
} from './teaching.dto.js';

const TABLE = TABLES.teachingClass.tableId;
const READONLY = new Set([
  '教学班编号', '关联课程方案', '学年', '行政班级', '主讲教师', '助教', '学生名单', '课次安排', '负责人', '创建时间', '更新时间',
]);
const MULTI = new Set<string>([]);
const NUMBERS = new Set(['班额上限', '计划课次', '计划总课时']);

function toPrincipal(user: SessionUser): Principal {
  return { roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel };
}

@Injectable()
export class TeachingClassService {
  constructor(@Inject(BASE_CLIENT) private readonly base: BaseClient) {}

  async list(user: SessionUser, query: TeachingClassFilterDto) {
    const principal = toPrincipal(user);
    if (!authorize(principal, 'course:read').allowed) throw new ForbiddenException('FORBIDDEN:course:read');
    const conditions: { field: string; op?: string; value: string[] }[] = [];
    if (query.q) conditions.push({ field: '教学班名称', op: 'contains', value: [query.q] });
    if (query.教学班类型) conditions.push({ field: '教学班类型', value: [query.教学班类型] });
    if (query.教学状态) conditions.push({ field: '教学状态', value: [query.教学状态] });
    if (query.排课状态) conditions.push({ field: '排课状态', value: [query.排课状态] });
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

  async create(user: SessionUser, dto: CreateTeachingClassDto) {
    const principal = toPrincipal(user);
    if (!authorize(principal, 'course:write').allowed) throw new ForbiddenException('FORBIDDEN:course:write');
    if (!dto.教学班名称?.trim()) throw new BadRequestException('VALIDATION:教学班名称必填');
    const fields = buildWriteFields(dto as unknown as Record<string, unknown>, READONLY, NUMBERS);
    if (!fields['教学状态']) fields['教学状态'] = '筹备';
    if (!fields['排课状态']) fields['排课状态'] = '待排课';
    const recordId = await this.base.create(TABLE, fields);
    return this.detail(user, recordId);
  }

  async update(user: SessionUser, id: string, dto: UpdateTeachingClassDto) {
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

  /** 状态机转移：教学班 筹备→进行中→已结课/取消 */
  async transition(user: SessionUser, id: string, to: string) {
    const principal = toPrincipal(user);
    if (!authorize(principal, 'course:write').allowed) throw new ForbiddenException('FORBIDDEN:course:write');
    const cur = (await this.detail(user, id)) as Record<string, unknown>;
    const from = (cur['教学状态'] as string) ?? '筹备';
    const allowed = TEACHING_CLASS_TRANSITIONS[from] ?? [];
    if (!allowed.includes(to)) {
      throw new BadRequestException(`BUSINESS_RULE_VIOLATION:不可从「${from}」直接转移到「${to}」`);
    }
    await this.base.update(TABLE, id, { 教学状态: to });
    return this.detail(user, id);
  }
}
