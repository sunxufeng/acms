import { Controller, Get, Post, Put, Delete, Param, Query, Body, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { SessionUser } from '@acms/contracts';
import { SessionGuard } from '../auth/session.guard.js';
import { SettlementService } from './settlement.service.js';
import { CreateSettlementDto, UpdateSettlementDto, SettlementFilterDto, TransitionDto, AggregateSettlementDto } from './settlement.dto.js';

function userOf(req: Request): SessionUser {
  return (req as Request & { user: SessionUser }).user;
}

@Controller('settlements')
@UseGuards(SessionGuard)
export class SettlementController {
  constructor(private readonly svc: SettlementService) {}

  @Get() list(@Req() req: Request, @Query() q: SettlementFilterDto) { return this.svc.list(userOf(req), q); }
  @Get(':id') detail(@Req() req: Request, @Param('id') id: string) { return this.svc.detail(userOf(req), id); }
  @Post() create(@Req() req: Request, @Body() dto: CreateSettlementDto) { return this.svc.create(userOf(req), dto); }
  @Post('aggregate') aggregate(@Req() req: Request, @Body() dto: AggregateSettlementDto) { return this.svc.aggregate(userOf(req), dto); }
  @Put(':id') update(@Req() req: Request, @Param('id') id: string, @Body() dto: UpdateSettlementDto) { return this.svc.update(userOf(req), id, dto); }
  @Delete(':id') archive(@Req() req: Request, @Param('id') id: string) { return this.svc.archive(userOf(req), id); }
  @Post(':id/transition') transition(@Req() req: Request, @Param('id') id: string, @Body() dto: TransitionDto) { return this.svc.transition(userOf(req), id, dto); }
}
