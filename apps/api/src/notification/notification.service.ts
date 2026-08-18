import { Inject, Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import type { SessionUser } from '@acms/contracts';
import { authorize, type Principal } from '@acms/domain';
import { BaseClient } from '@acms/base-adapter';
import { TABLES } from '@acms/contracts';
import { BASE_CLIENT } from '../base.provider.js';
import { buildWriteFields, toFlatRecord, buildFilter } from '../shared/record.util.js';
import { CreateTemplateDto, UpdateTemplateDto, TemplateFilterDto, SendDto, BatchSendDto, LogFilterDto, TransitionDto, NOTIFICATION_RECEIPT } from './notification.dto.js';

const TPL_TABLE = TABLES.notificationTemplate.tableId;
const LOG_TABLE = TABLES.notificationLog.tableId;
const READONLY = new Set<string>(['创建时间', '更新时间']);
const TPL_NUMBERS = new Set<string>([]);
const LOG_NUMBERS = new Set<string>([]);

function toPrincipal(user: SessionUser): Principal {
  return { roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel };
}

@Injectable()
export class NotificationService {
  constructor(@Inject(BASE_CLIENT) private readonly base: BaseClient) {}

  // ---- 模板 ----
  async listTemplates(user: SessionUser, query: TemplateFilterDto) {
    if (!authorize(toPrincipal(user), 'notification:read').allowed) throw new ForbiddenException('FORBIDDEN:notification:read');
    const conditions: { field: string; op?: string; value: string[] }[] = [];
    if (query.q) conditions.push({ field: '模板名称', op: 'contains', value: [query.q] });
    if (query.渠道) conditions.push({ field: '渠道', value: [query.渠道] });
    if (query.状态) conditions.push({ field: '状态', value: [query.状态] });
    const res = await this.base.search(TPL_TABLE, { pageSize: Number((query as any).pageSize) || 50, pageToken: query.pageToken, filter: buildFilter(conditions) });
    return { items: res.items.map((r) => toFlatRecord(r, READONLY, new Set())), total: res.total, hasMore: res.hasMore, pageToken: res.pageToken };
  }

  async detailTemplate(user: SessionUser, id: string) {
    if (!authorize(toPrincipal(user), 'notification:read').allowed) throw new ForbiddenException('FORBIDDEN:notification:read');
    const rec = await this.base.get(TPL_TABLE, id);
    if (!rec) throw new NotFoundException('NOT_FOUND');
    return toFlatRecord(rec, READONLY, new Set());
  }

  async createTemplate(user: SessionUser, dto: CreateTemplateDto) {
    if (!authorize(toPrincipal(user), 'notification:write').allowed) throw new ForbiddenException('FORBIDDEN:notification:write');
    if (!dto.模板名称?.trim()) throw new BadRequestException('VALIDATION:模板名称必填');
    const fields = buildWriteFields(dto as unknown as Record<string, unknown>, READONLY, TPL_NUMBERS);
    if (!fields['状态']) fields['状态'] = '启用';
    const recordId = await this.base.create(TPL_TABLE, fields);
    return this.detailTemplate(user, recordId);
  }

  async updateTemplate(user: SessionUser, id: string, dto: UpdateTemplateDto) {
    await this.detailTemplate(user, id);
    if (!authorize(toPrincipal(user), 'notification:write').allowed) throw new ForbiddenException('FORBIDDEN:notification:write');
    const fields = buildWriteFields(dto as unknown as Record<string, unknown>, READONLY, TPL_NUMBERS);
    if (Object.keys(fields).length === 0) throw new BadRequestException('VALIDATION:无可更新字段');
    await this.base.update(TPL_TABLE, id, fields);
    return this.detailTemplate(user, id);
  }

  async archiveTemplate(user: SessionUser, id: string) {
    if (!authorize(toPrincipal(user), 'notification:write').allowed) throw new ForbiddenException('FORBIDDEN:notification:write');
    await this.detailTemplate(user, id);
    await this.base.delete(TPL_TABLE, id);
    return { ok: true };
  }

  // ---- 发送与回执 ----
  async listLogs(user: SessionUser, query: LogFilterDto) {
    if (!authorize(toPrincipal(user), 'notification:read').allowed) throw new ForbiddenException('FORBIDDEN:notification:read');
    const conditions: { field: string; op?: string; value: string[] }[] = [];
    if (query.q) conditions.push({ field: '接收人', op: 'contains', value: [query.q] });
    if (query.渠道) conditions.push({ field: '渠道', value: [query.渠道] });
    if (query.发送状态) conditions.push({ field: '发送状态', value: [query.发送状态] });
    if (query.模板文本) conditions.push({ field: '模板文本', op: 'contains', value: [query.模板文本] });
    const res = await this.base.search(LOG_TABLE, { pageSize: Number((query as any).pageSize) || 50, pageToken: query.pageToken, filter: buildFilter(conditions) });
    return { items: res.items.map((r) => toFlatRecord(r, READONLY, new Set())), total: res.total, hasMore: res.hasMore, pageToken: res.pageToken };
  }

  async detailLog(user: SessionUser, id: string) {
    if (!authorize(toPrincipal(user), 'notification:read').allowed) throw new ForbiddenException('FORBIDDEN:notification:read');
    const rec = await this.base.get(LOG_TABLE, id);
    if (!rec) throw new NotFoundException('NOT_FOUND');
    return toFlatRecord(rec, READONLY, new Set());
  }

  private async renderAndLog(user: SessionUser, tplId: string, 接收人: string, 渠道?: string, 内容?: string, 关联业务?: string) {
    const tpl = await this.base.get(TPL_TABLE, tplId);
    if (!tpl) throw new NotFoundException('NOT_FOUND:template');
    const tf = tpl.fields as Record<string, unknown>;
    const fields: Record<string, unknown> = {
      模板文本: tf['模板名称'] as string,
      接收人,
      渠道: 渠道 || (tf['渠道'] as string) || '飞书',
      内容: 内容 || (tf['内容模板'] as string) || '',
      发送状态: '已发送',
      关联业务: 关联业务 || '',
    };
    const recordId = await this.base.create(LOG_TABLE, fields);
    return this.detailLog(user, recordId);
  }

  async send(user: SessionUser, dto: SendDto) {
    if (!authorize(toPrincipal(user), 'notification:send').allowed) throw new ForbiddenException('FORBIDDEN:notification:send');
    if (!dto.接收人?.trim()) throw new BadRequestException('VALIDATION:接收人必填');
    return this.renderAndLog(user, dto.templateId, dto.接收人, dto.渠道, dto.内容, dto.关联业务);
  }

  async batchSend(user: SessionUser, dto: BatchSendDto) {
    if (!authorize(toPrincipal(user), 'notification:send').allowed) throw new ForbiddenException('FORBIDDEN:notification:send');
    if (!Array.isArray(dto.接收人列表) || dto.接收人列表.length === 0) throw new BadRequestException('VALIDATION:接收人列表为空');
    const out: unknown[] = [];
    for (const r of dto.接收人列表) {
      if (r?.trim()) out.push(await this.renderAndLog(user, dto.templateId, r.trim(), dto.渠道, undefined, dto.关联业务));
    }
    return { count: out.length, items: out };
  }

  async transitionLog(user: SessionUser, id: string, dto: TransitionDto) {
    const rec = await this.detailLog(user, id);
    const cur = (rec['发送状态'] as string) || '待发送';
    const allowed = NOTIFICATION_RECEIPT[cur]?.find((t) => t.to === dto.to);
    if (!allowed) throw new BadRequestException('INVALID_TRANSITION:' + cur + '→' + dto.to);
    if (!authorize(toPrincipal(user), allowed.perm as 'notification:send').allowed)
      throw new ForbiddenException('FORBIDDEN:' + allowed.perm);
    const fields: Record<string, unknown> = { 发送状态: dto.to };
    if (dto.to === '已送达' || dto.to === '已读') fields['回执时间'] = new Date().toISOString();
    if (dto.to === '失败') fields['失败原因'] = '手动标记失败';
    await this.base.update(LOG_TABLE, id, fields);
    return this.detailLog(user, id);
  }
}
