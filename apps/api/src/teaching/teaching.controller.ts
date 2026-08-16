import { Controller, Get, Post, Put, Delete, Param, Query, Body, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { SessionUser } from '@acms/contracts';
import { SessionGuard } from '../auth/session.guard.js';
import { CoursePlanService } from './course-plan.service.js';
import { TeachingClassService } from './teaching-class.service.js';
import {
  CreateCoursePlanDto,
  UpdateCoursePlanDto,
  CoursePlanFilterDto,
  CreateTeachingClassDto,
  UpdateTeachingClassDto,
  TeachingClassFilterDto,
} from './teaching.dto.js';

function userOf(req: Request): SessionUser {
  return (req as Request & { user: SessionUser }).user;
}

@Controller('course-plans')
@UseGuards(SessionGuard)
export class CoursePlanController {
  constructor(private readonly svc: CoursePlanService) {}

  @Get() list(@Req() req: Request, @Query() q: CoursePlanFilterDto) { return this.svc.list(userOf(req), q); }
  @Get(':id') detail(@Req() req: Request, @Param('id') id: string) { return this.svc.detail(userOf(req), id); }
  @Post() create(@Req() req: Request, @Body() dto: CreateCoursePlanDto) { return this.svc.create(userOf(req), dto); }
  @Put(':id') update(@Req() req: Request, @Param('id') id: string, @Body() dto: UpdateCoursePlanDto) { return this.svc.update(userOf(req), id, dto); }
  @Delete(':id') archive(@Req() req: Request, @Param('id') id: string) { return this.svc.archive(userOf(req), id); }
  @Post(':id/transition') transition(@Req() req: Request, @Param('id') id: string, @Body() body: { to: string }) {
    return this.svc.transition(userOf(req), id, body.to);
  }
}

@Controller('teaching-classes')
@UseGuards(SessionGuard)
export class TeachingClassController {
  constructor(private readonly svc: TeachingClassService) {}

  @Get() list(@Req() req: Request, @Query() q: TeachingClassFilterDto) { return this.svc.list(userOf(req), q); }
  @Get(':id') detail(@Req() req: Request, @Param('id') id: string) { return this.svc.detail(userOf(req), id); }
  @Post() create(@Req() req: Request, @Body() dto: CreateTeachingClassDto) { return this.svc.create(userOf(req), dto); }
  @Put(':id') update(@Req() req: Request, @Param('id') id: string, @Body() dto: UpdateTeachingClassDto) { return this.svc.update(userOf(req), id, dto); }
  @Delete(':id') archive(@Req() req: Request, @Param('id') id: string) { return this.svc.archive(userOf(req), id); }
  @Post(':id/transition') transition(@Req() req: Request, @Param('id') id: string, @Body() body: { to: string }) {
    return this.svc.transition(userOf(req), id, body.to);
  }
}
