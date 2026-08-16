import { Controller, Get, Post, Put, Delete, Param, Query, Body, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { SessionUser } from '@acms/contracts';
import { SessionGuard } from '../auth/session.guard.js';
import { TeacherService } from './teacher.service.js';
import { CreateTeacherDto, UpdateTeacherDto, TeacherFilterDto } from './teacher.dto.js';

@Controller('teachers')
@UseGuards(SessionGuard)
export class TeacherController {
  constructor(private readonly svc: TeacherService) {}

  private user(req: Request): SessionUser {
    return (req as Request & { user: SessionUser }).user;
  }

  @Get()
  list(@Req() req: Request, @Query() q: TeacherFilterDto) {
    return this.svc.list(this.user(req), q);
  }

  @Get(':id')
  detail(@Req() req: Request, @Param('id') id: string) {
    return this.svc.detail(this.user(req), id);
  }

  @Post()
  create(@Req() req: Request, @Body() dto: CreateTeacherDto) {
    return this.svc.create(this.user(req), dto);
  }

  @Put(':id')
  update(@Req() req: Request, @Param('id') id: string, @Body() dto: UpdateTeacherDto) {
    return this.svc.update(this.user(req), id, dto);
  }

  @Delete(':id')
  archive(@Req() req: Request, @Param('id') id: string) {
    return this.svc.archive(this.user(req), id);
  }
}
