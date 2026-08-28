import { Injectable, Logger, Inject } from '@nestjs/common';
import type { SessionUser } from '@acms/contracts';
import { TABLES } from '@acms/contracts';
import { BaseClient } from '@acms/base-adapter';
import { BASE_CLIENT, baseClientProvider } from '../base.provider.js';
import { AuditService } from '../audit/audit.service.js';
import { FileUploadService } from '../file-upload/file-upload.service.js';
import { BaseRecordService } from '../shared/generic-crud.module.js';
import { buildFilter } from '../shared/record.util.js';
import { MAIL_ARCHIVE_META } from './mail-archive.meta.js';
import { MailAccountService } from './mail-account.service.js';

interface ParsedAccount {
  id: string;
  name: string;
  email: string;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  freqMinutes: number;
  filters: MailFilterRule;
  enabled: boolean;
}

interface MailFilterRule {
  fromContains?: string;
  fromDomain?: string;
  subjectContains?: string;
  onlyWithAttachment?: boolean;
}

/** 发件箱文件夹名的常见写法（服务器未返回 SPECIAL-USE 标志时兜底匹配）。
 *  各家命名不统一：Gmail `[Gmail]/Sent Mail`、Exchange `Sent Items`、163/QQ `Sent Messages` 或「已发送」。 */
const SENT_NAME_RE = /^(sent|sent items|sent mail|sent messages|已发送|已发送邮件)$/i;

@Injectable()
export class MailArchiveService extends BaseRecordService {
  private readonly logger = new Logger('MailArchive');

  constructor(
    @Inject(BASE_CLIENT) base: BaseClient,
    @Inject(AuditService) audit: AuditService,
    private readonly fileUpload: FileUploadService,
    private readonly accountSvc: MailAccountService,
  ) {
    super(MAIL_ARCHIVE_META, base, audit);
  }

  /** 同步单个账户；返回本次收取统计 */
  async syncAccount(accountId: string): Promise<{ ok: boolean; fetched: number; stored: number; error?: string }> {
    const acc = await this.accountSvc.getForSync(accountId);
    if (!acc) return { ok: false, fetched: 0, stored: 0, error: '账户不存在' };
    const a = this.parseAccount(acc.fields);
    if (!a.enabled) return { ok: true, fetched: 0, stored: 0 };
    if (!a.pass) return { ok: false, fetched: 0, stored: 0, error: '账户未配置密码' };

    let fetched = 0;
    let stored = 0;
    let lastErr = '';
    try {
      const { ImapFlow } = await import('imapflow');
      const client = new ImapFlow({
        host: a.host,
        port: a.port,
        secure: a.secure,
        auth: { user: a.user, pass: a.pass },
        logger: false,
      });
      await client.connect();
      try {
        // 收取范围：收件箱 + 自动探测到的发件箱
        const sentFolder = await this.resolveSentFolder(client);
        const folders: Array<{ path: string; isSent: boolean }> = [{ path: 'INBOX', isSent: false }];
        if (sentFolder) folders.push({ path: sentFolder, isSent: true });
        for (const { path: folder, isSent } of folders) {
          let lock;
          try {
            lock = await client.getMailboxLock(folder);
          } catch {
            this.logger.warn(`账户 ${a.name} 无文件夹 ${folder}，跳过`);
            continue;
          }
          try {
            const searchRes = await client.search({});
            const uids = (Array.isArray(searchRes) ? searchRes : []).slice(-500);
            for (const uid of uids) {
              fetched++;
              const msg = await client.fetchOne(uid, { uid: true, source: true });
              if (!msg || !msg.source) continue;
              const { simpleParser } = await import('mailparser');
              const parsed = await simpleParser(msg.source);
              if (!this.matchFilter(a.filters, parsed, isSent)) continue;
              const saved = await this.archiveOne(a, folder, String(uid), parsed);
              if (saved) stored++;
            }
          } finally {
            lock.release();
          }
        }
      } finally {
        await client.logout();
      }
    } catch (e) {
      lastErr = (e as Error).message;
      this.logger.error(`账户 ${a.name} 同步失败: ${lastErr}`);
    }

    // 更新账户的最后收取时间与结果
    const now = new Date();
    await this.base.update(TABLES.mailAccount.tableId, a.id, {
      '最后收取时间': now.getTime(),
      '最后收取结果': lastErr
        ? `失败：${lastErr.slice(0, 120)}`
        : `成功：本次读取 ${fetched} 封，新增归档 ${stored} 封`,
    } as Record<string, unknown>).catch(() => undefined);

    return { ok: !lastErr, fetched, stored, error: lastErr || undefined };
  }

