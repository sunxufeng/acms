import { Module } from '@nestjs/common';
import { GetnoteController } from './getnote.controller.js';
import { GetnoteService } from './getnote.service.js';
import { baseClientProvider } from '../base.provider.js';

/**
 * 得到大脑（Get笔记）模块。
 * - 笔记正文纯转发不落库（权威数据在 openapi.biji.com，本地存一份反而是双写不一致的来源）
 * - 但「笔记 ↔ 业务实体」的关联关系要落飞书 noteLink 表：这是 ACMS 自己的数据，
 *   需要在本地查询、统计、跨实体检索，所以注入 baseClientProvider。
 */
@Module({
  controllers: [GetnoteController],
  providers: [GetnoteService, baseClientProvider],
  exports: [GetnoteService],
})
export class GetnoteModule {}
