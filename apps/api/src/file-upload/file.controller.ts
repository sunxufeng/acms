import { Controller, Get, HttpException, HttpStatus, Logger, Param, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { SessionGuard } from '../auth/session.guard.js';
import { FileUploadService } from './file-upload.service.js';

/**
 * 文件代理下载
 *
 * 浏览器无法给 <img> / <a> 附加 Authorization header，直接访问飞书
 * `/drive/v1/medias/:token/download` 会报 99991661（缺少 token）。
 * 此接口用后端 tenant_access_token 取回文件并透传，前端改走相对路径即可。
 */
@Controller('files')
@UseGuards(SessionGuard)
export class FileController {
  private readonly logger = new Logger('FileController');
  constructor(private readonly fileUpload: FileUploadService) {}

  @Get(':token')
  async download(@Param('token') token: string, @Res() res: Response) {
    if (!token || token.length < 10) {
      throw new HttpException('INVALID_FILE_TOKEN', HttpStatus.BAD_REQUEST);
    }
    try {
      const upstream = await this.fileUpload.downloadFile(token);

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
      this.logger.error(`文件下载失败 token=${token}: ${(e as Error).message}`);
      throw new HttpException('FILE_DOWNLOAD_FAILED', HttpStatus.BAD_GATEWAY);
    }
  }
}
