import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Patch,
  Param,
  Query,
  Body,
  Req,
  UseGuards,
  HttpCode,
  Header,
} from '@nestjs/common';
import type { Request } from 'express';
import type { SessionUser } from '@acms/contracts';
import { SessionGuard } from '../auth/session.guard.js';
import { StudentService } from './student.service.js';
import { CreateStudentDto, UpdateStudentDto, StudentFilterDto, ExportQueryDto } from './student.dto.js';

@Controller('students')
@UseGuards(SessionGuard)
export class StudentController {
  constructor(private readonly svc: StudentService) {}

  private user(req: Request): SessionUser {
    return (req as Request & { user: SessionUser }).user;
  }

  /** 列表：过滤 + 排序 + 分页 + ABAC 行级过滤 */
  @Get()
  list(@Req() req: Request, @Query() q: StudentFilterDto) {
    return this.svc.list(this.user(req), q);
  }

  /** 导出 CSV（脱敏 + 审计 + ABAC export 权限） */
  @Get('export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="students.csv"')
  async export(@Req() req: Request, @Query() q: ExportQueryDto) {
    const { csv, count } = await this.svc.exportCsv(this.user(req), q);
    return csv;
  }

  /** 详情 */
  @Get(':id')
  detail(@Req() req: Request, @Param('id') id: string) {
    return this.svc.detail(this.user(req), id);
  }

  /** 新建 */
  @Post()
  create(@Req() req: Request, @Body() dto: CreateStudentDto) {
    return this.svc.create(this.user(req), dto);
  }

  /** 编辑 */
  @Put(':id')
  update(@Req() req: Request, @Param('id') id: string, @Body() dto: UpdateStudentDto) {
    return this.svc.update(this.user(req), id, dto);
  }

  /** 归档（软删除） */
  @Delete(':id')
  @HttpCode(200)
  archive(@Req() req: Request, @Param('id') id: string) {
    return this.svc.archive(this.user(req), id);
  }

  /** 恢复 */
  @Patch(':id/restore')
  restore(@Req() req: Request, @Param('id') id: string) {
    return this.svc.restore(this.user(req), id);
  }
}
