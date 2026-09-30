import { Module } from '@nestjs/common';
import { TABLES } from '@acms/contracts';
import { getSqlStore } from '../base.provider.js';
import { StudentModule } from '../student/student.module.js';
import { DictModule } from '../dictionary/dict.module.js';
import { WeilingController } from './weiling.controller.js';
import { WeilingService } from './weiling.service.js';

/**
 * 卫瓴联系人模块。
 * - 两张自建 SQL 表（联系人副本、字段描述缓存），启动期幂等建表
 * - 列表/详情走 generic-crud（lifecycle.meta.ts 里 path='weiling-contacts'），
 *   模块资源只登记了 READ，所以接口层没有 create/update/delete
 * - 本 controller 额外提供：字段描述、同步状态、手动同步
 * - 🔴 `StudentModule` 是「联系人 → 转入学生档案」（v12）要用的：`WeilingService`
 *   注入了 `StudentService`（建学生必须复用它的必填校验 / ABAC / 默认值 / open_id 口径）。
 *   **import 了就必须写进下面的 `imports` 数组** —— 漏了的话 tsc/单测全绿、
 *   只有启动期 `Nest can't resolve dependencies of WeilingService`（守卫
 *   `apps/api/test/nest-module-di.test.ts` 会拦）。
 * - 🔴 `DictModule` 是「卫瓴映射」（v13）要用的：`WeilingService` 注入了 `DictService`
 *   取档案侧字段的**运行期选项**（「来源渠道」是 8 项还是 4 项取决于字典，不在代码里抄）。
 *   同样**必须写进 `imports` 数组**。
 */
@Module({
  imports: [StudentModule, DictModule],
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
