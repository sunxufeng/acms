import { Body, Controller, Delete, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { SessionUser } from '@acms/contracts';
import { SessionGuard } from '../auth/session.guard.js';
import { requireModule } from '../shared/require-module.js';
import { MarkbookService } from './markbook.service.js';
import { HomeworkSyncService } from './homework-sync.service.js';

/**
 * 成绩册的「专用接口」。
 *
 * 通用 CRUD（columns / entries / targets 三张表）由 `GenericCrudModule.registerAll(MARKBOOK_METAS)`
 * 承载；这里放它表达不了的动作：
 *
 *  1. `GET  markbook/classes`      —— 可选班级列表（学生档案「当前班级」聚合，附带列数/条目数）
 *  2. `GET  markbook/grid`         —— 一次取回整个网格（列 × 学生 + 单元格 + 加权总评），
 *     二维录入界面要靠它避免 N+1 请求
 *  3. `POST markbook/entries/save` —— 二维录入的主写入口（批量 upsert + 计算等级快照；
 *     传空值 = 删除该条目）
 *  4. `POST markbook/recalc`       —— 用当前等级体系与目标重算既有条目的快照
 *     （改了等级区间或目标之后必须跑一次，条目上的等级是写入时快照，不会自己跟着变）
 *  5. `POST/DELETE markbook/columns[/:id]` —— 列管理（删除列时连同其条目一起删，避免孤儿）
 *  6. `GET  markbook/homework-catalog`      —— 该班可选作业（含完成率 / 已绑定列）
 *  7. `GET  markbook/sync-homework/preview` —— 作业 → 成绩册的**写入预览**（先看清再写）
 *  8. `POST markbook/sync-homework`         —— 执行同步（未完成留空，不写 0）
 *  9. `POST markbook/homework-bind`         —— 绑定 / 解绑「列 ↔ 作业」
 *
 * 权限一律「模块 × 动作」：读 `module:markbook:read`，写 `module:markbook:update`。
 */
@Controller('markbook')
@UseGuards(SessionGuard)
export class MarkbookController {
  constructor(
    private readonly svc: MarkbookService,
    private readonly hw: HomeworkSyncService,
  ) {}

  /** 可选班级（读） */
  @Get('classes')
  classes(@Req() req: { user: SessionUser }) {
    requireModule(req.user, 'markbook', 'read');
    return this.svc.listClasses();
  }

  /** 整个班级的成绩册网格（读） */
  @Get('grid')
  grid(@Req() req: { user: SessionUser }, @Query('cls') cls: string) {
    requireModule(req.user, 'markbook', 'read');
    return this.svc.getGrid(cls ?? '');
  }

  /** 批量保存单元格（写） */
  @Post('entries/save')
  saveEntries(
    @Req() req: { user: SessionUser },
    @Body()
    body: {
      cls?: string;
      rows?: {
        columnId: string;
        studentId: string;
        score: number | string | null;
        comment?: string;
        visibleStudent?: string;
        visibleParent?: string;
      }[];
    },
  ) {
    requireModule(req.user, 'markbook', 'update');
    return this.svc.saveEntries(body?.cls ?? '', body?.rows ?? []);
  }

  /** 重算快照（写） */
  @Post('recalc')
  recalc(@Req() req: { user: SessionUser }, @Body() body: { cls?: string }) {
    requireModule(req.user, 'markbook', 'update');
    return this.svc.recalc(body?.cls ?? '');
  }

  /** 新建 / 更新一列（写） */
  @Post('columns')
  saveColumn(
    @Req() req: { user: SessionUser },
    @Body()
    body: {
      id?: string;
      cls: string;
      name: string;
      type?: string;
      weight?: number;
      fullMark?: number;
      scaleId?: string;
      date?: string;
      desc?: string;
      sort?: number;
      status?: string;
      studentVisible?: string;
      parentVisible?: string;
      completeDate?: string;
    },
  ) {
    requireModule(req.user, 'markbook', 'update');
    return this.svc.saveColumn(body);
  }

  /** 删除一列（连同条目） */
  @Delete('columns/:id')
  deleteColumn(@Req() req: { user: SessionUser }, @Param('id') id: string) {
    requireModule(req.user, 'markbook', 'update');
    return this.svc.deleteColumn(id);
  }

  // ── 作业 ↔ 成绩册联动（2026-09-14）────────────────────────────────────
  // 权限与审计由 HomeworkSyncService 内部统一处理（读 = module:markbook:read，
  // 写 = module:markbook:update + runAs(system:homework-sync)），这里只做参数搬运。

  /** 该班可选作业目录（含完成率与已绑定列），供「选作业」下拉用（读） */
  @Get('homework-catalog')
  homeworkCatalog(@Req() req: { user: SessionUser }, @Query('cls') cls: string) {
    return this.hw.catalog(req.user, cls ?? '');
  }

  /**
   * 预览：本次同步会写入哪几格（学生 / 当前值 / 将写入值 / 原因）。
   * 与 sync 共用同一份计划器，所以「预览到什么」=「写入什么」。批量写成绩不能盲写。
   */
  @Get('sync-homework/preview')
  homeworkPreview(
    @Req() req: { user: SessionUser },
    @Query() q: { cls?: string; homeworkName?: string; columnId?: string; mode?: 'fill-empty' | 'overwrite' },
  ) {
    return this.hw.preview(req.user, q ?? {});
  }

  /** 执行同步：作业完成情况 → 成绩册条目（未完成 / 无提交留空，不写 0） */
  @Post('sync-homework')
  homeworkSync(
    @Req() req: { user: SessionUser },
    @Body() body: { cls?: string; homeworkName?: string; columnId?: string; mode?: 'fill-empty' | 'overwrite' },
  ) {
    return this.hw.sync(req.user, body ?? {});
  }

  /** 绑定 / 解绑「成绩册列 ↔ 作业」（homeworkName 传空 = 解绑） */
  @Post('homework-bind')
  homeworkBind(
    @Req() req: { user: SessionUser },
    @Body() body: { cls?: string; columnId?: string; homeworkName?: string },
  ) {
    return this.hw.bind(req.user, body ?? {});
  }
}
