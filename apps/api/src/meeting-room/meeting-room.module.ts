import { Module, OnModuleInit } from '@nestjs/common';
import { MeetingRoomController } from './meeting-room.controller.js';
import { MeetingRoomService } from './meeting-room.service.js';

/**
 * 会议室助手（组织管理）。
 *
 * 无 Nest 依赖注入的上游（飞书走 tenant token 直连、数据存自建 SQL 表），
 * 与 DepartmentModule 同构。启动期幂等建表；**不做定时同步** ——
 * 会议室配置变更频率很低（一年几次），由管理员在页面上点「同步飞书会议室」。
 */
@Module({
  controllers: [MeetingRoomController],
  providers: [MeetingRoomService],
  exports: [MeetingRoomService],
})
export class MeetingRoomModule implements OnModuleInit {
  constructor(private readonly svc: MeetingRoomService) {}

  async onModuleInit() {
    try {
      await this.svc.ensureTables();
    } catch (e) {
      // 建表失败不该阻断启动：页面会显示「还没有会议室数据」并允许重试
      console.error(`[meeting-room] 启动建表失败: ${(e as Error).message}`);
    }
  }
}
