import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { SessionUser } from '@acms/contracts';
import { SessionGuard } from '../auth/session.guard.js';
import { ReportsService } from './reports.service.js';

function userOf(req: Request): SessionUser {
  return (req as Request & { user: SessionUser }).user;
}

/**
 * 报表数据接口。
 * 独立权限点 report:read——让「只看报表」不必连带开放学生档案读取权限，
 * 且返回的是脱敏投影（维度真值 + 完整度占位符），不含学生明细。
 */
@Controller('reports')
@UseGuards(SessionGuard)
export class ReportsController {
  constructor(private readonly svc: ReportsService) {}

  @Get('students')
  students(@Req() req: Request) {
    return this.svc.studentRows(userOf(req));
  }

  /** 笔记统计：新增笔记（快照表）+ 转换次数（转换记录表） */
  @Get('notes')
  notes(@Req() req: Request, @Query('from') from?: string, @Query('to') to?: string) {
    return this.svc.notes(userOf(req), { from, to });
  }

  /** 活跃时段统计：登录日志（登录时点）+ 审计日志（写操作） */
  @Get('activity')
  activity(@Req() req: Request, @Query('from') from?: string, @Query('to') to?: string) {
    return this.svc.activity(userOf(req), { from, to });
  }

  /**
   * 联系人去重：疑似同一个人的多条联系人记录。
   * level=strong 只要强证据 / level=likely（默认）强+较可信 / level=all 全部；
   * channel、owner 按「组内任一成员命中」筛选；refresh=1 强制重算（对应页面「重新计算」）。
   */
  @Get('contact-dedup')
  contactDedup(
    @Req() req: Request,
    @Query('level') level?: string,
    @Query('channel') channel?: string,
    @Query('owner') owner?: string,
    @Query('refresh') refresh?: string,
  ) {
    return this.svc.contactDedup(userOf(req), { level, channel, owner, refresh });
  }

  /**
   * 考勤分析：出勤率总览 + 按班级/按年级 + 学生排行 + 按日/周趋势。
   * `class` / `grade` 传的是显示名（班级表「班级名称」/ 学生档案「当前年级」）；
   * 不传 from/to 即全量，传了就是「所见即所选」。权限点同样是 `report:read`。
   */
  @Get('attendance')
  attendance(
    @Req() req: Request,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('class') cls?: string,
    @Query('grade') grade?: string,
  ) {
    return this.svc.attendanceReport(userOf(req), { from, to, class: cls, grade });
  }
}
