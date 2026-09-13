import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { SessionUser } from '@acms/contracts';
import { SessionGuard } from '../auth/session.guard.js';
import { CurriculumService } from './curriculum.service.js';

/**
 * 课程规划的「专用接口」。
 *
 * 通用 CRUD（由 GenericCrudModule.registerAll 承载，见 curriculum.meta.ts）已覆盖
 * 单元的增删改查；这里只放它表达不了的三类动作：
 *
 *  1. `POST curriculum/unit-classes/:id/deploy` —— 批量生成部署记录（一次写多张表的多行）
 *  2. `GET  curriculum/coverage`               —— 跨表聚合统计，不是单条 CRUD
 *  3. `POST lesson-plans/homework-submissions/recompute-late` —— 按时间关系回写派生字段
 *
 * 路由前缀刻意与 RecordMeta.path 对齐，`moduleByPath` 才能按最长前缀命中 curriculum /
 * lessonPlan 这两个模块资源（鉴权由 service 内的 requireModule 执行）。
 */
@Controller()
@UseGuards(SessionGuard)
export class CurriculumController {
  constructor(private readonly svc: CurriculumService) {}

  /**
   * 部署环节到课次。
   * body.replaceExisting=false 时保留已部署的环节，只补没部署过的。
   */
  @Post('curriculum/unit-classes/:id/deploy')
  deploy(
    @Req() req: { user: SessionUser },
    @Param('id') id: string,
    @Body() body: { replaceExisting?: boolean },
  ) {
    return this.svc.deploy(req.user, id, { replaceExisting: body?.replaceExisting });
  }

  /**
   * 覆盖率统计：按教学班汇总单元数 / 状态分布 / 环节部署数与部署到课次的占比。
   * 可选按课程方案、学年、教学班收窄。
   */
  @Get('curriculum/coverage')
  coverage(
    @Req() req: { user: SessionUser },
    @Query() q: { 课程方案?: string; 学年?: string; 教学班?: string },
  ) {
    return this.svc.coverage(req.user, {
      课程方案: q?.课程方案,
      学年: q?.学年,
      教学班: q?.教学班,
    });
  }

  /**
   * 重算作业迟交（是否迟交 / 迟交分钟数）。
   * dryRun=true 只回结果不写库，用于先确认影响范围。
   */
  @Post('lesson-plans/homework-submissions/recompute-late')
  recomputeLate(
    @Req() req: { user: SessionUser },
    @Body() body: { ids?: string[]; 教学班?: string; dryRun?: boolean },
  ) {
    return this.svc.recomputeLate(req.user, {
      ids: Array.isArray(body?.ids) ? body.ids.map(String).filter(Boolean) : undefined,
      教学班: body?.教学班 ? String(body.教学班) : undefined,
      dryRun: body?.dryRun === true,
    });
  }
}
