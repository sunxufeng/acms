/**
 * 通用记录 CRUD 模块（M1 学生生命周期域：生源跟进 / 学生考勤 / 学业成绩 / 实践活动 /
 * 家校沟通 / 阶段评价 / 校友跟进）。这些表结构高度同质，统一用一份泛型服务 + 动态
 * 控制器承载，避免 7×4 重复文件。每种表通过 RecordMeta 描述字段约束。
 */
import {
  Controller, Get, Post, Put, Delete, Param, Query, Body, Req, UseGuards,
  Inject, Injectable, Module, type DynamicModule, type Type,
} from '@nestjs/common';
import type { Request } from 'express';
import { ForbiddenException, NotFoundException, BadRequestException } from '@nestjs/common';
import type { SessionUser } from '@acms/contracts';
import { authorize, type Principal } from '@acms/domain';
import { BaseClient } from '@acms/base-adapter';
import { toText, type FilterCondition, type FilterGroup } from '@acms/base-adapter';
import { BASE_CLIENT, baseClientProvider } from '../base.provider.js';
import { SessionGuard } from '../auth/session.guard.js';
import { AuditService } from '../audit/audit.service.js';
import { buildWriteFields, toFlatRecord, buildFilter } from './record.util.js';

export interface RecordMeta {
  /** 路由前缀，如 'source-followups' */
  path: string;
  /** TABLES 中的键或真实 tableId */
  tableId: string;
  readPerm: string;
  writePerm: string;
  /** 只读字段（含自增编号、附件等不写字段） */
  readonly?: string[];
  /** 数值字段 */
  numbers?: string[];
  /** 多值字段 */
  multi?: string[];
  /** 状态字段（展示 + 可编辑） */
  statusField?: string;
  defaultStatus?: string;
  /** q 关键字检索字段（单字段 contains）。与 searchFields 二选一，searchFields 优先 */
  searchField?: string;
  /** q 关键字检索字段（多字段 OR 匹配，如配置键 + 配置值） */
  searchFields?: string[];
  /** 日期字段（写时字符串→毫秒时间戳） */
  dateFields?: string[];
  /** 列表默认排序字段 */
  sortField?: string;
  /** 学生 360 聚合时如何把记录关联到某学生：
   *  - { field: '关联学生编号', by: 'id' }：关联字段为 link，存 record id（考勤/成绩/实践/评价/校友）
   *  - { field: '关联学生', by: 'name' }：关联字段为文本，存学生姓名（招生/家校/日常跟进） */
  studentMatch?: { field: string; by: 'id' | 'name' };
  /** 时间范围筛选字段（用于审计日志等的操作时间区间过滤，内存过滤） */
  rangeField?: string;
  /** 关联字段（type=18/21/22）：需跨表解析为可读名。field=本表字段名，table=目标表 tableId，nameField=目标表用于展示的字段名 */
  linkFields?: { field: string; table: string; nameField: string }[];
}

function toPrincipal(user: SessionUser): Principal {
  return { roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel };
}

