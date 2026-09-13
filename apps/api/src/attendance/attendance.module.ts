import { Logger, Module, type OnModuleInit } from '@nestjs/common';
import { TABLES } from '@acms/contracts';
import { AttendanceController } from './attendance.controller.js';
import { AttendanceService } from './attendance.service.js';
import { SignController } from './sign.controller.js';
import { SignService } from './sign.service.js';
import { baseClientProvider, getSqlStore } from '../base.provider.js';

/**
 * 考勤模块。
 *
 * 「考勤码表」（tblattcode0000001，2026-09-13 参照 Gibbon 移植）是教学域新增的**配置表**：
 * 把原先硬编码在前端的「出勤/迟到/早退/事假/病假/缺勤/校内活动」升级成可配置码表，
 * 带「可预填 / 计入统计」两个口径开关。
 *
 * ⚠️ 它的 REST 路由由 `GenericCrudModule.registerAll(TEACHING_CONFIG_METAS)` 生成，
 * **但通用 CRUD 只生成路由、不会建表** —— 建表必须由模块自己在启动期做，
 * 否则 /attendance-codes 全线 500（AI 路由那批表也是同一套路）。
 */
@Module({
  controllers: [AttendanceController, SignController],
  providers: [AttendanceService, SignService, baseClientProvider],
})
export class AttendanceModule implements OnModuleInit {
  private readonly logger = new Logger('Attendance');

  async onModuleInit(): Promise<void> {
    const sql = getSqlStore();
    if (!sql) {
      this.logger.warn('[attendance] 未配置 DATABASE_URL，跳过考勤码表建表');
      return;
    }
    try {
      await sql.ensureTable(TABLES.attendanceCode.tableId, '考勤码表', []);
      this.logger.log('[attendance] 考勤码表已就绪');
    } catch (e) {
      // 建表失败不阻断启动：/attendance-codes 会报错，但其余考勤功能不受影响
      this.logger.error(`[attendance] 考勤码表建表失败: ${(e as Error).message}`);
    }
  }
}
