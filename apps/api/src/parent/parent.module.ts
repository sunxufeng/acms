import { Module } from '@nestjs/common';
import { ParentController } from './parent.controller.js';
import { ParentService } from './parent.service.js';
import { WechatBindingModule } from '../wechat-binding/wechat-binding.module.js';

@Module({
  controllers: [ParentController],
  providers: [ParentService],
  imports: [WechatBindingModule],
})
export class ParentModule {}
