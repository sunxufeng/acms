import { Logger, Module, type OnModuleInit } from '@nestjs/common';
import { TABLES } from '@acms/contracts';
import { baseClientProvider, getSqlStore } from '../base.provider.js';

/**
 * 归属人映射模块（2026-09-24）。
 *
 * REST 路由由 `GenericCrudModule.registerAll(OWNER_MAPPING_METAS)` 生成
 * （见 app.module.ts），**但通用 CRUD 只生成路由、不建表** —— 建表必须由模块自己在
 * 启动期做，否则 /owner-mappings 上线即 500（考勤码表、AI 路由那批表都是同一套路）。
 *
 * 这是一张**本地配置表**（不同步飞书）：只在 PG 里建，幂等。
 */
@Module({
  providers: [baseClientProvider],
})
export class OwnerMappingModule implements OnModuleInit {
  private readonly logger = new Logger('OwnerMapping');

  async onModuleInit(): Promise<void> {
    const sql = getSqlStore();
    if (!sql) {
      this.logger.warn('[owner-mapping] 未配置 DATABASE_URL，跳过归属人映射表建表');
      return;
    }
    try {
      await sql.ensureTable(TABLES.ownerMapping.tableId, '归属人映射表', [
        { name: '卫瓴归属人', type: 1 },
        { name: 'ACMS用户', type: 1 },
        { name: '备注', type: 1 },
      ]);
      this.logger.log('[owner-mapping] 归属人映射表已就绪');
    } catch (e) {
      // 建表失败不阻断启动：/owner-mappings 会报错，其余功能不受影响
      this.logger.error(`[owner-mapping] 建表失败: ${(e as Error).message}`);
    }
  }
}
