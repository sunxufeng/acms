import { Module } from '@nestjs/common';
import { MiniProgramController } from './mini-program.controller.js';
import { MiniProgramService } from './mini-program.service.js';
import { WechatBindingModule } from '../wechat-binding/wechat-binding.module.js';

/**
 * 微信小程序端模块（P0 登录绑定 + P2 区域拉取）。
 * REDIS / BASE_CLIENT / SessionService 由全局 AuthModule 提供，无需重复注册。
 */
@Module({
  controllers: [MiniProgramController],
  providers: [MiniProgramService],
  imports: [WechatBindingModule],
})
export class MiniProgramModule {}
