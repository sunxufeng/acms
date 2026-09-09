import { Module } from '@nestjs/common';
import { GetnoteController } from './getnote.controller.js';
import { GetnoteService } from './getnote.service.js';
import { baseClientProvider } from '../base.provider.js';
import { redisProvider } from '../redis.provider.js';

/**
 * 得到大脑（Get笔记）模块。
 * - 笔记正文纯转发不落库（权威数据在 openapi.biji.com，本地存一份反而是双写不一致的来源）
 * - 但「笔记 ↔ 业务实体」的关联关系要落飞书 noteLink 表：这是 ACMS 自己的数据，
 *   需要在本地查询、统计、跨实体检索，所以注入 baseClientProvider。
 */
@Module({
  controllers: [GetnoteController],
  // redisProvider：管理员笔记快照要跨进程重启存活（见 GetnoteService 的快照持久化），
  // 否则服务一重启快照就归零，用户首次进页面要干等一轮全量聚合。
  providers: [GetnoteService, baseClientProvider, redisProvider],
  exports: [GetnoteService],
})
export class GetnoteModule {}
