import { Module } from '@nestjs/common';
import { WechatBindingController } from './wechat-binding.controller.js';
import { WechatBindingService } from './wechat-binding.service.js';

/**
 * 微信登录用户管理模块。
 * REDIS / BASE_CLIENT / SessionService 由全局 AuthModule 提供。
 * 列表/编辑/删除接口走 GenericCrudModule（CONFIG_METAS 注册的 wechat-bindings）；
 * 本模块只承载解绑/强制下线两个后台动作。
 */
@Module({
  controllers: [WechatBindingController],
  providers: [WechatBindingService],
  exports: [WechatBindingService],
})
export class WechatBindingModule {}
