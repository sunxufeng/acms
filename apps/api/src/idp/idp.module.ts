/**
 * IDP 模块（2026-09-26 重构后同时承载新旧两套）。
 *
 * **旧（入口已下掉，表与接口保留备查）**
 *  - idp-plans：自定义服务（IdpPlanService 在 create 时校验「同一学生同一学期唯一」），
 *    自定义控制器复用 BaseRecordService 的 list/detail/update/archive/transition。
 *  - idp-communications：用泛型 CRUD 直接注册。
 *  两张表生产实测**各 0 行**，峰哥口径「原有 IDP 管理功能可以不要了」⇒ 只下菜单不删表。
 *
 * **新（本次重构）**
 *  - idp-configs / idp-students 两张表：由 `GenericCrudModule.registerAll(IDP_METAS)` 生成
 *    标准 CRUD（建表在本模块的 onModuleInit，通用 CRUD 只生成路由、不建表）。
 *  - 聚合接口（配置清单、拉学生、分配老师、我的 IDP、沟通时间线）在 `IdpService` +
 *    下面三个 controller 里，路径**刻意避开** `/idp-configs` 的根与 `:id`：
 *    通用 CRUD 已经占了 `GET /idp-configs`（列表）与 `GET /idp-configs/:id`（详情），
 *    同路径再注册一个控制器时 Nest 只认先注册的那个，后者**静默不可达**（不报错）。
 *    所以配置清单走 `/idp-overview`，候选走 `/idp-options`、`/idp-teachers`。
 */
import {
  Controller, Get, Post, Put, Delete, Param, Query, Body, Req, UseGuards,
  Inject, Injectable, Logger, Module, type OnModuleInit,
} from '@nestjs/common';
import type { Request } from 'express';
import { BadRequestException } from '@nestjs/common';
import { TABLES, type IdpScope, type SessionUser } from '@acms/contracts';
import { BaseClient } from '@acms/base-adapter';
import { BASE_CLIENT, baseClientProvider, getSqlStore } from '../base.provider.js';
import { AuditService } from '../audit/audit.service.js';
import { SessionGuard } from '../auth/session.guard.js';
import { BaseRecordService, GenericCrudModule } from '../shared/generic-crud.module.js';
import { FieldMaskService } from '../shared/field-mask.service.js';
import { IDP_PLAN_META, IDP_COMM_META, IDP_CONFIG_META, IDP_STUDENT_META } from './idp.meta.js';
import { IdpService } from './idp.service.js';

@Injectable()
export class IdpPlanService extends BaseRecordService {
  private readonly client: BaseClient;
  constructor(
    @Inject(BASE_CLIENT) base: BaseClient,
    @Inject(AuditService) audit: AuditService,
    @Inject(FieldMaskService) mask: FieldMaskService,
  ) {
    super(IDP_PLAN_META, base, audit, mask);
    this.client = base;
  }

  /** 约束 1：一个学生同一学期只能有一个 IDP 方案 */
  async create(user: SessionUser, dto: Record<string, unknown>) {
    const student = String(dto['关联学生'] ?? '').trim();
    const semester = String(dto['学期'] ?? '').trim();
    if (student && semester) {
      const res = await this.client.search(IDP_PLAN_META.tableId, {
        pageSize: 1,
        filter: {
          conjunction: 'and',
          conditions: [
            { field: '关联学生', op: 'is', value: [student] },
            { field: '学期', op: 'is', value: [semester] },
          ],
        },
      });
      if (res.items.length > 0) {
        throw new BadRequestException('DUPLICATE_IDP: 该学生该学期已存在 IDP 方案，不能重复创建');
      }
    }
    return super.create(user, dto);
  }
}

@Controller('idp-plans')
@UseGuards(SessionGuard)
class IdpPlanController {
  constructor(private readonly svc: IdpPlanService) {}
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

/**
 * 「IDP 配置」页的管理端聚合接口 —— 全部**只给管理员/院级**（`module:idpPlans:*`，
 * 判据在 `IdpService` 里统一做，见那里的权限表）。
 *
 * ⚠️ 路径别改成 `/idp-configs` 的根或 `:id`：通用 CRUD 已占用，同路径的后者不可达。
 */
@Controller()
@UseGuards(SessionGuard)
class IdpAggController {
  constructor(private readonly svc: IdpService) {}

  /** 配置清单（带学生数、区间是否可用） */
  @Get('idp-overview')
  overview(@Req() req: Request) {
    return this.svc.configs(userOf(req));
  }

  /** 新建配置弹窗的可选项（学年 / 学期 / 年级 / 班级） */
  @Get('idp-options')
  options(@Req() req: Request) {
    return this.svc.options(userOf(req));
  }

  /** IDP 老师候选（open_id → 姓名） */
  @Get('idp-teachers')
  teachers(@Req() req: Request) {
    return this.svc.teachers(userOf(req));
  }

