import { Module } from '@nestjs/common';
import { TABLES } from '@acms/contracts';
import { getSqlStore } from '../base.provider.js';
import { WeilingController } from './weiling.controller.js';
import { WeilingService } from './weiling.service.js';

/**
 * 卫瓴联系人模块。
 * - 两张自建 SQL 表（联系人副本、字段描述缓存），启动期幂等建表
 * - 列表/详情走 generic-crud（lifecycle.meta.ts 里 path='weiling-contacts'），
 *   模块资源只登记了 READ，所以接口层没有 create/update/delete
 * - 本 controller 额外提供：字段描述、同步状态、手动同步
 */
@Module({
  controllers: [WeilingController],
  providers: [WeilingService],
  exports: [WeilingService],
})
export class WeilingModule {
  constructor() {
    const sql = getSqlStore();
    if (!sql) {
      console.warn('[weiling] 未配置 DATABASE_URL，跳过建表（卫瓴联系人功能不可用）');
      return;
    }
    void (async () => {
      try {
        await sql.ensureTable(TABLES.weilingContact.tableId, '卫瓴联系人表', []);
        await sql.ensureTable(TABLES.weilingField.tableId, '卫瓴字段描述表', []);
        await sql.ensureTable(TABLES.weilingProgress.tableId, '卫瓴跟进记录表', []);
        console.log('[weiling] 卫瓴联系人表已就绪');
      } catch (e) {
        console.error('[weiling] 启动建表失败: ' + (e as Error).message);
      }
    })();
  }
}
