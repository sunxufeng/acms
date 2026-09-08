import { Inject, Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import type { SessionUser } from '@acms/contracts';
import { BaseClient } from '@acms/base-adapter';
import { TABLES } from '@acms/contracts';
import { BASE_CLIENT } from '../base.provider.js';
import { buildWriteFields, toFlatRecord, buildFilter } from '../shared/record.util.js';
import {
  CreateCoursePlanDto,
  UpdateCoursePlanDto,
  CoursePlanFilterDto,
  COURSE_PLAN_TRANSITIONS,
} from './teaching.dto.js';
import { requireModule } from '../shared/require-module.js';

const TABLE = TABLES.coursePlan.tableId;
const READONLY = new Set([
  '方案编号', '来源课程', '适用学年', '目标学生', '方案负责人', '附件', '创建时间', '更新时间', '教学班',
]);
const MULTI = new Set(['适用年级']);
const NUMBERS = new Set(['标准总课时', '单次标准课时', '建议班额']);

@Injectable()
export class CoursePlanService {
  constructor(@Inject(BASE_CLIENT) private readonly base: BaseClient) {}

  async list(user: SessionUser, query: CoursePlanFilterDto) {
    requireModule(user, 'courses', 'read');
    const conditions: { field: string; op?: string; value: string[] }[] = [];
    if (query.q) conditions.push({ field: '课程方案名称', op: 'contains', value: [query.q] });
    if (query.方案类型) conditions.push({ field: '方案类型', value: [query.方案类型] });
    if (query.方案状态) conditions.push({ field: '方案状态', value: [query.方案状态] });
    if (query.适用学段) conditions.push({ field: '适用学段', value: [query.适用学段] });
    const sort = query.sortBy
      ? [{ field: query.sortBy, desc: query.sortOrder !== 'asc' }]
      : [{ field: '更新时间', desc: true }];
    const res = await this.base.search(TABLE, { pageSize: Number((query as any).pageSize) || 50, pageToken: query.pageToken, filter: buildFilter(conditions), sort });
    return { items: res.items.map((r) => toFlatRecord(r, READONLY, MULTI)), total: res.total, hasMore: res.hasMore, pageToken: res.pageToken };
  }

  async detail(user: SessionUser, id: string) {
    requireModule(user, 'courses', 'read');
    const rec = await this.base.get(TABLE, id);
    if (!rec) throw new NotFoundException('NOT_FOUND');
    return toFlatRecord(rec, READONLY, MULTI);
  }

  async create(user: SessionUser, dto: CreateCoursePlanDto) {
    requireModule(user, 'courses', 'create');
    if (!dto.课程方案名称?.trim()) throw new BadRequestException('VALIDATION:课程方案名称必填');
    const fields = buildWriteFields(dto as unknown as Record<string, unknown>, READONLY, NUMBERS);
    if (!fields['方案状态']) fields['方案状态'] = '草拟';
    if (!fields['版本号']) fields['版本号'] = 'v1';
    const recordId = await this.base.create(TABLE, fields);
    return this.detail(user, recordId);
  }

  async update(user: SessionUser, id: string, dto: UpdateCoursePlanDto) {
    await this.detail(user, id);
    requireModule(user, 'courses', 'update');
    const fields = buildWriteFields(dto as unknown as Record<string, unknown>, READONLY, NUMBERS);
    if (Object.keys(fields).length === 0) throw new BadRequestException('VALIDATION:无可更新字段');
    await this.base.update(TABLE, id, fields);
    return this.detail(user, id);
  }

  async archive(user: SessionUser, id: string) {
    requireModule(user, 'courses', 'delete');
    await this.detail(user, id);
    await this.base.delete(TABLE, id);
    return { ok: true };
  }

  /** 状态机显式转移（BR-006）：仅允许注册转移，否则 422 */
  async transition(user: SessionUser, id: string, to: string) {
    requireModule(user, 'courses', 'transition');
    const cur = (await this.detail(user, id)) as Record<string, unknown>;
    const from = (cur['方案状态'] as string) ?? '草拟';
    const allowed = COURSE_PLAN_TRANSITIONS[from] ?? [];
    if (!allowed.includes(to)) {
      throw new BadRequestException(`BUSINESS_RULE_VIOLATION:不可从「${from}」直接转移到「${to}」`);
    }
    await this.base.update(TABLE, id, { 方案状态: to });
    return this.detail(user, id);
  }
}
