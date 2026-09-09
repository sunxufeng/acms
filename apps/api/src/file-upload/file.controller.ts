import { Controller, Get, Post, HttpException, HttpStatus, Logger, Param, Res, Req, UseGuards, UseInterceptors, UploadedFile, BadRequestException, Inject } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import type { DataStore } from '@acms/base-adapter';
import { SessionGuard } from '../auth/session.guard.js';
import { BASE_CLIENT } from '../base.provider.js';
import { FileUploadService, decodeOriginalFilename } from './file-upload.service.js';
import { resolveBitablePermContext } from './bitable-perm.util.js';
import { FileStorageService } from '../file-storage/file-storage.service.js';

/**
 * 文件代理下载
 *
 * 浏览器无法给 <img> / <a> 附加 Authorization header，直接访问飞书
 * `/drive/v1/medias/:token/download` 会报 99991661（缺少 token）。
 * 此接口用后端 tenant_access_token 取回文件并透传，前端改走相对路径即可。
 *
 * ⚠️ 多维表格开启「高级权限」后，仅用 file_token 直连 download 会返回 400，
 * 必须先用 bitablePerm 声明素材归属换取预签名链接再下载（见 bitable-perm.util）。
 * 本端点是全站附件下载的唯一出口（学生照片 / IDP / 家校沟通 / 邮件附件等），
 * 因此修复此处即可恢复所有附件的显示与下载。
 */
@Controller('files')
@UseGuards(SessionGuard)
export class FileController {
  private readonly logger = new Logger('FileController');
  constructor(
    @Inject(BASE_CLIENT) private readonly base: DataStore,
    private readonly fileUpload: FileUploadService,
    private readonly storage: FileStorageService,
  ) {}

  @Get(':token')
  async download(@Param('token') token: string, @Res() res: Response) {
    if (!token || token.length < 10) {
      throw new HttpException('INVALID_FILE_TOKEN', HttpStatus.BAD_REQUEST);
    }
    try {
      // 本地存储（云盘内化）：直接读盘返流，不再依赖飞书 token
      if (FileStorageService.isLocal(token)) {
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
        return;
      }

      // 历史飞书 Drive 文件：高级权限下先用 bitablePerm 换预签名下载链接（直连会 400），再由服务端中转
      const ctx = await resolveBitablePermContext(this.base, (m) => this.logger.warn(m));
      const signedUrl = await this.fileUpload.resolveDownloadUrl(
        token,
        ctx.recordId && ctx.fieldId ? ctx : undefined,
      );
      const upstream = await fetch(signedUrl);

      // 透传状态码与内容类型
      res.status(upstream.status);
      const contentType = upstream.headers.get('content-type');
      if (contentType) res.setHeader('Content-Type', contentType);

      // 飞书通常不返回 content-disposition；图片默认 inline，其他走 attachment
      const upstreamDisp = upstream.headers.get('content-disposition');
      if (upstreamDisp) {
        res.setHeader('Content-Disposition', upstreamDisp);
      } else if (contentType?.startsWith('image/')) {
        res.setHeader('Content-Disposition', 'inline');
      } else {
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(token)}`);
      }

      // 禁用缓存（临时下载链接可能过期）
      res.setHeader('Cache-Control', 'no-store');

      if (upstream.body) {
        const reader = upstream.body.getReader();
        const pump = async (): Promise<void> => {
          const { done, value } = await reader.read();
          if (done) {
            res.end();
            return;
          }
          res.write(Buffer.from(value));
          return pump();
        };
        await pump();
      } else {
        res.end();
      }
    } catch (e) {
      // 本地分支抛出的 HttpException（如 FILE_NOT_FOUND）保持原语义，不要被包装成 502
      if (e instanceof HttpException) throw e;
      this.logger.error(`文件下载失败 token=${token}: ${(e as Error).message}`);
      throw new HttpException('FILE_DOWNLOAD_FAILED', HttpStatus.BAD_GATEWAY);
    }
  }

  /** 本地附件的 Content-Disposition：图片内联显示，其余按真实文件名下载 */
  private buildDisposition(token: string, filename: string, mime?: string): string {
    if (mime?.startsWith('image/')) return 'inline';
    const name = filename || token;
    return `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
  }

  /**
   * 通用文件上传（家校沟通附件等）：音频 / 文本 / MD 等任意类型。
   * - 通过后端 tenant_access_token 写入飞书，返回 file_token；前端自行持久化到业务字段（如 沟通附件清单 JSON）。
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
