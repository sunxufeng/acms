import { Body, Controller, ForbiddenException, Get, NotFoundException, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { archiveJobScheduleText, validateArchiveJob, type SessionUser } from '@acms/contracts';
import { SessionGuard } from '../auth/session.guard.js';
import { NoteArchiveService } from './note-archive.service.js';

/**
 * 笔记归档到飞书云盘（2026-09-22）。
 *
 * 只给系统管理员：这条链路会把**未脱敏的笔记原文**写进云盘，
 * 且目标文件夹的可见范围由云盘权限决定（不是 ACMS 的角色/行级）。
 *
 * 任务本身的增删改走**通用 CRUD**（菜单「定时任务」，路径 `/scheduled-tasks`）；
 * 这里只提供「跑起来」与「看状态」的入口：
 *  `jobs`（任务 + 各自进度）、`status`（进度）、`check`（体检）、
 *  `jobs/:id/run`（手动跑）、`jobs/:id/reset`（清该任务的归档记录 = 补归档）。
 */
@Controller('note-archive')
@UseGuards(SessionGuard)
export class NoteArchiveController {
  constructor(private readonly svc: NoteArchiveService) {}

  private admin(req: Request): SessionUser {
    const user = (req as Request & { user: SessionUser }).user;
    if (!user?.roles?.includes('系统管理员')) throw new ForbiddenException('FORBIDDEN:admin');
    return user;
  }

  /** 任务清单（读任务表）+ 各自最近一次进度 —— 页面刷新时一起拿 */
  @Get('jobs')
  async jobs(@Req() req: Request) {
    this.admin(req);
    const defs = await this.svc.loadJobs();
    const progress = this.svc.status();
    return {
      jobs: defs.map((j) => ({
        id: j.key,
        label: j.label,
        enabled: j.enabled,
        schedule: archiveJobScheduleText(j),
        kinds: [...j.kinds],
        rootFolderToken: j.rootFolderToken,
        titleMustInclude: j.titleMustInclude,
        groupByOwner: j.groupByOwner,
        problems: validateArchiveJob(j),
        progress: progress[j.key] ?? null,
      })),
    };
  }

  @Get('status')
  status(@Req() req: Request) {
    this.admin(req);
    return this.svc.status();
  }

  /** 体检：令牌 + 每个任务的目标文件夹可达性 + 待归档量 + **配置问题**（手动跑之前先看这个） */
  @Get('check')
  check(@Req() req: Request) {
    this.admin(req);
    return this.svc.check();
  }

  /**
   * 手动跑一次。`limit` 用于分批（比如先跑 50 篇看看效果）。
   * ⚠️ 停用的任务**也能手动跑** —— 手动就是要立刻跑一次，停用只约束定时器。
   */
  @Post('jobs/:id/run')
  async run(@Req() req: Request, @Param('id') id: string, @Body() body: { limit?: number }) {
    this.admin(req);
    const job = await this.svc.findJob(String(id));
    if (!job) throw new NotFoundException('NOT_FOUND:job');
    const limit = Number(body?.limit ?? 0) || 0;
    return this.svc.start(job, { limit, trigger: 'manual' });
  }

  /**
   * 清掉该任务的归档记录（「补归档」）。
   *
   * 什么时候要它：**目标文件夹换过之后** —— 归档记录会让同批笔记在新文件夹里
   * 永远不再出现（判据是记录，不是云盘里有没有文件）。
   * `run: true` 时清完立刻跑一次，省一次点击。
   * ⚠️ 只删记录、**不动云盘上的文件**（旧文件夹里的东西原样留着）。
   */
  @Post('jobs/:id/reset')
  async reset(@Req() req: Request, @Param('id') id: string, @Body() body: { run?: boolean; limit?: number }) {
    this.admin(req);
    const job = await this.svc.findJob(String(id));
    if (!job) throw new NotFoundException('NOT_FOUND:job');
    const cleared = await this.svc.clearRecords(job.key);
    if (body?.run === false) return { cleared: cleared.removed, progress: null };
    const limit = Number(body?.limit ?? 0) || 0;
    return { cleared: cleared.removed, progress: this.svc.start(job, { limit, trigger: 'manual' }) };
  }
}
