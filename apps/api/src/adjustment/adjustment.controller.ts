import { Controller, Get, Post, Put, Delete, Param, Query, Body, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { SessionUser } from '@acms/contracts';
import { SessionGuard } from '../auth/session.guard.js';
import { AdjustmentService } from './adjustment.service.js';
import { CreateAdjustmentDto, UpdateAdjustmentDto, AdjustmentFilterDto, TransitionDto } from './adjustment.dto.js';

function userOf(req: Request): SessionUser {
  return (req as Request & { user: SessionUser }).user;
}

@Controller('adjustments')
@UseGuards(SessionGuard)
export class AdjustmentController {
  constructor(private readonly svc: AdjustmentService) {}

  @Get() list(@Req() req: Request, @Query() q: AdjustmentFilterDto) { return this.svc.list(userOf(req), q); }
  @Get(':id') detail(@Req() req: Request, @Param('id') id: string) { return this.svc.detail(userOf(req), id); }
  @Post() create(@Req() req: Request, @Body() dto: CreateAdjustmentDto) { return this.svc.create(userOf(req), dto); }
  @Put(':id') update(@Req() req: Request, @Param('id') id: string, @Body() dto: UpdateAdjustmentDto) { return this.svc.update(userOf(req), id, dto); }
  @Delete(':id') archive(@Req() req: Request, @Param('id') id: string) { return this.svc.archive(userOf(req), id); }
  @Post(':id/transition') transition(@Req() req: Request, @Param('id') id: string, @Body() dto: TransitionDto) { return this.svc.transition(userOf(req), id, dto); }
}
