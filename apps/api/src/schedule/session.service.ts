import { Inject, Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import type { SessionUser } from '@acms/contracts';
import { authorize, type Principal } from '@acms/domain';
import { preflightSessionConflicts, type SessionLike, type ConflictResult } from '@acms/domain';
import { BaseClient } from '@acms/base-adapter';
import { TABLES } from '@acms/contracts';
import { BASE_CLIENT } from '../base.provider.js';
import { buildWriteFields, toFlatRecord, buildFilter } from '../shared/record.util.js';
import { CreateSessionDto, UpdateSessionDto, SessionFilterDto, SESSION_TRANSITIONS } from './session.dto.js';

const TABLE = TABLES.session.tableId;
const READONLY = new Set([
  '课次编号', '关联教学班', '关联课程方案', '授课教师', '助教', '排课负责人', '课件与材料',
  '创建时间', '更新时间', '原课次', '教师出勤', '场地资源', '校历校验状态',
  '场地冲突状态', '教师冲突状态', '排课幂等键', '状态规则版本', '确认人', '确认时间',
]);
const MULTI = new Set<string>([]);
const NUMBERS = new Set(['计划课时']);

function toPrincipal(user: SessionUser): Principal {
  return { roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel };
}

@Injectable()
export class SessionService {
  constructor(@Inject(BASE_CLIENT) private readonly base: BaseClient) {}

  private toSessionLike(rec: { recordId: string; fields: Record<string, unknown> }): SessionLike {
    const f = rec.fields;
    return {
      id: rec.recordId,
      课次日期: (f['课次日期'] as string) ?? '',
      开始时间: (f['开始时间'] as string) ?? '',
      结束时间: (f['结束时间'] as string) ?? '',
      教学班文本: (f['教学班文本'] as string) ?? '',
      授课教师文本: (f['授课教师文本'] as string) ?? '',
      场地文本: (f['场地文本'] as string) ?? '',
    };
  }

  async list(user: SessionUser, query: SessionFilterDto) {
    const principal = toPrincipal(user);
    if (!authorize(principal, 'schedule:read').allowed) throw new ForbiddenException('FORBIDDEN:schedule:read');
    const conditions: { field: string; op?: string; value: string[] }[] = [];
    if (query.q) conditions.push({ field: '课次名称', op: 'contains', value: [query.q] });
    if (query.授课方式) conditions.push({ field: '授课方式', value: [query.授课方式] });
    if (query.课次状态) conditions.push({ field: '课次状态', value: [query.课次状态] });
    if (query.教学班文本) conditions.push({ field: '教学班文本', op: 'contains', value: [query.教学班文本] });
    if (query.授课教师文本) conditions.push({ field: '授课教师文本', op: 'contains', value: [query.授课教师文本] });
    if (query.场地文本) conditions.push({ field: '场地文本', op: 'contains', value: [query.场地文本] });
    const sort = query.sortBy
      ? [{ field: query.sortBy, desc: query.sortOrder !== 'asc' }]
      : [{ field: '更新时间', desc: true }];
    const res = await this.base.search(TABLE, { pageSize: Number((query as any).pageSize) || 50, pageToken: query.pageToken, filter: buildFilter(conditions), sort });
    return { items: res.items.map((r) => toFlatRecord(r, READONLY, MULTI)), total: res.total, hasMore: res.hasMore, pageToken: res.pageToken };
  }

  async detail(user: SessionUser, id: string) {
    if (!authorize(toPrincipal(user), 'schedule:read').allowed) throw new ForbiddenException('FORBIDDEN:schedule:read');
    const rec = await this.base.get(TABLE, id);
    if (!rec) throw new NotFoundException('NOT_FOUND');
    return toFlatRecord(rec, READONLY, MULTI);
  }

  async create(user: SessionUser, dto: CreateSessionDto) {
    const principal = toPrincipal(user);
    if (!authorize(principal, 'schedule:write').allowed) throw new ForbiddenException('FORBIDDEN:schedule:write');
    if (!dto.课次名称?.trim()) throw new BadRequestException('VALIDATION:课次名称必填');
    const fields = buildWriteFields(dto as unknown as Record<string, unknown>, READONLY, NUMBERS);
    if (!fields['课次状态']) fields['课次状态'] = '待确认';
    if (!fields['排课来源']) fields['排课来源'] = '人工加课';
    const recordId = await this.base.create(TABLE, fields);
    return this.detail(user, recordId);
  }

  async update(user: SessionUser, id: string, dto: UpdateSessionDto) {
    const principal = toPrincipal(user);
    await this.detail(user, id);
    if (!authorize(principal, 'schedule:write').allowed) throw new ForbiddenException('FORBIDDEN:schedule:write');
    const fields = buildWriteFields(dto as unknown as Record<string, unknown>, READONLY, NUMBERS);
    if (Object.keys(fields).length === 0) throw new BadRequestException('VALIDATION:无可更新字段');
    await this.base.update(TABLE, id, fields);
    return this.detail(user, id);
  }

  async archive(user: SessionUser, id: string) {
    const principal = toPrincipal(user);
    if (!authorize(principal, 'schedule:write').allowed) throw new ForbiddenException('FORBIDDEN:schedule:write');
    await this.detail(user, id);
    await this.base.delete(TABLE, id);
    return { ok: true };
  }

  /** 状态机转移（BR-006）。待确认→已确认 时执行冲突预检，存在硬冲突则拒绝。 */
  async transition(user: SessionUser, id: string, to: string) {
    const principal = toPrincipal(user);
    if (!authorize(principal, 'schedule:write').allowed) throw new ForbiddenException('FORBIDDEN:schedule:write');
    const cur = (await this.detail(user, id)) as Record<string, unknown>;
    const from = (cur['课次状态'] as string) ?? '待确认';
    const allowed = SESSION_TRANSITIONS[from] ?? [];
    if (!allowed.includes(to)) {
      throw new BadRequestException(`BUSINESS_RULE_VIOLATION:不可从「${from}」直接转移到「${to}」`);
    }
    if (to === '已确认') {
      const draft = this.toSessionLike({
        recordId: id,
        fields: cur as Record<string, unknown>,
      });
      const { hard } = await this.precheckConflicts(draft);
      if (hard.length > 0) {
        throw new BadRequestException(
          `BUSINESS_RULE_VIOLATION:存在${hard.length}处硬冲突（${hard.map((h) => h.type).join('、')}），无法确认课次`,
        );
      }
    }
    await this.base.update(TABLE, id, { 课次状态: to });
    return this.detail(user, id);
  }

  /** 冲突预检：取同日课次与拟排课次比较，返回 hard/soft 冲突 */
  async precheckConflicts(draft: SessionLike): Promise<ConflictResult> {
    if (!draft.课次日期?.trim()) return { hard: [], soft: [] };
    const res = await this.base.search(TABLE, { pageSize: 200, filter: buildFilter([{ field: '课次状态', op: 'isNot', value: ['已取消'] }]) });
    const existing: SessionLike[] = res.items.map((r) => this.toSessionLike(r));
    return preflightSessionConflicts(draft, existing);
  }
}
