import { Controller, Get, Post, HttpException, HttpStatus, Logger, Param, Res, Req, UseGuards, UseInterceptors, UploadedFile, BadRequestException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { SessionGuard } from '../auth/session.guard.js';
import { FileUploadService, decodeOriginalFilename } from './file-upload.service.js';
import { FileStorageService } from '../file-storage/file-storage.service.js';

/**
 * 文件代理下载
 *
 * 浏览器无法给 <img> / <a> 附加 Authorization header，因此附件一律走本站代理：
 * 本地存储（loc_ 前缀）直接读盘返流，无需任何外部凭据。
 *
 * 本端点是全站附件下载的唯一出口（学生照片 / IDP / 家校沟通 / 邮件附件等）。
 * 迁移前遗留的飞书素材标记（非 loc_ 前缀）已全部转为本地文件，遇到即视为失效，返回 404。
 */
@Controller('files')
@UseGuards(SessionGuard)
export class FileController {
  private readonly logger = new Logger('FileController');
  constructor(
    private readonly fileUpload: FileUploadService,
    private readonly storage: FileStorageService,
  ) {}

  @Get(':token')
  async download(@Param('token') token: string, @Res() res: Response) {
    if (!token || token.length < 10) {
      throw new HttpException('INVALID_FILE_TOKEN', HttpStatus.BAD_REQUEST);
    }
    if (!FileStorageService.isLocal(token)) {
      this.logger.warn(`非本地素材标记（迁移前遗留，已失效）token=${token}`);
      throw new HttpException('LEGACY_FILE_TOKEN', HttpStatus.NOT_FOUND);
    }
    const f = await this.storage.read(token);
    if (!f) {
      this.logger.warn(`本地附件不存在 token=${token}`);
      throw new HttpException('FILE_NOT_FOUND', HttpStatus.NOT_FOUND);
    }
    res.status(200);
    res.setHeader('Content-Type', f.mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', this.buildDisposition(token, f.filename, f.mime));
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.end(f.buffer);
  }

  /** 本地附件的 Content-Disposition：图片内联显示，其余按真实文件名下载 */
  private buildDisposition(token: string, filename: string, mime?: string): string {
    if (mime?.startsWith('image/')) return 'inline';
    const name = filename || token;
    return `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
  }

  /**
   * 通用文件上传（家校沟通附件等）：音频 / 文本 / MD 等任意类型。
   * - 落本地磁盘，返回 loc_ 前缀的 file_token；前端自行持久化到业务字段（如 沟通附件清单 JSON）。
   * - 单文件上限 50MB（音频文件较大）。
   */
  @Post('upload')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 50 * 1024 * 1024 } }))
  async upload(@UploadedFile() file: any, @Req() req: Request) {
    if (!file) throw new BadRequestException('NO_FILE');
    try {
      // 优先使用前端单独传的 filename 文本字段（UTF-8 解码正确），
      // 否则回退到 multipart 的 originalname（multer 可能将其误判为 latin1 而乱码）。
      const clientFilename = (req.body as Record<string, unknown>)?.filename;
      const finalName =
        typeof clientFilename === 'string' && clientFilename.trim().length > 0
          ? clientFilename
          : decodeOriginalFilename(file.originalname);
      const { file_token } = await this.fileUpload.uploadFile(file.buffer, finalName, file.mimetype);
      return { ok: true, file_token, name: finalName };
    } catch (e) {
      this.logger.error(`文件上传失败: ${(e as Error).message}`);
      throw new HttpException('FILE_UPLOAD_FAILED', HttpStatus.BAD_GATEWAY);
    }
  }
}
