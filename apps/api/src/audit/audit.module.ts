import { Module, Global } from '@nestjs/common';
import { AuditService } from './audit.service.js';
import { baseClientProvider } from '../base.provider.js';

/** 全局审计日志模块：AuditService 可被任意模块（含通用 CRUD）注入。 */
@Global()
@Module({
  providers: [AuditService, baseClientProvider],
  exports: [AuditService],
})
export class AuditModule {}
