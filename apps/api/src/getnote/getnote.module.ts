import { Module } from '@nestjs/common';
import { GetnoteController } from './getnote.controller.js';
import { GetnoteService } from './getnote.service.js';

/**
 * 得到大脑（Get笔记）代理模块。
 * 纯转发，不落库（笔记的权威数据在 openapi.biji.com，本地存一份反而是双写不一致的来源）。
 */
@Module({
  controllers: [GetnoteController],
  providers: [GetnoteService],
  exports: [GetnoteService],
})
export class GetnoteModule {}
