import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { SessionGuard } from '../auth/session.guard.js';
import { authorize } from '@acms/domain';
import type { SessionUser } from '@acms/contracts';
import { SystemMonitorService } from './system-monitor.service.js';

/**
 * 系统监控：主机 / 应用 / 依赖 / 服务 / 备份 / 错误 六分区快照。
 *
 * 需要 `admin:monitor` 权限（默认只有系统管理员有）—— 内存、负载、服务状态、
 * 日志都属于运维敏感信息，不能对全员开放。
 */
@Controller('system')
@UseGuards(SessionGuard)
export class SystemMonitorController {
  constructor(private readonly svc: SystemMonitorService) {}

  @Get('status')
  async status(@Req() req: Request) {
    const user = (req as Request & { user: SessionUser }).user;
    if (
      !authorize(
        { roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel },
        'admin:monitor',
      ).allowed
    ) {
      return { statusCode: 403, message: 'FORBIDDEN:admin:monitor' };
    }
    return this.svc.status();
  }
}
