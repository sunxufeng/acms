import { Injectable, Module, OnModuleInit } from '@nestjs/common';
import { TABLES } from '@acms/contracts';
import { getSqlStore } from '../base.provider.js';

/**
 * 开放平台建表服务。
 *
 * 开放平台应用表是 ACMS 自建 SQL 表（与部门表、会议纪要表同路径，不走飞书 Base），
 * 需在启动期幂等建表。业务 CRUD 由 generic-crud 依据 lifecycle.meta.ts 的 RecordMeta
 * 自动生成，本模块只负责「表要存在」。
 */
@Injectable()
export class OpenPlatformSchemaService {
  async ensureTable(): Promise<void> {
    const sql = getSqlStore();
    if (!sql) {
      console.warn('[open-platform] 未配置 DATABASE_URL，跳过建表（开放平台功能不可用）');
      return;
    }
    await sql.ensureTable(TABLES.openPlatformApp.tableId, '开放平台应用表', []);
    console.log('[open-platform] 开放平台应用表已就绪');
  }
}

@Module({
  providers: [OpenPlatformSchemaService],
  exports: [OpenPlatformSchemaService],
})
export class OpenPlatformModule implements OnModuleInit {
  constructor(private readonly svc: OpenPlatformSchemaService) {}

  async onModuleInit() {
    try {
      await this.svc.ensureTable();
    } catch (e) {
      // 建表失败不应阻断启动，仅记录日志
      console.error('[open-platform] 启动建表失败: ' + (e as Error).message);
    }
  }
}
