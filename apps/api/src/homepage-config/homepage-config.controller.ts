import {
  Controller,
  Get,
  Put,
  Body,
  Param,
  Req,
  Res,
  UseGuards,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Logger,
  Inject,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { DataStore } from '@acms/base-adapter';
import { SessionGuard } from '../auth/session.guard.js';
import { BASE_CLIENT } from '../base.provider.js';
import { FileUploadService } from '../file-upload/file-upload.service.js';
import { resolveBitablePermContext } from '../file-upload/bitable-perm.util.js';
import { FileStorageService } from '../file-storage/file-storage.service.js';
import { HomepageConfigService } from './homepage-config.service.js';
import type { HomepageConfigDto } from './homepage-config.dto.js';
import type { NavMenuConfig, NavMenuGroupConfig, NoteConvertConfig } from '@acms/contracts';

@Controller('homepage-config')
export class HomepageConfigController {
  private readonly logger = new Logger('HomepageConfigController');

  /** bitablePerm 权限上下文（懒加载：系统配置表首条记录 + logo素材 附件字段） */
  private bitableContext: Promise<{ recordId: string; fieldId: string; realTableId: string }> | null = null;

  private async getBitableContext(): Promise<{ recordId: string; fieldId: string; realTableId: string }> {
    if (!this.bitableContext) {
      this.bitableContext = (async () => {
        // 与 /api/v1/files 共用同一套 bitablePerm 上下文解析（单一真源）
        const ctx = await resolveBitablePermContext(this.base, (m) => this.logger.warn(m));
        this.logger.log(
          `bitableContext resolved: rec=${ctx.recordId} field=${ctx.fieldId} realTable=${ctx.tableId}`,
        );
        return { recordId: ctx.recordId, fieldId: ctx.fieldId, realTableId: ctx.tableId };
      })();
    }
    return this.bitableContext;
  }

  constructor(
    private readonly service: HomepageConfigService,
    private readonly fileUpload: FileUploadService,
    private readonly storage: FileStorageService,
    @Inject(BASE_CLIENT) private readonly base: DataStore,
  ) {}

  /** 公开读取：登录页未登录时必须能拿到配置 */
  @Get()
  async getConfig() {
    return this.service.get();
  }

  /** 保存：仅系统管理员 */
  @Put()
  @UseGuards(SessionGuard)
  async saveConfig(@Body() dto: HomepageConfigDto, @Req() req: Request) {
    const user = (req as Request & { user?: { roles?: string[] } }).user;
    if (!user?.roles?.includes('系统管理员')) {
      throw new ForbiddenException('ADMIN_ONLY');
    }
    return this.service.save(dto);
  }

  /** 公开读取导航菜单（登录后渲染侧边栏需要） */
  @Get('menu')
  async getMenuConfig() {
    return this.service.getMenu();
  }

  /** 保存导航菜单：仅系统管理员 */
  @Put('menu')
  @UseGuards(SessionGuard)
  async saveMenuConfig(@Body() dto: NavMenuConfig, @Req() req: Request) {
    const user = (req as Request & { user?: { roles?: string[] } }).user;
    if (!user?.roles?.includes('系统管理员')) {
      throw new ForbiddenException('ADMIN_ONLY');
    }
    return this.service.saveMenu(dto);
  }

  /** 公开读取菜单分组（菜单管理下拉使用） */
  @Get('menu-groups')
  async getMenuGroups() {
    return this.service.getMenuGroups();
  }

  /** 保存菜单分组：仅系统管理员 */
  @Put('menu-groups')
  @UseGuards(SessionGuard)
  async saveMenuGroups(@Body() dto: NavMenuGroupConfig, @Req() req: Request) {
    const user = (req as Request & { user?: { roles?: string[] } }).user;
    if (!user?.roles?.includes('系统管理员')) {
      throw new ForbiddenException('ADMIN_ONLY');
    }
    return this.service.saveMenuGroups(dto);
  }

  /** 读取笔记转换配置（笔记列表的「转换」按钮需要知道哪些模块启用了） */
  @Get('note-convert')
  async getNoteConvert() {
    return this.service.getNoteConvert();
  }

  /** 保存笔记转换配置：仅系统管理员 */
  @Put('note-convert')
  @UseGuards(SessionGuard)
  async saveNoteConvert(@Body() dto: NoteConvertConfig, @Req() req: Request) {
    const user = (req as Request & { user?: { roles?: string[] } }).user;
    if (!user?.roles?.includes('系统管理员')) {
      throw new ForbiddenException('ADMIN_ONLY');
    }
    return this.service.saveNoteConvert(dto);
  }

  /** 公开图片代理：登录页需展示上传的 logo / 背景图
   *  多维表格开启高级权限后，downloadFile 直连会返回 400；
   *  改用 getTmpDownloadUrl 通过 bitablePerm 换取预签名 CDN URL 后服务端中转。 */
  @Get('image/:token')
  async image(@Param('token') token: string, @Res() res: Response) {
    if (!token || token.length < 10) {
      throw new HttpException('INVALID_FILE_TOKEN', HttpStatus.BAD_REQUEST);
    }
    try {
      // 本地存储（云盘内化）：直接读盘返流，不再依赖飞书 token
      if (FileStorageService.isLocal(token)) {
        const f = await this.storage.read(token);
        if (!f) throw new HttpException('FILE_NOT_FOUND', HttpStatus.NOT_FOUND);
        res.setHeader('Content-Type', f.mime || 'application/octet-stream');
        res.setHeader('Content-Disposition', 'inline');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.status(200).end(f.buffer);
        return;
      }

      // 用系统配置表作为 bitablePerm 权限上下文（素材上传时 parent_node 即为此 Bitable）
      const ctx = await this.getBitableContext();
      const tmpUrl = await this.fileUpload.resolveDownloadUrl(token, {
        tableId: ctx.realTableId,
        recordId: ctx.recordId,
        fieldId: ctx.fieldId,
      });
      const upstream = await fetch(tmpUrl);
      if (!upstream.ok) throw new Error(`UPSTREAM_${upstream.status}`);
      const contentType = upstream.headers.get('content-type');
      if (contentType) res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', 'inline');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.status(200).end(buf);
    } catch (e) {
      // 本地分支抛出的 HttpException（如 FILE_NOT_FOUND）保持原语义，不要被包装成 502
      if (e instanceof HttpException) throw e;
      this.logger.error(`主页图片代理失败 token=${token}: ${(e as Error).message}`);
      throw new HttpException('IMAGE_PROXY_FAILED', HttpStatus.BAD_GATEWAY);
    }
  }
}
