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
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { SessionGuard } from '../auth/session.guard.js';
import { FileUploadService } from '../file-upload/file-upload.service.js';
import { HomepageConfigService } from './homepage-config.service.js';
import type { HomepageConfigDto } from './homepage-config.dto.js';
import type { NavMenuConfig, NavMenuGroupConfig } from '@acms/contracts';
import { TABLES } from '@acms/contracts';

@Controller('homepage-config')
export class HomepageConfigController {
  private readonly logger = new Logger('HomepageConfigController');

  /** bitablePerm 权限上下文（懒加载：取系统配置表的第一条记录+第一个字段） */
  private bitableContext: Promise<{ recordId: string; fieldId: string; realTableId: string }> | null = null;

  private async getBitableContext(): Promise<{ recordId: string; fieldId: string; realTableId: string }> {
    if (!this.bitableContext) {
      this.bitableContext = (async () => {
        try {
          // 用代码级 alias 查询（BaseClient 内部会做 TABLE_ID_MAP 映射）
          const tableId = TABLES.systemConfig.tableId;
          const records = await this.service.listRecords(tableId, 1);
          const fields = await this.service.listFields(tableId);
          // listFields 返回的记录包含真实 recordId（来自飞书响应）
          const recId = records[0]?.recordId ?? '';
          const fldId = fields[0]?.id ?? '';
          // 真实 tableId：从 listRecords 的数据中无法直接拿到，
          // 但可以通过 TABLE_ID_MAP 环境变量解析
          const realTableId = resolveRealTableId(tableId);
          this.logger.log(`bitableContext resolved: rec=${recId} field=${fldId} realTable=${realTableId}`);
          return { recordId: recId, fieldId: fldId, realTableId };
        } catch (e) {
          this.logger.warn(`bitableContext fallback: ${(e as Error).message}`);
          return { recordId: '', fieldId: '', realTableId: '' };
        }
      })();
    }
    return this.bitableContext;
  }

  constructor(
    private readonly service: HomepageConfigService,
    private readonly fileUpload: FileUploadService,
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

  /** 公开图片代理：登录页需展示上传的 logo / 背景图
   *  多维表格开启高级权限后，downloadFile 直连会返回 400；
   *  改用 getTmpDownloadUrl 通过 bitablePerm 换取预签名 CDN URL 后服务端中转。 */
  @Get('image/:token')
  async image(@Param('token') token: string, @Res() res: Response) {
    if (!token || token.length < 10) {
      throw new HttpException('INVALID_FILE_TOKEN', HttpStatus.BAD_REQUEST);
    }
    try {
      // 用系统配置表作为 bitablePerm 权限上下文（素材上传时 parent_node 即为此 Bitable）
      const ctx = await this.getBitableContext();
      const tmpUrl = await this.fileUpload.getTmpDownloadUrl(
        token,
        ctx.realTableId,
        ctx.recordId,
        ctx.fieldId,
      );
      const upstream = await fetch(tmpUrl);
      if (!upstream.ok) throw new Error(`UPSTREAM_${upstream.status}`);
      const contentType = upstream.headers.get('content-type');
      if (contentType) res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', 'inline');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.status(200).end(buf);
    } catch (e) {
      this.logger.error(`主页图片代理失败 token=${token}: ${(e as Error).message}`);
      throw new HttpException('IMAGE_PROXY_FAILED', HttpStatus.BAD_GATEWAY);
    }
  }
}

/** 解析 TABLE_ID_MAP 环境变量，将代码级 tableId 别名映射为真实飞书表 ID */
function resolveRealTableId(alias: string): string {
  try {
    const raw = process.env.TABLE_ID_MAP;
    if (!raw) return alias;
    const map = JSON.parse(raw) as Record<string, string>;
    return map[alias] ?? alias;
  } catch {
    return alias;
  }
}
