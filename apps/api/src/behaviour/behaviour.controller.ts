import {
  Body, Controller, Delete, Get, Inject, Injectable, Logger, Param, Post, Put, Query, Req, UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import type { SessionUser } from '@acms/contracts';
import { TABLES } from '@acms/contracts';
import { BaseClient } from '@acms/base-adapter';
import { BASE_CLIENT } from '../base.provider.js';
import { AuditService } from '../audit/audit.service.js';
import { SessionGuard } from '../auth/session.guard.js';
import { BaseRecordService } from '../shared/generic-crud.module.js';
import { FieldMaskService } from '../shared/field-mask.service.js';
import { BEHAVIOUR_RECORD_META } from './behaviour.meta.js';
import { BehaviourService } from './behaviour.service.js';
import { firstLinkId } from './behaviour.logic.js';

/** 从展平后的记录行里取「学生」record id（readonly 字段不影响 __link 的注入） */
function studentIdOf(rec: Record<string, unknown> | null | undefined): string {
  if (!rec) return '';
  return firstLinkId(rec['学生__link']) || firstLinkId(rec['学生']);
}

/**
 * 行为记录：**自定义控制器承载的标准 CRUD**（其余三张表走 GenericCrudModule.registerAll）。
 *
 * 为什么不直接用通用 CRUD：新建/修改/删除都必须触发该学生的**告警重算**
 * （口径由 behaviour.logic.ts 单点定义），而通用 CRUD 生成的 service 没有写入钩子。
 * 这里继承 BaseRecordService，REST 形状与通用 CRUD 完全一致，前端 CrudPage 零差异。
 *
 * ⚠️ 构造参数比父类多（多了 BehaviourService），**每个槽位都必须显式 @Inject**：
 *    父类的 self:paramtypes 会沿原型链被继承，漏写会让注入对象错位
 *    （mail-archive 曾因此把 AuditService 注进了 fileUpload）。
 */
@Injectable()
export class BehaviourRecordService extends BaseRecordService {
  private readonly logger = new Logger('BehaviourRecord');

  constructor(
    @Inject(BASE_CLIENT) base: BaseClient,
    @Inject(AuditService) audit: AuditService,
    @Inject(FieldMaskService) mask: FieldMaskService,
    @Inject(BehaviourService) private readonly behaviour: BehaviourService,
  ) {
    super(BEHAVIOUR_RECORD_META, base, audit, mask);
  }

  /**
   * 写入后重算该学生的告警。
   *
   * ⚠️ 重算失败**不阻断**业务写（记录已经存好了），但必须打日志 ——
   *    不能像历史踩过的坑那样 `.catch(() => undefined)` 把失败吞成不可见；
   *    用户还可以在列表行上用「重算告警」手动补一次。
   */
  private async recalcForStudents(ids: readonly string[]): Promise<void> {
    const uniq = Array.from(new Set(ids.map((s) => String(s ?? '').trim()).filter(Boolean)));
    if (!uniq.length) return;
    try {
      await this.behaviour.recalcForStudents(uniq);
    } catch (e) {
      this.logger.error(`[behaviour] 写入后重算告警失败（学生：${uniq.join(',')}）：${(e as Error).message}`);
    }
  }

  /**
   * 冗余列「学生姓名 / 班级」由服务端从学生档案补齐。
   *
   * 为什么不让前端填：列表展示、按班级汇总、告警重算都依赖这两列，
   * 让用户手敲必然出现「关联的是张三、冗余列写李四」这类不一致（而且很难发现）。
   * 只选学生即可，姓名自动带出；班级仅在留空时用学生的「当前班级」补齐。
   */
  private async fillStudentFields(dto: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sid = firstLinkId(dto['学生']);
    if (!sid) return dto;
    try {
      const rec = await this.base.get(TABLES.studentProfile.tableId, sid);
      if (!rec) return dto;
      const out = { ...dto };
      const name = String(rec.fields['学生姓名'] ?? '');
      if (name) out['学生姓名'] = name;
      if (!String(out['班级'] ?? '').trim()) out['班级'] = String(rec.fields['当前班级'] ?? '');
      return out;
    } catch (e) {
      // 学生档案读不到不该阻断写入：退化成用户提交的原值（姓名列可能为空，但记录不丢）
      this.logger.warn(`[behaviour] 学生档案读取失败，姓名/班级冗余列未补齐：${(e as Error).message}`);
      return dto;
    }
  }

  async create(user: SessionUser, dto: Record<string, unknown>) {
    const rec = await super.create(user, await this.fillStudentFields(dto));
    await this.recalcForStudents([studentIdOf(rec as Record<string, unknown>)]);
    return rec;
  }

  async update(user: SessionUser, id: string, dto: Record<string, unknown>) {
    // 修改可能换学生（改错人），所以**新旧学生都要重算**
    const before = await this.detail(user, id).catch(() => null);
    const rec = await super.update(user, id, await this.fillStudentFields(dto));
    await this.recalcForStudents([
      studentIdOf(before as Record<string, unknown> | null),
      studentIdOf(rec as Record<string, unknown>),
    ]);
    return rec;
  }

  /** 状态流转（草稿→已发布→已归档）也可能改变统计口径，同样重算 */
  async transition(user: SessionUser, id: string, to: string) {
    const rec = await super.transition(user, id, to);
    await this.recalcForStudents([studentIdOf(rec as Record<string, unknown>)]);
    return rec;
  }

  async archive(user: SessionUser, id: string) {
    const before = await this.detail(user, id).catch(() => null);
    const r = await super.archive(user, id);
    await this.recalcForStudents([studentIdOf(before as Record<string, unknown> | null)]);
    return r;
  }
}

/**
 * 行为记录模块的**专用接口**（通用 CRUD 表达不了的都在这）。
 *
 * 路由前缀与 RecordMeta.path 对齐（`behaviour/...`），`moduleByPath` 才能命中
 * `{ key:'behaviour', path:'/behaviour' }` 这个模块资源；鉴权在 service 里用 requireModule 执行。
 *
 * ⚠️ 静态路径必须声明在参数路径之前（Nest 按声明顺序匹配），否则会被 `:id` 捕获。
 */
@Controller()
@UseGuards(SessionGuard)
export class BehaviourController {
  constructor(
    private readonly svc: BehaviourRecordService,
    private readonly behaviour: BehaviourService,
  ) {}

  // ── 记录 CRUD（与通用 CRUD 同形状，供 CrudPage 直接使用）──────────
  @Get('behaviour/records')
  list(@Req() req: Request, @Query() q: Record<string, string | undefined>) {
    return this.svc.list((req as Request & { user: SessionUser }).user, q);
  }

  @Post('behaviour/records')
  create(@Req() req: Request, @Body() body: Record<string, unknown>) {
    return this.svc.create((req as Request & { user: SessionUser }).user, body);
  }

  @Put('behaviour/records/:id')
  update(@Req() req: Request, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.svc.update((req as Request & { user: SessionUser }).user, id, body);
  }

  @Delete('behaviour/records/:id')
  archive(@Req() req: Request, @Param('id') id: string) {
    return this.svc.archive((req as Request & { user: SessionUser }).user, id);
  }

  @Post('behaviour/records/:id/transition')
  transition(@Req() req: Request, @Param('id') id: string, @Body() body: { to: string }) {
    return this.svc.transition((req as Request & { user: SessionUser }).user, id, body?.to ?? '');
  }

  /** 某条行为的全部跟进流水（按跟进日期倒序） */
  @Get('behaviour/records/:id/follow-ups')
  followUps(@Req() req: Request, @Param('id') id: string) {
    return this.behaviour.listFollowUps((req as Request & { user: SessionUser }).user, id);
  }

  @Get('behaviour/records/:id')
  detail(@Req() req: Request, @Param('id') id: string) {
    return this.svc.detail((req as Request & { user: SessionUser }).user, id);
  }

  // ── 派生接口 ──────────────────────────────────────────────────────

  /**
   * 重算告警。不传 studentId = 全量重算；传了只算该学生。
   * 返回 新增 / 更新 / 解除 / 未变 的条数（前端用它做提示）。
   */
  @Post('behaviour/recalc-alerts')
  recalcAlerts(@Req() req: Request, @Body() body: { studentId?: string }) {
    return this.behaviour.recalcAlerts((req as Request & { user: SessionUser }).user, {
      studentId: body?.studentId ? String(body.studentId) : undefined,
    });
  }

  /**
   * 按告警等级生成一封家长通知信件（幂等：同告警同一档不重复生成）。
   * body: { alertId, studentId?, 收件家长? }
   */
  @Post('behaviour/letters/generate')
  generateLetter(
    @Req() req: Request,
    @Body() body: { alertId?: string; studentId?: string; 收件家长?: string },
  ) {
    return this.behaviour.generateLetter((req as Request & { user: SessionUser }).user, {
      alertId: body?.alertId ? String(body.alertId) : '',
      studentId: body?.studentId ? String(body.studentId) : undefined,
      收件家长: body?.收件家长 ? String(body.收件家长) : undefined,
    });
  }

  /** 按班级/年级汇总（行为条数 正向/负向、涉及学生数、告警数按等级） */
  @Get('behaviour/stats')
  stats(
    @Req() req: Request,
    @Query() q: { from?: string; to?: string; 班级?: string; 年级?: string },
  ) {
    return this.behaviour.stats((req as Request & { user: SessionUser }).user, {
      from: q?.from,
      to: q?.to,
      班级: q?.班级,
      年级: q?.年级,
    });
  }
}
