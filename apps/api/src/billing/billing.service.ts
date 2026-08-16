import { Inject, Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import type { SessionUser } from '@acms/contracts';
import { authorize, type Principal } from '@acms/domain';
import { BaseClient } from '@acms/base-adapter';
import { TABLES } from '@acms/contracts';
import { BASE_CLIENT } from '../base.provider.js';
import { buildWriteFields, toFlatRecord, buildFilter } from '../shared/record.util.js';
import { CreateBillingDto, UpdateBillingDto, BillingFilterDto, TransitionDto, GenerateBillingDto, BILLING_TRANSITIONS } from './billing.dto.js';

const TABLE = TABLES.billingDetail.tableId;
const ATT_TABLE = TABLES.teacherAttendance.tableId;
const PART_TABLE = TABLES.partnership.tableId;
const READONLY = new Set<string>(['创建时间', '更新时间']);
const NUMBERS = new Set(['课时数量', '单价', '金额']);

function toPrincipal(user: SessionUser): Principal {
  return { roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel };
}

@Injectable()
export class BillingService {
  constructor(@Inject(BASE_CLIENT) private readonly base: BaseClient) {}

  async list(user: SessionUser, query: BillingFilterDto) {
    if (!authorize(toPrincipal(user), 'billing:read').allowed) throw new ForbiddenException('FORBIDDEN:billing:read');
    const conditions: { field: string; op?: string; value: string[] }[] = [];
    if (query.q) conditions.push({ field: '教学班文本', op: 'contains', value: [query.q] });
    if (query.计费状态) conditions.push({ field: '计费状态', value: [query.计费状态] });
    if (query.计费周期) conditions.push({ field: '计费周期', value: [query.计费周期] });
    if (query.教师文本) conditions.push({ field: '教师文本', op: 'contains', value: [query.教师文本] });
    const sort = query.sortBy
      ? [{ field: query.sortBy, desc: query.sortOrder !== 'asc' }]
      : [{ field: '计费周期', desc: true }];
    const res = await this.base.search(TABLE, { pageSize: 50, pageToken: query.pageToken, filter: buildFilter(conditions), sort });
    return { items: res.items.map((r) => toFlatRecord(r, READONLY, new Set())), total: res.total, hasMore: res.hasMore, pageToken: res.pageToken };
  }

  async detail(user: SessionUser, id: string) {
    if (!authorize(toPrincipal(user), 'billing:read').allowed) throw new ForbiddenException('FORBIDDEN:billing:read');
    const rec = await this.base.get(TABLE, id);
    if (!rec) throw new NotFoundException('NOT_FOUND');
    return toFlatRecord(rec, READONLY, new Set());
  }

  async create(user: SessionUser, dto: CreateBillingDto) {
    if (!authorize(toPrincipal(user), 'billing:write').allowed) throw new ForbiddenException('FORBIDDEN:billing:write');
    const fields = buildWriteFields(dto as unknown as Record<string, unknown>, READONLY, NUMBERS);
    if (!fields['计费状态']) fields['计费状态'] = '待生成';
    const recordId = await this.base.create(TABLE, fields);
    return this.detail(user, recordId);
  }

  /** 基于已审核履约 + 有效合作关系生成计费明细（BR-008 固化快照） */
  async generate(user: SessionUser, dto: GenerateBillingDto) {
    if (!authorize(toPrincipal(user), 'billing:write').allowed) throw new ForbiddenException('FORBIDDEN:billing:write');
    const att = await this.base.get(ATT_TABLE, dto.attendanceId);
    if (!att) throw new NotFoundException('NOT_FOUND:attendance');
    const attFields = att.fields as Record<string, unknown>;
    const status = attFields['出勤状态'] as string;
    if (status !== '教务已审核' && status !== '可计费')
      throw new BadRequestException('BUSINESS_RULE:履约须为教务已审核/可计费才可计费');
    const teacher = (attFields['授课教师文本'] as string) || '';
    const partRes = await this.base.search(PART_TABLE, {
      pageSize: 50,
      filter: buildFilter([
        { field: '教师文本', op: 'contains', value: [teacher] },
        { field: '合作状态', value: ['生效中'] },
      ]),
    });
    const part = partRes.items[0];
    if (!part) throw new BadRequestException('BUSINESS_RULE:未找到该教师有效合作关系');
    const pFields = part.fields as Record<string, unknown>;
    const rate = Number(pFields['费率'] ?? 0);
    const hours = Number(attFields['计划课时'] ?? 0);
    const amount = Math.round(rate * hours * 100) / 100;
    const cycle = (attFields['出勤日期'] as string || '').slice(0, 7);
    const snapshot = JSON.stringify({
      partnershipRecordId: part.recordId,
      rate,
      计费方式: pFields['计费方式'],
      计费规则说明: pFields['计费规则说明'],
      sourceAttendanceId: att.recordId,
      generatedAt: new Date().toISOString(),
    });
    const fields: Record<string, unknown> = {
      履约引用文本: att.recordId,
      教师文本: teacher,
      教学班文本: attFields['教学班文本'],
      来源课次文本: attFields['课次文本'],
      计费周期: cycle,
      课时数量: hours,
      单价: rate,
      金额: amount,
      计费状态: '待确认',
      快照: snapshot,
    };
    const recordId = await this.base.create(TABLE, fields);
    return this.detail(user, recordId);
  }

  async update(user: SessionUser, id: string, dto: UpdateBillingDto) {
    await this.detail(user, id);
    if (!authorize(toPrincipal(user), 'billing:write').allowed) throw new ForbiddenException('FORBIDDEN:billing:write');
    const fields = buildWriteFields(dto as unknown as Record<string, unknown>, READONLY, NUMBERS);
    if (Object.keys(fields).length === 0) throw new BadRequestException('VALIDATION:无可更新字段');
    await this.base.update(TABLE, id, fields);
    return this.detail(user, id);
  }

  async archive(user: SessionUser, id: string) {
    if (!authorize(toPrincipal(user), 'billing:write').allowed) throw new ForbiddenException('FORBIDDEN:billing:write');
    await this.detail(user, id);
    await this.base.delete(TABLE, id);
    return { ok: true };
  }

  async transition(user: SessionUser, id: string, dto: TransitionDto) {
    const rec = await this.detail(user, id);
    const cur = (rec['计费状态'] as string) || '待生成';
    const allowed = BILLING_TRANSITIONS[cur]?.find((t) => t.to === dto.to);
    if (!allowed) throw new BadRequestException('INVALID_TRANSITION:' + cur + '→' + dto.to);
    if (!authorize(toPrincipal(user), allowed.perm as 'billing:write').allowed)
      throw new ForbiddenException('FORBIDDEN:' + allowed.perm);
    await this.base.update(TABLE, id, { 计费状态: dto.to });
    return this.detail(user, id);
  }
}
