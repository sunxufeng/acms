import { Controller, Get, Post, Put, Delete, Param, Query, Body, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { SessionUser } from '@acms/contracts';
import { SessionGuard } from '../auth/session.guard.js';
import { PartnershipService } from './partnership.service.js';
import { CreatePartnershipDto, UpdatePartnershipDto, PartnershipFilterDto } from './partnership.dto.js';

function userOf(req: Request): SessionUser {
  return (req as Request & { user: SessionUser }).user;
}

@Controller('partnerships')
@UseGuards(SessionGuard)
export class PartnershipController {
  constructor(private readonly svc: PartnershipService) {}

  @Get() list(@Req() req: Request, @Query() q: PartnershipFilterDto) { return this.svc.list(userOf(req), q); }
  @Get(':id') detail(@Req() req: Request, @Param('id') id: string) { return this.svc.detail(userOf(req), id); }
  @Post() create(@Req() req: Request, @Body() dto: CreatePartnershipDto) { return this.svc.create(userOf(req), dto); }
  @Put(':id') update(@Req() req: Request, @Param('id') id: string, @Body() dto: UpdatePartnershipDto) { return this.svc.update(userOf(req), id, dto); }
  @Delete(':id') archive(@Req() req: Request, @Param('id') id: string) { return this.svc.archive(userOf(req), id); }
}
