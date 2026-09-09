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
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { SessionGuard } from '../auth/session.guard.js';
import { FileStorageService } from '../file-storage/file-storage.service.js';
import { HomepageConfigService } from './homepage-config.service.js';
import type { HomepageConfigDto } from './homepage-config.dto.js';
import type { NavMenuConfig, NavMenuGroupConfig, NoteConvertConfig } from '@acms/contracts';

@Controller('homepage-config')
export class HomepageConfigController {
  constructor(
    private readonly service: HomepageConfigService,
    private readonly storage: FileStorageService,
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

  /** 公开图片代理：登录页需展示上传的 logo / 背景图（本地存储直接读盘，无需外部凭据） */
  @Get('image/:token')
  async image(@Param('token') token: string, @Res() res: Response) {
    if (!token || token.length < 10) {
      throw new HttpException('INVALID_FILE_TOKEN', HttpStatus.BAD_REQUEST);
    }
    if (!FileStorageService.isLocal(token)) {
      throw new HttpException('LEGACY_FILE_TOKEN', HttpStatus.NOT_FOUND);
    }
    const f = await this.storage.read(token);
    if (!f) throw new HttpException('FILE_NOT_FOUND', HttpStatus.NOT_FOUND);
    res.setHeader('Content-Type', f.mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.status(200).end(f.buffer);
  }
}
