import { Injectable, Module, OnModuleInit } from '@nestjs/common';
import { TABLES } from '@acms/contracts';
import { getSqlStore } from '../base.provider.js';

/**
 * 会议纪要建表服务。
 *
 * 会议纪要表是 ACMS 自建 SQL 表（与部门表同路径，不走飞书 Base），
 * 因此需要在启动期幂等建表，否则首次写入会因表不存在而失败。
 * 业务 CRUD 仍由 generic-crud 依据 lifecycle.meta.ts 的 RecordMeta 自动生成，
 * 本模块只负责「表要存在」这一件事。
 */
@Injectable()
export class MeetingMinutesSchemaService {
  async ensureMeetingMinutesTable(): Promise<void> {
    const sql = getSqlStore();
    if (!sql) {
      console.warn('[meeting-minutes] 未配置 DATABASE_URL，跳过建表（会议纪要功能不可用）');
      return;
    }
    await sql.ensureTable(TABLES.meetingMinutes.tableId, '会议纪要表', []);
    console.log('[meeting-minutes] 会议纪要表已就绪');
  }
}

@Module({
  providers: [MeetingMinutesSchemaService],
  exports: [MeetingMinutesSchemaService],
})
export class MeetingMinutesModule implements OnModuleInit {
  constructor(private readonly svc: MeetingMinutesSchemaService) {}

  async onModuleInit() {
    try {
      await this.svc.ensureMeetingMinutesTable();
    } catch (e) {
      // 建表失败不应阻断启动，仅记录日志
      console.error(`[meeting-minutes] 启动建表失败: ${(e as Error).message}`);
    }
  }
}
