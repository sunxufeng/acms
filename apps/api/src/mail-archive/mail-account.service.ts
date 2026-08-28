import { Injectable, Inject } from '@nestjs/common';
import type { SessionUser } from '@acms/contracts';
import { BaseClient } from '@acms/base-adapter';
import { BASE_CLIENT, baseClientProvider } from '../base.provider.js';
import { AuditService } from '../audit/audit.service.js';
import { BaseRecordService } from '../shared/generic-crud.module.js';
import { MAIL_ACCOUNT_META } from './mail-account.meta.js';
import { encryptCredential, decryptCredential, PASSWORD_MASK } from './crypto.js';

@Injectable()
export class MailAccountService extends BaseRecordService {
  constructor(
    @Inject(BASE_CLIENT) base: BaseClient,
    @Inject(AuditService) audit: AuditService,
  ) {
    super(MAIL_ACCOUNT_META, base, audit);
  }

  /** 创建：明文密码 → 密文入库 */
  async create(user: SessionUser, dto: Record<string, unknown>) {
    const next = { ...dto };
    if (typeof next['密码'] === 'string' && next['密码'].length > 0) {
      next['密码'] = encryptCredential(next['密码']);
    } else {
      next['密码'] = '';
    }
    // 默认启用 + 默认频率兜底
    if (!next['启用']) next['启用'] = '启用';
    if (!next['收取频率']) next['收取频率'] = '每小时';
    if (!next['使用SSL']) next['使用SSL'] = '是';
    if (!next['IMAP端口']) next['IMAP端口'] = 993;
    return super.create(user, next);
  }

  /** 更新：若密码为掩码/空，则保留原密文；否则以新明文重新加密 */
  async update(user: SessionUser, id: string, dto: Record<string, unknown>) {
    const next = { ...dto };
    if ('密码' in next) {
      const v = String(next['密码'] ?? '');
      if (v === PASSWORD_MASK || v === '') {
        delete next['密码']; // 不覆盖已有密文
      } else {
        next['密码'] = encryptCredential(v);
      }
    }
    if (Object.keys(next).length === 0) {
      // 无可写字段（仅密码被跳过）→ 直接返回当前记录，避免 BaseRecordService 报错
      return this.detail(user, id);
    }
    return super.update(user, id, next);
  }

  /** 列表：对密码字段做掩码，避免泄露密文 */
  async list(user: SessionUser, query: Record<string, string | undefined>) {
    const res = await super.list(user, query);
    for (const it of res.items) {
      it['密码'] = typeof it['密码'] === 'string' && it['密码'] ? PASSWORD_MASK : '';
    }
    return res;
  }

  /** 详情：同样掩码密码 */
  async detail(user: SessionUser, id: string) {
    const rec = await super.detail(user, id);
    rec['密码'] = typeof rec['密码'] === 'string' && rec['密码'] ? PASSWORD_MASK : '';
    return rec;
  }

  /**
   * 读取账户原始记录并解密密码（供同步任务使用，绕过掩码）。
   * 不走权限校验（由调用方 MailArchiveService 控制触发权限）。
   */
  async getForSync(accountId: string): Promise<{
    id: string;
    fields: Record<string, unknown>;
  } | null> {
    const rec = await this.base.get(this.meta.tableId, accountId);
    if (!rec) return null;
    const fields = rec.fields as Record<string, unknown>;
    const enc = typeof fields['密码'] === 'string' ? (fields['密码'] as string) : '';
    fields['密码'] = decryptCredential(enc);
    return { id: rec.recordId, fields };
  }
}
