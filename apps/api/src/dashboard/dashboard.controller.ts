import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { SessionUser } from '@acms/contracts';
import { SessionGuard } from '../auth/session.guard.js';
import { DashboardService } from './dashboard.service.js';
import { SearchQueryDto } from './dashboard.dto.js';

function userOf(req: Request): SessionUser {
  return (req as Request & { user: SessionUser }).user;
}

@Controller('dashboard')
@UseGuards(SessionGuard)
export class DashboardController {
  constructor(private readonly svc: DashboardService) {}

  @Get('metrics') metrics(@Req() req: Request) { return this.svc.metrics(userOf(req)); }
}

@Controller('search')
@UseGuards(SessionGuard)
export class SearchController {
  constructor(private readonly svc: DashboardService) {}

  @Get() search(@Req() req: Request, @Query() q: SearchQueryDto) { return this.svc.search(userOf(req), q); }
}
