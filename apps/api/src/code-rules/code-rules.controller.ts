import { Body, Controller, Get, Inject, Post, Put, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { SessionUser } from '@acms/contracts';
import { SessionGuard } from '../auth/session.guard.js';
import { CodeRulesService } from './code-rules.service.js';

/**
 * 「代码规则」（v14，2026-10-01 峰哥）。
 *
 * 权限：`module:codeRules:read` / `:update`（服务方法里用 `requireModule` 判）。
 * 🔴 为什么不用自建的 `authorize(...)` 内联判断：`requireModule` 是 2026-09-25 之后
 *    全站收口的那套（`module:<key>:<action>`），自己再写一遍容易和角色矩阵不同步。
 */
@UseGuards(SessionGuard)
@Controller('code-rules')
export class CodeRulesController {
  constructor(@Inject(CodeRulesService) private readonly svc: CodeRulesService) {}

  private static user(req: Request): SessionUser {
    return (req as Request & { user: SessionUser }).user;
  }

  /** 读配置 + 试算预览（页面首屏） */
  @Get()
  get(@Req() req: Request) {
    return this.svc.get(CodeRulesController.user(req));
  }

  /**
   * 用提交的规则试算（**不保存**）。
   *
   * 🔴 试算与真正生成走**同一个** `generateCode`（contracts 里只有一份），
   *    所以"预览看到的号"必然等于"以后真生成的号"——前端不许自己估算。
   */
  @Post('preview')
  preview(@Req() req: Request, @Body() body: Record<string, unknown>) {
    return this.svc.preview(CodeRulesController.user(req), body ?? {});
  }

  /** 保存（整体替换；存进去的是归一化后那份） */
  @Put()
  save(@Req() req: Request, @Body() body: Record<string, unknown>) {
    return this.svc.save(CodeRulesController.user(req), body ?? {});
  }

  /**
   * 批量补号**预检**（不写库）：列出该字段为空、且按规则能生成号的记录。
   *
   * 🔴 静态路由（`fill/preview`）必须排在前面 —— 虽然本 controller 没有 `@Get(':id')`，
   *    但按惯例前置，避免以后加带参数路由时踩（`@Get('export')` 被 `:id` 吃掉的坑见过）。
   */
  @Post('fill/preview')
  fillPreview(@Req() req: Request, @Body() body: Record<string, unknown>) {
    return this.svc.fillPreview(CodeRulesController.user(req), body ?? {});
  }

  /** 批量补号（写库，二次确认后调用；**只补空值**） */
  @Post('fill')
  fill(@Req() req: Request, @Body() body: Record<string, unknown>) {
    return this.svc.fill(CodeRulesController.user(req), body ?? {});
  }
}
