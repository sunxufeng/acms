import { Body, Controller, ForbiddenException, Get, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { NOTE_ARCHIVE_JOBS, type NoteArchiveJobKey, type SessionUser } from '@acms/contracts';
import { SessionGuard } from '../auth/session.guard.js';
import { NoteArchiveService } from './note-archive.service.js';

/**
 * 笔记归档到飞书云盘（2026-09-22）。
 *
 * 只给系统管理员：这条链路会把**未脱敏的笔记原文**写进云盘，
 * 且两个目标文件夹的可见范围由云盘权限决定（不是 ACMS 的角色/行级）。
 *
 * 三个入口：`status`（看进度）、`check`（体检：令牌 + 文件夹 + 待归档量）、
 * `run`（手动跑一次，支持 `limit` —— 首次全量可以分批跑，跑不完的第二天继续）。
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

  /** 两个任务的定义（时间 / 目标文件夹 / 标题过滤）—— 前端或排查时看的口径 */
  @Get('jobs')
  jobs(@Req() req: Request) {
    this.admin(req);
    return Object.values(NOTE_ARCHIVE_JOBS).map((j) => ({
      key: j.key,
      label: j.label,
      time: `${String(j.hour).padStart(2, '0')}:${String(j.minute).padStart(2, '0')}`,
      rootFolderToken: j.rootFolderToken,
      titleMustInclude: j.titleMustInclude,
    }));
  }

  /** 最近一次（两个任务各自的）进度 */
  @Get('status')
  status(@Req() req: Request) {
    this.admin(req);
    return this.svc.status();
  }

  /** 体检：用户令牌能不能用、目标文件夹可达吗、还有多少待归档 —— **手动跑之前先看这个** */
  @Get('check')
  check(@Req() req: Request) {
    this.admin(req);
    return this.svc.check();
  }

  /** 手动跑一次（默认按任务全量；`limit` 用于分批，比如首次先跑 50 篇看看效果） */
  @Post('run')
  run(@Req() req: Request, @Body() body: { job?: string; limit?: number }) {
    this.admin(req);
    const key = String(body?.job ?? 'all') as NoteArchiveJobKey;
    if (!NOTE_ARCHIVE_JOBS[key]) throw new ForbiddenException('BAD_JOB:job 只能是 idp / all');
    const limit = Number(body?.limit ?? 0) || 0;
    return this.svc.start(key, { limit, trigger: 'manual' });
  }
}
