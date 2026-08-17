import { Injectable, Logger } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { BaseClient } from '@acms/base-adapter';
import { BASE_CLIENT } from '../base.provider.js';
import { TABLES } from '@acms/contracts';

export type AuditAction = '创建' | '更新' | '删除';

export interface AuditEvent {
  /** 操作人（姓名） */
  actor: string;
  action: AuditAction;
  /** 业务模块（对应 RecordMeta.path） */
  module: string;
  /** 记录标识（飞书记录 id） */
  recordId: string;
  /** 摘要（可选，人类可读说明） */
  summary?: string;
  /** 详情（可选，如变更字段名列表） */
  detail?: string;
}

/**
 * 审计日志服务：将关键写操作（创建/更新/删除）追加到飞书「审计日志表」。
 * 写入失败仅记录日志、不影响主流程（fire-and-forget），避免审计链路拖垮业务写。
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(@Inject(BASE_CLIENT) private readonly base: BaseClient) {}

  async log(evt: AuditEvent): Promise<void> {
    try {
      await this.base.create(TABLES.auditLog.tableId, {
        操作时间: Date.now(),
        操作人: evt.actor,
        操作类型: evt.action,
        业务模块: evt.module,
        记录标识: evt.recordId,
        摘要: evt.summary ?? '',
        详情: evt.detail ?? '',
      });
    } catch (e) {
      this.logger.error(`审计日志写入失败 module=${evt.module} action=${evt.action}`, e as Error);
    }
  }
}