  /** 同步全部「启用」账户；按各账户收取频率跳过未到点的账户 */
  async syncAll(): Promise<{ synced: number; results: Record<string, unknown> }> {
    const res = await this.base.search(TABLES.mailAccount.tableId, {
      pageSize: 100,
      filter: buildFilter([{ field: '启用', value: ['启用'] }]),
    });
    const results: Record<string, unknown> = {};
    let synced = 0;
    for (const row of res.items) {
      const id = row.recordId;
      const fields = row.fields as Record<string, unknown>;
      const lastRaw = fields['最后收取时间'];
      const last = typeof lastRaw === 'number' ? lastRaw : 0;
      const intervalMs = (Number(fields['收取频率'] ?? 60) || 60) * 60 * 1000;
      if (last && Date.now() - last < intervalMs) continue; // 未到收取频率，跳过
      const r = await this.syncAccount(id);
      results[String(fields['账户名称'] ?? id)] = r;
      synced++;
    }
    return { synced, results };
  }

  /** 解析附件下载链接（供前端下载归档附件） */
  async getAttachmentUrl(fileToken: string): Promise<string> {
    return this.fileUpload.resolveDownloadUrl(fileToken);
  }

  /** 探测发件箱文件夹路径：优先用 IMAP SPECIAL-USE 标志 `\Sent`（RFC 6154），
   *  服务器未返回该标志时按常见名称兜底；都找不到返回 null（此时只收收件箱）。 */
  private async resolveSentFolder(client: {
    list: () => Promise<Array<{ path?: string; delimiter?: string; specialUse?: unknown }>>;
  }): Promise<string | null> {
    let boxes: Array<{ path?: string; delimiter?: string; specialUse?: unknown }> = [];
    try {
      boxes = (await client.list()) ?? [];
    } catch (e) {
      this.logger.warn(`列取邮箱文件夹失败: ${(e as Error).message}`);
      return null;
    }

    const byFlag = boxes.find(
      (b) => typeof b.specialUse === 'string' && b.specialUse.toLowerCase() === '\\sent',
    );
    if (byFlag?.path) return byFlag.path;

    const byName = boxes.find((b) => {
      const p = (b.path ?? '').trim();
      // 按层级分隔符取最后一段，使 `[Gmail]/Sent Mail` 也能匹配到
      const last = p.split(b.delimiter || '/').pop() ?? p;
      return SENT_NAME_RE.test(last.trim());
    });
    return byName?.path ?? null;
  }

  // ── 内部工具 ──────────────────────────────────────────────

  private parseAccount(f: Record<string, unknown>): ParsedAccount {
    let filters: MailFilterRule = {};
    try {
      if (typeof f['过滤规则'] === 'string' && f['过滤规则'].trim()) {
        filters = JSON.parse(f['过滤规则']) as MailFilterRule;
      }
    } catch {
      filters = {};
    }
    const freqMap: Record<string, number> = {
      每15分钟: 15, 每30分钟: 30, 每小时: 60, 每天: 1440,
    };
    return {
      id: '',
      name: String(f['账户名称'] ?? ''),
      email: String(f['邮箱地址'] ?? ''),
      host: String(f['IMAP服务器'] ?? ''),
      port: Number(f['IMAP端口'] ?? 993) || 993,
      secure: String(f['使用SSL'] ?? '是') !== '否',
      user: String(f['用户名'] ?? ''),
      pass: String(f['密码'] ?? ''),
      freqMinutes: freqMap[String(f['收取频率'] ?? '每小时')] ?? 60,
      filters,
      enabled: String(f['启用'] ?? '启用') !== '停用',
    };
  }

