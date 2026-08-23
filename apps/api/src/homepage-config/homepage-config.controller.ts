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

@Controller('homepage-config')
export class HomepageConfigController {
  private readonly logger = new Logger('HomepageConfigController');

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

  /** 公开图片代理：登录页需展示上传的 logo / 背景图 */
  @Get('image/:token')
  async image(@Param('token') token: string, @Res() res: Response) {
    if (!token || token.length < 10) {
      throw new HttpException('INVALID_FILE_TOKEN', HttpStatus.BAD_REQUEST);
    }
    try {
      const upstream = await this.fileUpload.downloadFile(token);
      const contentType = upstream.headers.get('content-type');
      if (contentType) res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', 'inline');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.status(upstream.status);

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
      this.logger.error(`主页图片代理失败 token=${token}: ${(e as Error).message}`);
      throw new HttpException('IMAGE_PROXY_FAILED', HttpStatus.BAD_GATEWAY);
    }
  }
}
