import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import type { SessionUser } from '@acms/contracts';
import { SessionGuard } from './session.guard.js';
import { ApiTokenService, type IssueTokenDto, type UpdateTokenDto } from './api-token.service.js';

/**
 * API 令牌管理接口（2026-09-16）。
 *
 * 给 **CLI / MCP / 脚本**签发长期凭证。三类调用方共用一份实现。
 *
 * ## 三层门禁
 *  1. 登录态（SessionGuard）
 *  2. **系统管理员**（服务端硬校验 roles，不信前端）
 *  3. **二次密码解锁**（`HighRiskGateService`，scope='apitoken'，10 分钟）
 *
 * 与「身份模拟」同等级：都是「拿到别人权限」的能力，所以门禁一致。
 *
 * ## 为什么路由都在这个控制器里手写，不走通用 CRUD
 * 🔴 令牌记录的 **id 必须是明文哈希**（`createWithId`）。通用 CRUD 会自己生成随机 id，
 * 哈希就丢了 —— 建出来的令牌永远验不过。这与 AI 网关的密钥是同一个坑，
 * 那边在 `ai-route-admin.controller.ts` 文件头也写了同一条。
 *
 * ## 路由顺序
 * 静态段（`state` / `unlock` / `lock` / `modules` / `users`）全部写在 `:id` **之前** ——
 * ACMS 已有多次「静态路由被参数路由吃掉」的踩坑记录（markbook / exam-grade 都有注释）。
 */
@Controller('api-tokens')
@UseGuards(SessionGuard)
export class ApiTokenController {
  constructor(private readonly svc: ApiTokenService) {}

  /** 请求来源 IP（Nginx 反代后取 x-forwarded-for 首段），用于失败限流 */
  private ipOf(req: Request): string {
    return (
      (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ||
      req.socket?.remoteAddress ||
      'unknown'
    );
  }

  // ── 静态段（必须在 :id 之前）────────────────────────────────────

  /** 页面初始状态：是否已解锁 + 密码来源 + 有效期上限 */
  @Get('state')
  state(@Req() req: Request & { user: SessionUser }) {
    return this.svc.state(req.user);
  }

  /** 二次密码解锁。密码错/被锁定也返回 200，由 body 里的 code 区分 */
  @Post('unlock')
  @HttpCode(200)
  unlock(@Req() req: Request & { user: SessionUser }, @Body() body: { password?: string }) {
    return this.svc.unlock(req.user, String(body?.password ?? ''), this.ipOf(req));
  }

  /** 主动锁定：清掉解锁凭证，回到密码屏 */
  @Post('lock')
  @HttpCode(200)
  lock(@Req() req: Request & { user: SessionUser }) {
    return this.svc.lock(req.user);
  }

  /**
   * 模块白名单候选项。来自 `MODULE_RESOURCES` 单一真源 ——
   * 不在前端硬编码一份，否则以后新增模块时白名单会静默缺项。
   */
  @Get('modules')
  modules(@Req() req: Request & { user: SessionUser }) {
    return this.svc.listModuleOptions(req.user);
  }

  /** 可签发令牌的用户清单（复用身份模拟那份判定，避免两处口径不一） */
  @Get('users')
  users(@Req() req: Request & { user: SessionUser }) {
    return this.svc.listUsers(req.user);
  }

  /** 令牌清单（**不含明文**，只有前缀） */
  @Get()
  list(@Req() req: Request & { user: SessionUser }) {
    return this.svc.list(req.user);
  }

  /** 签发。返回体里的 `token` 是明文，**只此一次** */
  @Post()
  @HttpCode(201)
  issue(@Req() req: Request & { user: SessionUser }, @Body() body: IssueTokenDto) {
    return this.svc.issue(req.user, body ?? {}, this.ipOf(req));
  }

  // ── 参数段 ────────────────────────────────────────────────────

  /** 改限制项（名称 / 只读 / 模块 / 过期 / IP / 限流 / 留痕 / 备注 / 启停） */
  @Patch(':id')
  update(
    @Req() req: Request & { user: SessionUser },
    @Param('id') id: string,
    @Body() body: UpdateTokenDto,
  ) {
    return this.svc.update(req.user, id, body ?? {});
  }

  /**
   * 吊销。语义上是**状态流转**而不是删除 —— 删了就说不清「这个令牌曾经存在过」。
   */
  @Post(':id/revoke')
  @HttpCode(200)
  revoke(
    @Req() req: Request & { user: SessionUser },
    @Param('id') id: string,
    @Body() body: { reason?: string },
  ) {
    return this.svc.revoke(req.user, id, String(body?.reason ?? ''));
  }
}