  /** 过滤规则匹配。
   *  ⚠️ 发件箱邮件的「发件人」是账户本人，若仍按 from 匹配，
   *  配了 fromDomain（只归档与某方往来）的账户其发件箱邮件会被全部过滤掉。
   *  因此发件箱改按「收件人 + 抄送」匹配，使同一条规则在收发双向都生效。 */
  private matchFilter(
    rule: MailFilterRule,
    parsed: { from?: { text?: string }; to?: { text?: string }; cc?: { text?: string }; subject?: string; attachments?: unknown[] },
    isSent = false,
  ): boolean {
    const counterparty = isSent
      ? `${parsed.to?.text ?? ''} ${parsed.cc?.text ?? ''}`
      : (parsed.from?.text ?? '');
    const who = counterparty.toLowerCase();

    if (rule.fromContains) {
      if (!who.includes(rule.fromContains.toLowerCase())) return false;
    }
    if (rule.fromDomain) {
      if (!who.includes(rule.fromDomain.toLowerCase())) return false;
    }
    if (rule.subjectContains) {
      const subj = (parsed.subject ?? '').toLowerCase();
      if (!subj.includes(rule.subjectContains.toLowerCase())) return false;
    }
    if (rule.onlyWithAttachment) {
      if (!parsed.attachments || parsed.attachments.length === 0) return false;
    }
    return true;
  }

  /** 单封邮件落库；已存在（同账户+同文件夹+同UID）则跳过，返回是否新增 */
  private async archiveOne(
    acc: ParsedAccount,
    folder: string,
    uid: string,
    parsed: { from?: { text?: string }; to?: { text?: string }; cc?: { text?: string }; subject?: string; date?: Date; text?: string; html?: string; attachments?: Array<{ filename?: string; contentType?: string; content?: Buffer }> },
  ): Promise<boolean> {
    // 去重：同账户 + 同文件夹 + 同 UID 已存在则跳过。
    // ⚠️ IMAP 的 UID 是按文件夹独立编号的，收件箱与发件箱会有相同 UID，
    // 因此去重必须带「邮箱文件夹」维度，否则发件箱邮件会被误判为重复而丢失。
    const dup = await this.base.search(this.meta.tableId, {
      pageSize: 1,
      filter: buildFilter([
        { field: '邮件UID', value: [uid] },
        { field: '归属账户', value: [acc.name] },
        { field: '邮箱文件夹', value: [folder] },
      ]),
    });
    if (dup.items.length > 0) return false;

    const attachments = parsed.attachments ?? [];
    const meta: { name: string; size: number; type: string; file_token: string }[] = [];
    for (const att of attachments) {
      const buf = att.content;
      if (!buf || !Buffer.isBuffer(buf)) continue;
      const name = att.filename || 'attachment';
      const mime = att.contentType || 'application/octet-stream';
      try {
        const { file_token } = await this.fileUpload.uploadFile(buf, name, mime);
        meta.push({ name, size: buf.length, type: mime, file_token });
      } catch (e) {
        this.logger.warn(`附件上传失败 (${name}): ${(e as Error).message}`);
      }
    }

    const body = parsed.text || (parsed.html ? this.stripHtml(parsed.html) : '') || '';
    const dateIso = parsed.date ? new Date(parsed.date).toISOString() : new Date().toISOString();

    await this.base.create(this.meta.tableId, {
      '邮件UID': uid,
      '归属账户': acc.name,
      '邮箱文件夹': folder,
      '发件人': parsed.from?.text ?? '',
      '收件人': parsed.to?.text ?? '',
      '抄送': parsed.cc?.text ?? '',
      '主题': parsed.subject ?? '(无主题)',
      '正文': body.slice(0, 100000),
      '发送时间': dateIso,
      '收取时间': new Date().toISOString(),
      '附件数': meta.length,
      '附件信息': JSON.stringify(meta),
      '关联学生': '',
      '是否已读': '否',
    } as Record<string, unknown>);

    return true;
  }

  private stripHtml(html: string): string {
    return html
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim();
  }
}
