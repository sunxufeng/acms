import { Inject, Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import type { SessionUser } from '@acms/contracts';
import { authorize, type Principal } from '@acms/domain';
import { BaseClient } from '@acms/base-adapter';
import { TABLES } from '@acms/contracts';
import { BASE_CLIENT } from '../base.provider.js';
import { buildWriteFields, toFlatRecord, buildFilter } from '../shared/record.util.js';
import { CreateAttendanceDto, UpdateAttendanceDto, AttendanceFilterDto, TransitionDto, ATTENDANCE_TRANSITIONS } from './attendance.dto.js';

const TABLE = TABLES.teacherAttendance.tableId;
const READONLY = new Set<string>(['创建时间', '更新时间']);
const NUMBERS = new Set(['计划课时', '实到人数']);

function toPrincipal(user: SessionUser): Principal {
  return { roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel };
}

@Injectable()
export class AttendanceService {
  constructor(@Inject(BASE_CLIENT) private readonly base: BaseClient) {}

  async list(user: SessionUser, query: AttendanceFilterDto) {
    if (!authorize(toPrincipal(user), 'attendance:read').allowed) throw new ForbiddenException('FORBIDDEN:attendance:read');
    const conditions: { field: string; op?: string; value: string[] }[] = [];
    if (query.q) conditions.push({ field: '教学班文本', op: 'contains', value: [query.q] });
    if (query.出勤状态) conditions.push({ field: '出勤状态', value: [query.出勤状态] });
    if (query.时段) conditions.push({ field: '时段', value: [query.时段] });
    if (query.授课教师文本) conditions.push({ field: '授课教师文本', op: 'contains', value: [query.授课教师文本] });
    if (query.校区) conditions.push({ field: '校区', value: [query.校区] });
    const sort = query.sortBy
      ? [{ field: query.sortBy, desc: query.sortOrder !== 'asc' }]
      : [{ field: '出勤日期', desc: true }];
    const res = await this.base.search(TABLE, { pageSize: Number((query as any).pageSize) || 50, pageToken: query.pageToken, filter: buildFilter(conditions), sort });
    return { items: res.items.map((r) => toFlatRecord(r, READONLY, new Set())), total: res.total, hasMore: res.hasMore, pageToken: res.pageToken };
  }

  async detail(user: SessionUser, id: string) {
    if (!authorize(toPrincipal(user), 'attendance:read').allowed) throw new ForbiddenException('FORBIDDEN:attendance:read');
    const rec = await this.base.get(TABLE, id);
    if (!rec) throw new NotFoundException('NOT_FOUND');
    return toFlatRecord(rec, READONLY, new Set());
  }

  async create(user: SessionUser, dto: CreateAttendanceDto) {
    if (!authorize(toPrincipal(user), 'attendance:write').allowed) throw new ForbiddenException('FORBIDDEN:attendance:write');
    if (!dto.授课教师文本?.trim() && !dto.教学班文本?.trim()) throw new BadRequestException('VALIDATION:授课教师或教学班必填');
    const fields = buildWriteFields(dto as unknown as Record<string, unknown>, READONLY, NUMBERS);
    if (!fields['出勤状态']) fields['出勤状态'] = '待提交';
    const recordId = await this.base.create(TABLE, fields);
    return this.detail(user, recordId);
  }

  async update(user: SessionUser, id: string, dto: UpdateAttendanceDto) {
    await this.detail(user, id);
    if (!authorize(toPrincipal(user), 'attendance:write').allowed) throw new ForbiddenException('FORBIDDEN:attendance:write');
    const fields = buildWriteFields(dto as unknown as Record<string, unknown>, READONLY, NUMBERS);
    if (Object.keys(fields).length === 0) throw new BadRequestException('VALIDATION:无可更新字段');
    await this.base.update(TABLE, id, fields);
    return this.detail(user, id);
  }

  async archive(user: SessionUser, id: string) {
    if (!authorize(toPrincipal(user), 'attendance:write').allowed) throw new ForbiddenException('FORBIDDEN:attendance:write');
    await this.detail(user, id);
    await this.base.delete(TABLE, id);
    return { ok: true };
  }

  async transition(user: SessionUser, id: string, dto: TransitionDto) {
    const rec = await this.detail(user, id);
    const cur = (rec['出勤状态'] as string) || '待提交';
    const allowed = ATTENDANCE_TRANSITIONS[cur]?.find((t) => t.to === dto.to);
    if (!allowed) throw new BadRequestException('INVALID_TRANSITION:' + cur + '→' + dto.to);
    if (!authorize(toPrincipal(user), allowed.perm as 'attendance:write').allowed)
      throw new ForbiddenException('FORBIDDEN:' + allowed.perm);
    await this.base.update(TABLE, id, { 出勤状态: dto.to });
    return this.detail(user, id);
  }
}
