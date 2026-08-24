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
import { FileUploadService, decodeOriginalFilename } from '../file-upload/file-upload.service.js';

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
    const { file_token } = await this.fileUpload.uploadFile(file.buffer, decodeOriginalFilename(file.originalname), file.mimetype);
    // 更新学生记录的「学生照片」字段
    const user = this.user(req);
    const existing = await this.svc.detail(user, id);
    const currentPhotos = Array.isArray(existing['学生照片']) ? existing['学生照片'] : [];
    const updated = await this.svc.update(user, id, { 学生照片: [...currentPhotos.map((p: any) => ({ file_token: p.file_token ?? p })), { file_token }] as any });
    const newPhoto = (updated['学生照片'] as Array<{ file_token?: string; viewUrl?: string; name?: string }>)?.find((p) => p.file_token === file_token);
    return { ok: true, file_token, viewUrl: newPhoto?.viewUrl, name: newPhoto?.name };
  }

  /** 上传学生附件（证件与文件）：在关联表建记录并双向链接到学生 */
  @Post(':id/attachments')
  @UseInterceptors(FileInterceptor('file'))
  async uploadAttachment(@Req() req: Request, @Param('id') id: string, @UploadedFile() file: any) {
    if (!file) throw new Error('NO_FILE');
    if (file.size > 20 * 1024 * 1024) throw new Error('FILE_TOO_LARGE');
    const safeName = decodeOriginalFilename(file.originalname);
    const { file_token } = await this.fileUpload.uploadFile(file.buffer, safeName, file.mimetype);
    const user = this.user(req);
    const recordId = await this.svc.attachDoc(user, id, file_token, safeName);
    // 双向关联写入后刷新学生记录，换取浏览器可直接访问的临时链接
    const updated = await this.svc.detail(user, id);
    const newAtt = (updated['证件与文件'] as Array<{ file_token?: string; viewUrl?: string; name?: string }>)?.find((a) => a.file_token === file_token);
    return { ok: true, file_token, name: safeName, record_id: recordId, viewUrl: newAtt?.viewUrl };
  }

  /** 获取附件下载 URL */
  @Get(':id/attachment-url')
  async getAttachmentUrl(@Param('id') _id: string, @Query('file_token') fileToken: string) {
    const url = await this.fileUpload.getDownloadUrl(fileToken);
    return { url };
  }

  /** 移除学生附件（从关联表删除对应记录，双向关联自动解除） */
  @Delete(':id/attachments/:file_token')
  @HttpCode(200)
  async removeAttachment(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('file_token') fileToken: string,
  ) {
    return this.svc.removeDoc(this.user(req), id, fileToken);
  }
}
