import { Injectable, Module, OnModuleInit } from '@nestjs/common';
import { LoginLogService } from './login-log.service.js';

@Injectable()
export class LoginLogSchemaService {
  constructor(private readonly svc: LoginLogService) {}
  async ensure(): Promise<void> {
    await this.svc.ensureTable();
  }
}

@Module({
  providers: [LoginLogService, LoginLogSchemaService],
  exports: [LoginLogService, LoginLogSchemaService],
})
export class LoginLogModule implements OnModuleInit {
  constructor(private readonly schema: LoginLogSchemaService) {}
  async onModuleInit() {
    try {
      await this.schema.ensure();
    } catch (e) {
      console.error(`[login-log] 启动建表失败: ${(e as Error).message}`);
    }
  }
}
