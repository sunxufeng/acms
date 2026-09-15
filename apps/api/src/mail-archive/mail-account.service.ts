import { ForbiddenException, Injectable, Inject, NotFoundException } from '@nestjs/common';
import type { SessionUser } from '@acms/contracts';
import { USER_TABLE } from '@acms/contracts';
import { authorize } from '@acms/domain';
import { BaseClient } from '@acms/base-adapter';
import { BASE_CLIENT, baseClientProvider } from '../base.provider.js';
import { AuditService } from '../audit/audit.service.js';
import { BaseRecordService } from '../shared/generic-crud.module.js';
import { FieldMaskService } from '../shared/field-mask.service.js';
import { MAIL_ACCOUNT_META } from './mail-account.meta.js';
import { encryptCredential, decryptCredential, PASSWORD_MASK } from './crypto.js';

@Injectable()
export class MailAccountService extends BaseRecordService {
  constructor(
    @Inject(BASE_CLIENT) base: BaseClient,
    @Inject(AuditService) audit: AuditService,
    @Inject(FieldMaskService) mask: FieldMaskService,
  ) {
    super(MAIL_ACCOUNT_META, base, audit, mask);
  }

  /** 是否持有「邮件归档·管理所有人账户」（默认只有系统管理员） */
  private canManage(user: SessionUser): boolean {
    return authorize(
      { roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel },
      'mail:manage',
    ).allowed;
  }

  /** 「我」在系统用户表里的 record id（用来把「关联用户」默认填成本人）。查不到返回 ''。 */
  private async myUserId(openId: string): Promise<string> {
    if (!openId) return '';
    const rows = await this.scopeContext().search(USER_TABLE.tableId);
    const me = rows.find((r) => String(r['飞书 Open ID'] ?? '').trim() === openId);
    return String(me?.id ?? '');
  }

  /**
   * 写操作前置：只有**创建者本人**或持有 `mail:manage` 的人能改配置。
   *
   * 依据 2026-09-15 确认的决策 7：被关联进来的共管者**只能看邮件**，
   * 不能改 IMAP 密码 / 服务器 / 关联名单 —— 他们能把账户纳入行级可见范围，
   * 但「看得见」不等于「能改」，否则一个人就能把别人的邮箱配置改走。
   */
  private async assertWritable(user: SessionUser, id: string): Promise<void> {
    if (this.canManage(user)) return;
    const rec = await this.base.get(this.meta.tableId, id);
    if (!rec) throw new NotFoundException('NOT_FOUND');
    const creator = String((rec.fields as Record<string, unknown>)['创建者openId'] ?? '').trim();
    // 非管理员的可见账户必然满足 creator === 自己的 openId（见 rowScope），
    // 所以这里不匹配就是「别人的账户」，一律拒绝。
    if (creator !== user.openId) throw new ForbiddenException('FORBIDDEN:not_account_owner');
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
    // 决策 6：普通用户建账户**只能关联自己**（共管名单由管理员加人）。
    // ⚠️ 在服务端强制，不依赖前端隐藏字段 —— 前端只是提示，请求体是可以伪造的。
    if (!this.canManage(user)) {
      const me = await this.myUserId(user.openId);
      next['关联用户'] = me ? [me] : [];
    }
    return super.create(user, next);
  }

  /** 更新：若密码为掩码/空，则保留原密文；否则以新明文重新加密 */
  async update(user: SessionUser, id: string, dto: Record<string, unknown>) {
    await this.assertWritable(user, id);
    const next = { ...dto };
    if ('密码' in next) {
      const v = String(next['密码'] ?? '');
      if (v === PASSWORD_MASK || v === '') {
        delete next['密码']; // 不覆盖已有密文
      } else {
        next['密码'] = encryptCredential(v);
      }
    }
    // 决策 6/7：改「关联用户」名单需要 mail:manage。非管理员提交该字段一律**静默丢弃**（保持原值），
    // 否则任何人都能把自己或别人挂到任意账户上，行级隔离就形同虚设。
    if (!this.canManage(user)) delete next['关联用户'];
    if (Object.keys(next).length === 0) {
      // 无可写字段（仅密码被跳过）→ 直接返回当前记录，避免 BaseRecordService 报错
      return this.detail(user, id);
    }
    return super.update(user, id, next);
  }

  /** 删除：与 update 同权（非创建者不得删别人的账户） */
  async archive(user: SessionUser, id: string) {
    await this.assertWritable(user, id);
    return super.archive(user, id);
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
