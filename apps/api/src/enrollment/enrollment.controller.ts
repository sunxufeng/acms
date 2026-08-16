import { Controller, Get, Post, Put, Delete, Param, Query, Body, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { SessionUser } from '@acms/contracts';
import { SessionGuard } from '../auth/session.guard.js';
import { EnrollmentService } from './enrollment.service.js';
import { CreateEnrollmentDto, UpdateEnrollmentDto, EnrollmentFilterDto } from './enrollment.dto.js';

function userOf(req: Request): SessionUser {
  return (req as Request & { user: SessionUser }).user;
}

@Controller('enrollments')
@UseGuards(SessionGuard)
export class EnrollmentController {
  constructor(private readonly svc: EnrollmentService) {}

  @Get() list(@Req() req: Request, @Query() q: EnrollmentFilterDto) { return this.svc.list(userOf(req), q); }
  @Get(':id') detail(@Req() req: Request, @Param('id') id: string) { return this.svc.detail(userOf(req), id); }
  @Post() create(@Req() req: Request, @Body() dto: CreateEnrollmentDto) { return this.svc.create(userOf(req), dto); }
  @Put(':id') update(@Req() req: Request, @Param('id') id: string, @Body() dto: UpdateEnrollmentDto) { return this.svc.update(userOf(req), id, dto); }
  @Delete(':id') archive(@Req() req: Request, @Param('id') id: string) { return this.svc.archive(userOf(req), id); }
  @Post(':id/transition') transition(@Req() req: Request, @Param('id') id: string, @Body() body: { to: string }) {
    return this.svc.transition(userOf(req), id, body.to);
  }
}
