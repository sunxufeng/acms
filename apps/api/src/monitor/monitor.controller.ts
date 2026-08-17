import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { SessionGuard } from '../auth/session.guard.js';
import { authorize } from '@acms/domain';
import type { SessionUser } from '@acms/contracts';
import { MonitorService } from './monitor.service.js';

/**
 * 监控状态查询（需管理员权限，避免内存/探测信息外泄）。
 * GET /api/v1/monitor/status → 最近一次探测快照（内存、飞书可达性）。
 */
@Controller('monitor')
@UseGuards(SessionGuard)
export class MonitorController {
  constructor(private readonly monitor: MonitorService) {}

  @Get('status')
  status(@Req() req: Request) {
    const user = (req as Request & { user: SessionUser }).user;
    if (!authorize({ roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel }, 'config:read').allowed) {
      return { statusCode: 403, message: 'FORBIDDEN:config:read' };
    }
    return this.monitor.getStatus();
  }
}
