import { Module, type OnModuleInit } from '@nestjs/common';
import { UsersModule } from '../user/user.module.js';
import { ImpersonateController } from './impersonate.controller.js';
import { ImpersonateService } from './impersonate.service.js';

/**
 * 身份模拟模块（2026-09-16）。系统管理员专用。
 *
 * 依赖说明：
 *  - `AuthModule` 是 `@Global`，且已 `exports: [REDIS, BASE_CLIENT, AuthService, SessionService, …]`
 *    ⇒ 直接注入即可，不必写进 imports（AuthService 是为了复用 resolvePrincipal）。
 *  - `UsersModule` 必须 imports：`UsersService.listForImpersonation()` 用于列账号，
 *    与用户管理页共用一份「用户表 → 清单」的判定，避免两边口径不一致。
 *
 * 建表只在本模块（通用 CRUD 不建表）：启动期幂等建「身份模拟记录表」，
 * 失败不阻断启动（页面照常可用，只是留痕落不下去，日志里会有提示）。
 */
@Module({
  imports: [UsersModule],
  controllers: [ImpersonateController],
  providers: [ImpersonateService],
})
export class ImpersonateModule implements OnModuleInit {
  constructor(private readonly svc: ImpersonateService) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.svc.ensureTables();
    } catch (e) {
      console.error(`[impersonate] 启动建表失败: ${(e as Error).message}`);
    }
  }
}
