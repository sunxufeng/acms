import { Controller, Get, Post, Put, Delete, Param, Query, Body, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { SessionUser } from '@acms/contracts';
import { SessionGuard } from '../auth/session.guard.js';
import { BillingService } from './billing.service.js';
import { CreateBillingDto, UpdateBillingDto, BillingFilterDto, TransitionDto, GenerateBillingDto } from './billing.dto.js';

function userOf(req: Request): SessionUser {
  return (req as Request & { user: SessionUser }).user;
}

@Controller('billing')
@UseGuards(SessionGuard)
export class BillingController {
  constructor(private readonly svc: BillingService) {}

  @Get() list(@Req() req: Request, @Query() q: BillingFilterDto) { return this.svc.list(userOf(req), q); }
  @Get(':id') detail(@Req() req: Request, @Param('id') id: string) { return this.svc.detail(userOf(req), id); }
  @Post() create(@Req() req: Request, @Body() dto: CreateBillingDto) { return this.svc.create(userOf(req), dto); }
  @Post('generate') generate(@Req() req: Request, @Body() dto: GenerateBillingDto) { return this.svc.generate(userOf(req), dto); }
  @Put(':id') update(@Req() req: Request, @Param('id') id: string, @Body() dto: UpdateBillingDto) { return this.svc.update(userOf(req), id, dto); }
  @Delete(':id') archive(@Req() req: Request, @Param('id') id: string) { return this.svc.archive(userOf(req), id); }
  @Post(':id/transition') transition(@Req() req: Request, @Param('id') id: string, @Body() dto: TransitionDto) { return this.svc.transition(userOf(req), id, dto); }
}
