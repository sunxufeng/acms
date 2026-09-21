import { Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { SessionUser } from '@acms/contracts';
import { SessionGuard } from '../auth/session.guard.js';
import { MeetingRoomService } from './meeting-room.service.js';

/**
 * 会议室助手控制器（组织管理）。
 *
 * 权限分两档（与「部门管理」一致的做法）：
 * - **读**（房间清单 / 可用度 / 找空闲）：`module:meetingRooms:read`
 *   —— 抬 v5 后由 `module:meetingMinutes:read` 继承给 10 个教职工角色（峰哥定「全员可见」）。
 * - **写**（`POST /meeting-rooms/sync`）：`module:meetingRooms:update`，只有系统管理员持有。
 *   ⚠️ 同步会打飞书接口并改写本地表 ⇒ 必须门控，不能只挂 SessionGuard。
 *
 * 路由顺序：本控制器没有带参数的路由（房间 id 走 query 而不是 path），
 * 所以不存在「静态路由被 :id 吃掉」的问题。若以后加 `:roomId`，务必排在静态路由之后。
 */
@Controller('meeting-rooms')
@UseGuards(SessionGuard)
export class MeetingRoomController {
  constructor(private readonly svc: MeetingRoomService) {}

  /**
   * 本地会议室 + 楼栋层级 + 最近同步时间 + 权限开通链接。
   * 页面首屏、楼栋筛选下拉、容量下拉都用它（读本地，不打飞书）。
   */
  @Get('rooms')
  rooms(@Req() req: { user: SessionUser }) {
    return this.svc.listLocal(req.user);
  }

  /** 同步飞书会议室（管理员） */
  @Post('sync')
  sync(@Req() req: { user: SessionUser }) {
    return this.svc.sync(req.user);
  }

  /**
   * 某天的会议室可用度（时间轴数据）。
   * 占用实时查飞书 + 内存缓存 2 分钟；失败时返回 `degraded`（界面必须灰显）。
   */
  @Get('availability')
  availability(
    @Req() req: { user: SessionUser },
    @Query('date') date?: string,
    @Query('levelId') levelId?: string,
    @Query('minCapacity') minCapacity?: string,
  ) {
    return this.svc.availability(req.user, {
      date,
      levelId,
      minCapacity: Number(minCapacity) || 0,
    });
  }

  /**
   * 找空闲会议室（右侧「找空闲助手」）。
   * 判据在服务端（与时间轴同源），前端不重算。
   */
  @Get('find')
  find(
    @Req() req: { user: SessionUser },
    @Query('date') date?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('minCapacity') minCapacity?: string,
    @Query('levelId') levelId?: string,
  ) {
    return this.svc.findFree(req.user, {
      date: date ?? '',
      from: from ?? '',
      to: to ?? '',
      minCapacity: Number(minCapacity) || 0,
      levelId: levelId ?? '',
    });
  }
}
