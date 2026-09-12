import { Controller, Get, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { SessionUser } from '@acms/contracts';
import { authorize } from '@acms/domain';
import { HttpException, HttpStatus } from '@nestjs/common';
import { SessionGuard } from '../auth/session.guard.js';
import { WeilingService } from './weiling.service.js';

/** 卫瓴联系人：只读。刻意不提供 create / update / delete，接口层就没有写入能力。 */
@UseGuards(SessionGuard)
@Controller('weiling')
export class WeilingController {
  constructor(@Inject(WeilingService) private readonly svc: WeilingService) {}

  private static requireRead(user: SessionUser): void {
    if (!authorize({ roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel }, 'weiling:read').allowed) {
      throw new HttpException('FORBIDDEN:weiling:read', HttpStatus.FORBIDDEN);
    }
  }

  /** 字段描述（中文名 + 枚举选项），前端用它渲染详情与翻译自定义字段 */
  @Get('fields')
  fields(@Req() req: Request, @Query('refresh') refresh?: string) {
    WeilingController.requireRead((req as Request & { user: SessionUser }).user);
    return this.svc.fields(refresh === '1');
  }

  @Get('sync-status')
  syncStatus(@Req() req: Request) {
    WeilingController.requireRead((req as Request & { user: SessionUser }).user);
    return { ...this.svc.syncStatus(), progress: this.svc.progressStatus() };
  }

  /** 招生分析（报表用）：多维度聚合，支持按人/渠道/阶段/时间筛选 */
  @Get('analyze')
  analyze(
    @Req() req: Request,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('owner') owner?: string,
    @Query('channel') channel?: string,
    @Query('stage') stage?: string,
  ) {
    WeilingController.requireRead((req as Request & { user: SessionUser }).user);
    return this.svc.analyze({ from, to, 归属人: owner, 来源渠道: channel, 客户阶段: stage });
  }

  /** 某个联系人的跟进记录（详情页内嵌展示，按时间倒序） */
  @Get('progress')
  progress(@Req() req: Request, @Query('contactId') contactId?: string) {
    WeilingController.requireRead((req as Request & { user: SessionUser }).user);
    return this.svc.progressOf(String(contactId ?? ''));
  }

  /** 后台同步跟进记录（量很大，异步执行；用 sync-status 看进度） */
  @Post('sync-progress')
  syncProgress(@Req() req: Request, @Query('full') full?: string) {
    const user = (req as Request & { user: SessionUser }).user;
    if (!authorize({ roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel }, 'weiling:sync').allowed) {
      throw new HttpException('FORBIDDEN:weiling:sync', HttpStatus.FORBIDDEN);
    }
    return this.svc.syncProgress(full !== '0');
  }

  /** 重算与 ACMS 学生档案的疑似匹配（不访问上游，只扫本地库） */
  @Post('match')
  match(@Req() req: Request) {
    const user = (req as Request & { user: SessionUser }).user;
    if (!authorize({ roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel }, 'weiling:sync').allowed) {
      throw new HttpException('FORBIDDEN:weiling:sync', HttpStatus.FORBIDDEN);
    }
    return this.svc.matchStudents();
  }

  /** 手动触发同步（会真实拉取上游，限管理员：weiling:sync） */
  @Post('sync')
  sync(@Req() req: Request, @Query('full') full?: string) {
    const user = (req as Request & { user: SessionUser }).user;
    if (!authorize({ roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel }, 'weiling:sync').allowed) {
      throw new HttpException('FORBIDDEN:weiling:sync', HttpStatus.FORBIDDEN);
    }
    return this.svc.syncAll(full !== '0');
  }
}