export class BaseRecordService {
  constructor(
    protected readonly meta: RecordMeta,
    @Inject(BASE_CLIENT) private readonly base: BaseClient,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** 操作人展示名 */
  private actorName(user: SessionUser): string {
    return user.name || user.openId || 'unknown';
  }

  /** 审计：跳过审计日志表自身，避免自审计噪声 */
  private emitAudit(
    user: SessionUser,
    action: '创建' | '更新' | '删除',
    recordId: string,
    detail?: string,
  ): void {
    if (this.meta.path === 'audit-logs') return;
    void this.audit.log({
      actor: this.actorName(user),
      action,
      module: this.meta.path,
      recordId,
      detail,
    });
  }

  private get tableId() {
    return this.meta.tableId;
  }

  private readonlySet() {
    return new Set(this.meta.readonly ?? []);
  }
  private numberSet() {
    return new Set(this.meta.numbers ?? []);
  }
  private multiSet() {
    return new Set(this.meta.multi ?? []);
  }
  private linkSet() {
    return new Set((this.meta.linkFields ?? []).map((l) => l.field));
  }

  /** 审计等场景的扩展筛选参数（不走飞书服务端过滤，按需内存过滤） */
  private static readonly DEEP_PARAMS = ['from', 'to', 'actor', 'module', 'action'] as const;

  async list(user: SessionUser, query: Record<string, string | undefined>) {
    if (!authorize(toPrincipal(user), this.meta.readPerm as Parameters<typeof authorize>[1]).allowed)
      throw new ForbiddenException('FORBIDDEN:' + this.meta.readPerm);
    // 审计日志：按操作人(模糊)/业务模块(模糊)/操作类型(精确)/时间范围 筛选，内存过滤
    if (BaseRecordService.DEEP_PARAMS.some((k) => query[k])) {
      return this.listDeep(query);
    }
    // 关联字段（link）作为搜索目标时，飞书服务端 contains 对关联字段无效 → 走内存按解析文本过滤
    if (query.q && this.meta.searchField && this.linkSet().has(this.meta.searchField)) {
      return this.listByLinkSearch(query);
    }
    const conditions: (FilterCondition | FilterGroup)[] = [];
    for (const [k, v] of Object.entries(query)) {
      if (['pageToken', 'sortBy', 'sortOrder', 'q', 'pageSize'].includes(k)) continue;
      if (v) conditions.push({ field: k, value: [v] });
    }
    if (query.q) {
      const q = query.q;
      const fields = this.meta.searchFields?.length
        ? this.meta.searchFields
        : this.meta.searchField
          ? [this.meta.searchField]
          : undefined;
      if (fields?.length) {
        const f0 = fields[0];
        conditions.push(
          fields.length > 1 && f0 !== undefined
            ? {
                conjunction: 'or',
                conditions: fields.map((f) => ({ field: f, op: 'contains', value: [q] })),
              }
            : { field: f0 ?? '', op: 'contains', value: [q] },
        );
      }
    }
    const sort = query.sortBy
      ? [{ field: query.sortBy, desc: query.sortOrder !== 'asc' }]
      : [{ field: this.meta.sortField ?? '更新时间', desc: true }];
    const pageSize = Number(query.pageSize) || 50;
    const res = await this.base.search(this.tableId, {
      pageSize,
      pageToken: query.pageToken,
      filter: buildFilter(conditions),
      sort,
    });
    const items = res.items.map((r) => toFlatRecord(r, this.readonlySet(), this.multiSet(), this.linkSet()));
    await this.resolveLinks(items);
    return {
      items,
      total: res.total,
      hasMore: res.hasMore,
      pageToken: res.pageToken,
    };
  }

  /** 关联字段搜索：拉全量 → 解析可读名 → 按解析文本模糊过滤 */
  private async listByLinkSearch(query: Record<string, string | undefined>) {
    const sf = this.meta.searchField!;
    const q = String(query.q).toLowerCase();
    const rows = (await this.fetchAll()).map((r) => toFlatRecord(r, this.readonlySet(), this.multiSet(), this.linkSet()));
    await this.resolveLinks(rows);
    const filtered = rows.filter((r) => String(r[sf] ?? '').toLowerCase().includes(q));
    return { items: filtered, total: filtered.length, hasMore: false, pageToken: undefined };
  }

  /** 关联字段跨表解析：将 [{record_ids:[...]}] 的 id 替换为目标表的可读名（如 学生姓名） */
  private async resolveLinks(items: Record<string, unknown>[]): Promise<void> {
    const links = this.meta.linkFields;
    if (!links || !links.length || !items.length) return;
    // 收集每个目标表需解析的 id
    const need: Record<string, { nameField: string; ids: Set<string> }> = {};
    for (const l of links) {
      for (const it of items) {
        const ids = (it[l.field + '__link'] as string[]) || [];
        if (!ids.length) continue;
        const entry = need[l.table] ?? (need[l.table] = { nameField: l.nameField, ids: new Set() });
        ids.forEach((id) => entry.ids.add(id));
      }
    }
    if (!Object.keys(need).length) return;
    // 并行批量取名字（按 20 一组并发，避免一次性开太多连接）
    const nameMap = new Map<string, string>();
    const chunk = <T,>(arr: T[], n: number): T[][] => {
      const out: T[][] = [];
      for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
      return out;
    };
    await Promise.all(
      Object.entries(need).map(async ([table, info]) => {
        const batches = chunk([...info.ids], 20);
        for (const batch of batches) {
          await Promise.all(
            batch.map(async (id) => {
              const rec = await this.base.get(table, id);
              const name = rec ? toText(rec.fields[info.nameField]) : '';
              nameMap.set(`${table}|${id}`, name || id);
            }),
          );
        }
      }),
    );
    // 回填可读名
    for (const it of items) {
      for (const l of links) {
        const ids = (it[l.field + '__link'] as string[]) || [];
        if (!ids.length) {
          it[l.field] = '';
          continue;
        }
        it[l.field] = ids.map((id) => nameMap.get(`${l.table}|${id}`) || id).join('、');
      }
    }
  }

  /** 扩展筛选（仅审计日志使用）：拉全量后在内存做 模糊/精确/时间区间 过滤，保证 total 准确 */
  private async listDeep(query: Record<string, string | undefined>) {
    const rangeField = this.meta.rangeField ?? this.meta.dateFields?.[0];
    const rows = (await this.fetchAll()).map((r) => toFlatRecord(r, this.readonlySet(), this.multiSet(), this.linkSet()));
    let filtered = rows;
    if (rangeField && (query.from || query.to)) {
      const from = query.from ? new Date(query.from + 'T00:00:00').getTime() : -Infinity;
      const to = query.to ? new Date(query.to + 'T23:59:59.999').getTime() : Infinity;
      filtered = filtered.filter((r) => {
        const t = Number(r[rangeField]);
        return Number.isFinite(t) && t >= from && t <= to;
      });
    }
    if (query.actor) {
      const a = String(query.actor).toLowerCase();
      filtered = filtered.filter((r) => String(r['操作人'] ?? '').toLowerCase().includes(a));
    }
    if (query.module) {
      const m = String(query.module).toLowerCase();
      filtered = filtered.filter((r) => String(r['业务模块'] ?? '').toLowerCase().includes(m));
    }
    if (query.action) {
      filtered = filtered.filter((r) => String(r['操作类型'] ?? '') === query.action);
    }
    if (rangeField) {
      filtered.sort((x, y) => Number(y[rangeField]) - Number(x[rangeField]));
    }
    return { items: filtered, total: filtered.length, hasMore: false, pageToken: undefined };
  }

  /** 拉取整表（上限 20000 行，足够内部审计日志规模） */
  private async fetchAll(): Promise<{ recordId: string; fields: Record<string, unknown> }[]> {
    const out: { recordId: string; fields: Record<string, unknown> }[] = [];
    let tok: string | undefined;
    let guard = 0;
    do {
      const res = await this.base.search(this.tableId, { pageSize: 100, pageToken: tok });
      out.push(...res.items);
      tok = res.hasMore ? res.pageToken : undefined;
    } while (tok && guard++ < 200);
    return out;
  }

  async detail(user: SessionUser, id: string) {
    if (!authorize(toPrincipal(user), this.meta.readPerm as Parameters<typeof authorize>[1]).allowed)
      throw new ForbiddenException('FORBIDDEN:' + this.meta.readPerm);
    const rec = await this.base.get(this.tableId, id);
    if (!rec) throw new NotFoundException('NOT_FOUND');
    const flat = toFlatRecord(rec, this.readonlySet(), this.multiSet(), this.linkSet());
    await this.resolveLinks([flat]);
    return flat;
  }

  private writeFields(dto: Record<string, unknown>) {
    const fields = buildWriteFields(dto, this.readonlySet(), this.numberSet());
    // 关联字段（link）：前端提交单 record id 字符串，飞书 record link 写入要求 [record_id]
    for (const l of this.meta.linkFields ?? []) {
      const v = fields[l.field];
      if (typeof v === 'string' && v.trim()) fields[l.field] = [v.trim()];
      else if (Array.isArray(v) && v.length) fields[l.field] = v.map((it) => (typeof it === 'string' ? it : (it as { record_id?: string })?.record_id)).filter(Boolean);
      else if (l.field in dto && (v === '' || v == null)) fields[l.field] = [];
    }
    for (const k of this.meta.dateFields ?? []) {
      const v = fields[k];
      if (typeof v === 'string') {
        if (v.trim() === '') delete fields[k];
        else {
          const t = new Date(v.trim()).getTime();
          if (!Number.isNaN(t)) fields[k] = t;
          else delete fields[k];
        }
      }
    }
    return fields;
  }

  async create(user: SessionUser, dto: Record<string, unknown>) {
    if (!authorize(toPrincipal(user), this.meta.writePerm as Parameters<typeof authorize>[1]).allowed)
      throw new ForbiddenException('FORBIDDEN:' + this.meta.writePerm);
    const fields = this.writeFields(dto);
    if (this.meta.statusField && !fields[this.meta.statusField] && this.meta.defaultStatus) {
      fields[this.meta.statusField] = this.meta.defaultStatus;
    }
    const recordId = await this.base.create(this.tableId, fields);
    this.emitAudit(user, '创建', recordId, Object.keys(fields).join(','));
    return this.detail(user, recordId);
  }

  async update(user: SessionUser, id: string, dto: Record<string, unknown>) {
    if (!authorize(toPrincipal(user), this.meta.writePerm as Parameters<typeof authorize>[1]).allowed)
      throw new ForbiddenException('FORBIDDEN:' + this.meta.writePerm);
    await this.detail(user, id);
    const fields = this.writeFields(dto);
    if (Object.keys(fields).length === 0) throw new BadRequestException('VALIDATION:无可更新字段');
    await this.base.update(this.tableId, id, fields);
    this.emitAudit(user, '更新', id, Object.keys(fields).join(','));
    return this.detail(user, id);
  }

  async archive(user: SessionUser, id: string) {
    if (!authorize(toPrincipal(user), this.meta.writePerm as Parameters<typeof authorize>[1]).allowed)
      throw new ForbiddenException('FORBIDDEN:' + this.meta.writePerm);
    await this.detail(user, id);
    await this.base.delete(this.tableId, id);
    this.emitAudit(user, '删除', id);
    return { ok: true };
  }

  async transition(user: SessionUser, id: string, to: string) {
    if (!authorize(toPrincipal(user), this.meta.writePerm as Parameters<typeof authorize>[1]).allowed)
      throw new ForbiddenException('FORBIDDEN:' + this.meta.writePerm);
    if (!this.meta.statusField) throw new BadRequestException('NO_STATUS_FIELD');
    await this.detail(user, id);
    await this.base.update(this.tableId, id, { [this.meta.statusField]: to });
    return this.detail(user, id);
  }
}

function makeService(meta: RecordMeta): Type<BaseRecordService> {
  @Injectable()
  class GService extends BaseRecordService {
    constructor(
      @Inject(BASE_CLIENT) base: BaseClient,
      @Inject(AuditService) audit: AuditService,
    ) {
      super(meta, base, audit);
    }
  }
  return GService as unknown as Type<BaseRecordService>;
}

function makeController(meta: RecordMeta, SvcClass: Type<BaseRecordService>) {
  @Controller(meta.path)
  @UseGuards(SessionGuard)
  class GController {
    constructor(@Inject(SvcClass) private readonly svc: BaseRecordService) {}
    @Get() list(@Req() req: Request, @Query() q: Record<string, string | undefined>) {
      return this.svc.list((req as Request & { user: SessionUser }).user, q);
    }
    @Get(':id') detail(@Req() req: Request, @Param('id') id: string) {
      return this.svc.detail((req as Request & { user: SessionUser }).user, id);
    }
    @Post() create(@Req() req: Request, @Body() body: Record<string, unknown>) {
      return this.svc.create((req as Request & { user: SessionUser }).user, body);
    }
    @Put(':id') update(@Req() req: Request, @Param('id') id: string, @Body() body: Record<string, unknown>) {
      return this.svc.update((req as Request & { user: SessionUser }).user, id, body);
    }
    @Delete(':id') archive(@Req() req: Request, @Param('id') id: string) {
      return this.svc.archive((req as Request & { user: SessionUser }).user, id);
    }
    @Post(':id/transition') transition(@Req() req: Request, @Param('id') id: string, @Body() body: { to: string }) {
      return this.svc.transition((req as Request & { user: SessionUser }).user, id, body.to);
    }
  }
  return GController;
}

@Module({})
export class GenericCrudModule {
  static registerAll(metas: RecordMeta[]): DynamicModule {
    const controllers: Type[] = [];
    const providers: Type[] = [];
    for (const meta of metas) {
      const SvcClass = makeService(meta);
      controllers.push(makeController(meta, SvcClass));
      providers.push(SvcClass);
    }
    return {
      module: GenericCrudModule,
      controllers,
      providers: [...providers, baseClientProvider],
    };
  }
}
