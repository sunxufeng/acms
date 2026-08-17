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
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import type { SessionUser } from '@acms/contracts';
import { SessionGuard } from '../auth/session.guard.js';
import { StudentService } from './student.service.js';
import { CreateStudentDto, UpdateStudentDto, StudentFilterDto, ExportQueryDto } from './student.dto.js';
import { FileUploadService } from '../file-upload/file-upload.service.js';

@Controller('students')
@UseGuards(SessionGuard)
export class StudentController {
  constructor(
    private readonly svc: StudentService,
    private readonly fileUpload: FileUploadService,
  ) {}

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

  /** 上传学生照片 */
  @Post(':id/photo')
  @UseInterceptors(FileInterceptor('file'))
  async uploadPhoto(@Req() req: Request, @Param('id') id: string, @UploadedFile() file: any) {
    if (!file) throw new Error('NO_FILE');
    // 限制 5MB
    if (file.size > 5 * 1024 * 1024) throw new Error('FILE_TOO_LARGE');
    const { file_token } = await this.fileUpload.uploadFile(file.buffer, file.originalname, file.mimetype);
    // 更新学生记录的「学生照片」字段
    const user = this.user(req);
    const existing = await this.svc.detail(user, id);
    const currentPhotos = Array.isArray(existing['学生照片']) ? existing['学生照片'] : [];
    await this.svc.update(user, id, { 学生照片: [...currentPhotos.map((p: any) => ({ file_token: p.file_token ?? p })), { file_token }] as any });
    return { ok: true, file_token };
  }

  /** 上传学生附件（证件与文件） */
  @Post(':id/attachments')
  @UseInterceptors(FileInterceptor('file'))
  async uploadAttachment(@Req() req: Request, @Param('id') id: string, @UploadedFile() file: any) {
    if (!file) throw new Error('NO_FILE');
    if (file.size > 20 * 1024 * 1024) throw new Error('FILE_TOO_LARGE');
    const { file_token } = await this.fileUpload.uploadFile(file.buffer, file.originalname, file.mimetype);
    const user = this.user(req);
    const existing = await this.svc.detail(user, id);
    const currentFiles = Array.isArray(existing['证件与文件']) ? existing['证件与文件'] : [];
    await this.svc.update(user, id, { 证件与文件: [...currentFiles.map((f: any) => ({ file_token: f.file_token ?? f })), { file_token, name: file.originalname }] as any });
    return { ok: true, file_token, name: file.originalname };
  }

  /** 获取附件下载 URL */
  @Get(':id/attachment-url')
  async getAttachmentUrl(@Param('id') _id: string, @Query('file_token') fileToken: string) {
    const url = await this.fileUpload.getDownloadUrl(fileToken);
    return { url };
  }
}
