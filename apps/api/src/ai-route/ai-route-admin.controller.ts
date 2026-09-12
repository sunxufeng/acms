import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { SessionUser } from '@acms/contracts';
import { SessionGuard } from '../auth/session.guard.js';
import { requireModule } from '../shared/require-module.js';
import { AiRouteService } from './ai-route.service.js';

/**
 * AI 路由的「专用接口」。
 * 通用 CRUD 覆盖不了的四类动作放在这里：
 *  1. 代发密钥 —— 明文只能出现一次，且记录 id 必须是哈希（通用新增会生成随机 id）
 *  2. 吊销密钥 —— 语义上是状态流转，不是删除（要留痕）
 *  3. 查看上游凭证明文 —— 列表永远只有掩码，看明文必须单独鉴权并记日志
 *  4. 用量聚合与上游健康检查 —— 跨行聚合 / 主动探测，都不是单条 CRUD
 */
@Controller()
@UseGuards(SessionGuard)
export class AiRouteAdminController {
  constructor(private readonly svc: AiRouteService) {}

  /** 代发密钥：返回体里的 key 是明文，只此一次 */
  @Post('ai-api-keys/mint')
  async mint(
    @Req() req: { user: SessionUser; headers: Record<string, string | string[] | undefined>; socket?: { remoteAddress?: string } },
    @Body() body: { name?: string; userId?: string; groupId?: string; ipWhitelist?: string[]; quotaUsd?: number; expiresAt?: number },
  ) {
    requireModule(req.user, 'aiApiKeys', 'create');
    if (!body?.groupId) throw new Error('必须选择所属分组');
    const r = await this.svc.mintKey({
      name: String(body.name ?? ''),
      userId: String(body.userId ?? req.user.openId ?? ''),
      groupId: String(body.groupId),
      ipWhitelist: Array.isArray(body.ipWhitelist) ? body.ipWhitelist.map(String) : [],
      quotaUsd: Number(body.quotaUsd ?? 0),
      expiresAt: Number(body.expiresAt ?? 0) || undefined,
    });
    return { id: r.id, key: r.key, prefix: r.prefix };
  }

  @Post('ai-api-keys/:id/revoke')
  async revoke(@Req() req: { user: SessionUser; headers: Record<string, string | string[] | undefined> }, @Param('id') id: string) {
    requireModule(req.user, 'aiApiKeys', 'update');
    await this.svc.revokeKey(id);
    return { ok: true };
  }

  /**
   * 查看上游凭证明文。
   * ⚠️ 权限用 update 而不是 read：能看明文等于拿到厂商 key，门槛要与「能改上游」对齐。
   */
  @Post('ai-upstreams/:id/secret')
  async secret(@Req() req: { user: SessionUser; headers: Record<string, string | string[] | undefined> }, @Param('id') id: string) {
    requireModule(req.user, 'aiUpstreams', 'update');
    const credential = await this.svc.revealCredential(id);
    return { credential };
  }

  /**
   * 重置账号调度状态：清掉限流/过载/临时摘除三种冷却与失败计数。
   * 场景：上游 key 额度恢复、凭证已修好，不想等冷却自然到期。
   */
  @Post('ai-upstreams/:id/reset-state')
  async resetState(
    @Req() req: { user: SessionUser; headers: Record<string, string | string[] | undefined> },
    @Param('id') id: string,
  ) {
    requireModule(req.user, 'aiUpstreams', 'update');
    await this.svc.resetAccountState(id);
    return { ok: true };
  }

  /** 手动触发上游健康检查（定时任务也会跑，这里是「我改完上游想立刻验证」的入口） */
  @Post('ai-upstreams/health-check')
  async healthCheck(@Req() req: { user: SessionUser; headers: Record<string, string | string[] | undefined> }) {
    requireModule(req.user, 'aiUpstreams', 'refresh');
    return this.svc.healthCheckAll();
  }

  /** 用量聚合（总数 / 按模型 / 按人 / 按天） */
  @Get('ai-usage/stats')
  async usageStats(
    @Req() req: { user: SessionUser; headers: Record<string, string | string[] | undefined> },
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('userId') userId?: string,
    @Query('model') model?: string,
  ) {
    requireModule(req.user, 'aiUsage', 'read');
    const toMs = (v?: string): number | undefined => (v ? new Date(`${v.slice(0, 10)}T00:00:00`).getTime() : undefined);
    const toMsEnd = (v?: string): number | undefined => (v ? new Date(`${v.slice(0, 10)}T23:59:59.999`).getTime() : undefined);
    return this.svc.usageStats({
      from: toMs(from),
      to: toMsEnd(to),
      userId: userId || undefined,
      model: model || undefined,
    });
  }
}