  /** 明细列表（含实时沟通次数与老师姓名） */
  @Get('idp-configs/:id/students')
  students(@Req() req: Request, @Param('id') id: string) {
    return this.svc.configStudents(userOf(req), id);
  }

  /** 按范围把学生拉进明细（幂等：不重复插入、不覆盖已分配的 IDP 老师） */
  @Post('idp-configs/:id/pull-students')
  pull(@Req() req: Request, @Param('id') id: string, @Body() body: { scope?: IdpScope }) {
    const scope = body?.scope ?? { kind: 'all' as const };
    return this.svc.pullStudents(userOf(req), id, scope);
  }

  /** 批量分配 / 更换 IDP 老师 */
  @Post('idp-configs/:id/assign')
  assign(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: { studentIds?: string[]; teacherOpenId?: string },
  ) {
    return this.svc.assignTeachers(userOf(req), id, body?.studentIds ?? [], String(body?.teacherOpenId ?? ''));
  }

  /** 改单个明细（老师 / 状态 / 备注） */
  @Post('idp-students/:id/patch')
  patch(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: { teacherOpenId?: string; status?: string; note?: string },
  ) {
    return this.svc.patchStudent(userOf(req), id, body ?? {});
  }

  /** 重算「沟通次数 / 最近沟通」快照（导出与排序用；界面数字走实时计算） */
  @Post('idp-recount')
  recount(@Req() req: Request, @Body() body: { configId?: string }) {
    return this.svc.recount(userOf(req), body?.configId);
  }
}

/**
 * 「我的 IDP」老师端接口。
 *
 * 🔴 可见性判据是 `myIdpMenuVisible`（= 任一记录类型 read），**不是** `idpPlans` ——
 *    Phase1~9 全都不持有后者（生产实测），复用它等于上线即无人可见。
 * 数据面靠「IDP老师 = 我的 openId」过滤 ⇒ 老师之间互相看不到（判据在 service 内）。
 */
@Controller('my-idp')
@UseGuards(SessionGuard)
class MyIdpController {
  constructor(private readonly svc: IdpService) {}

  @Get()
  mine(@Req() req: Request) {
    return this.svc.myIdp(userOf(req));
  }

  @Get('comms')
  comms(@Req() req: Request, @Query('configId') configId: string, @Query('studentId') studentId: string) {
    return this.svc.studentComms(userOf(req), configId ?? '', studentId ?? '');
  }
}

function userOf(req: Request): SessionUser {
  return (req as Request & { user: SessionUser }).user;
}

@Module({
  imports: [GenericCrudModule.registerAll([IDP_COMM_META, IDP_CONFIG_META, IDP_STUDENT_META])],
  controllers: [IdpPlanController, IdpAggController, MyIdpController],
  providers: [IdpPlanService, IdpService, baseClientProvider],
  /** 供学生全景等模块注入（本次未接，但导出语义上属于「本模块提供的能力」） */
  exports: [IdpService],
})
export class IdpModule implements OnModuleInit {
  private readonly logger = new Logger('Idp');

  /**
   * 建两张新表（幂等）。
   *
   * ⚠️ 通用 CRUD（`GenericCrudModule.registerAll`）**只生成路由、不建表** ——
   *    建表必须模块自己做，否则 /idp-configs 上线即 500。
   *
   * 字段类型：1 = 文本，2 = 数字，18 = 关联（关联字段的**值**是 id 数组，
   * 与归属人映射表同处理 —— 建表类型用 1，读写都靠 JSONB 数组承载）。
   */
  async onModuleInit(): Promise<void> {
    const sql = getSqlStore();
    if (!sql) {
      this.logger.warn('[idp] 未配置 DATABASE_URL，跳过 IDP 两张新表的建表');
      return;
    }
    try {
      await sql.ensureTable(TABLES.idpConfig.tableId, 'IDP配置', [
        { name: '配置名称', type: 1 },
        { name: '学年', type: 1 },
        { name: '学期', type: 1 },
        { name: '状态', type: 1 },
        { name: '学生范围', type: 1 },
        { name: '说明', type: 1 },
        { name: '创建人', type: 1 },
        { name: '创建时间', type: 2 },
      ]);
      await sql.ensureTable(TABLES.idpStudent.tableId, 'IDP学生', [
        { name: '所属配置', type: 1 },
        { name: '学生', type: 1 },
        { name: '学生姓名', type: 1 },
        { name: '班级', type: 1 },
        { name: '当前年级', type: 1 },
        { name: 'IDP老师', type: 1 },
        { name: '状态', type: 1 },
        { name: '备注', type: 1 },
        { name: '沟通次数', type: 2 },
        { name: '最近沟通时间', type: 2 },
        { name: '最近沟通摘要', type: 1 },
      ]);
      this.logger.log('[idp] IDP配置 / IDP学生 两张表已就绪');
    } catch (e) {
      // 建表失败不阻断启动：/idp-configs 会报错，其余功能不受影响
      this.logger.error(`[idp] 建表失败: ${(e as Error).message}`);
    }
  }
}
