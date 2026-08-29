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
  /** 账户记录 ID（回写「最后收取时间/结果」时使用；此前恒为空串导致回写必然失败） */
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
  /** 手工指定的发件箱文件夹路径；留空则走自动探测 */
  sentFolder: string;
}

interface MailFilterRule {
  fromContains?: string;
  fromDomain?: string;
  subjectContains?: string;
  onlyWithAttachment?: boolean;
}

/** 发件箱文件夹名的常见写法（服务器未返回 SPECIAL-USE 标志时兜底匹配）。
 *  各家命名不统一：Gmail `[Gmail]/Sent Mail`、Exchange `Sent Items`、163/QQ `Sent Messages` 或「已发送」。 */
const SENT_NAME_RE =
  /^(sent|sent items|sent mail|sent messages|sent box|已发送|已发送邮件|已寄出|发件箱|寄件備份|寄件备份)$/i;

/** 「收取频率」的中文字面值 → 分钟数。由 syncAll 的节流判断与 parseAccount 共用，
 *  避免各处重复定义，也避免误用 Number() 解析中文得到 NaN 后恒回落成默认值。 */
const FREQ_MINUTES: Record<string, number> = {
  每15分钟: 15, 每30分钟: 30, 每小时: 60, 每天: 1440,
};

/** 把「收取频率」字段值解析为分钟数，兼容中文字面值与纯数字分钟 */
function parseFreqMinutes(raw: unknown): number {
  const s = String(raw ?? '').trim();
  if (!s) return 60;
  if (FREQ_MINUTES[s] != null) return FREQ_MINUTES[s];
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : 60;
}

/** 单个文件夹的收取结果 */
interface FolderStat {
  folder: string;
  isSent: boolean;
  fetched: number;
  stored: number;
  error?: string;
}

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

  /** 同步单个账户；返回本次收取统计（含每个文件夹的明细） */
  async syncAccount(accountId: string): Promise<{
    ok: boolean;
    fetched: number;
    stored: number;
    error?: string;
    folders: FolderStat[];
  }> {
    const acc = await this.accountSvc.getForSync(accountId);
    if (!acc) return { ok: false, fetched: 0, stored: 0, error: '账户不存在', folders: [] };
    const a = this.parseAccount(acc.fields, accountId);
    if (!a.enabled) return { ok: true, fetched: 0, stored: 0, folders: [] };
    if (!a.pass) return { ok: false, fetched: 0, stored: 0, error: '账户未配置密码', folders: [] };

    let lastErr = '';
    const folderStats: FolderStat[] = [];
    const notes: string[] = [];

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
        // 发件箱：账户显式配置优先，未配置才走自动探测
        let sentFolder = a.sentFolder;
        if (sentFolder) {
          notes.push(`发件箱按账户配置「${sentFolder}」收取`);
        } else {
          sentFolder = (await this.resolveSentFolder(client)) ?? '';
          if (sentFolder) notes.push(`发件箱自动探测为「${sentFolder}」`);
          else notes.push('未配置且未探测到发件箱，本次仅收取收件箱');
        }

        const folders: Array<{ path: string; isSent: boolean }> = [{ path: 'INBOX', isSent: false }];
        if (sentFolder) folders.push({ path: sentFolder, isSent: true });

        for (const { path: folder, isSent } of folders) {
          let lock;
          try {
            lock = await client.getMailboxLock(folder);
          } catch (e) {
            // 不再静默跳过：写进收取结果，便于在账户列表直接看到原因
            const msg = `无法打开文件夹「${folder}」：${(e as Error).message}`;
            this.logger.warn(`账户 ${a.name} ${msg}`);
            folderStats.push({ folder, isSent, fetched: 0, stored: 0, error: msg });
            continue;
          }
          let fFetched = 0;
          let fStored = 0;
          try {
            const searchRes = await client.search({});
            const uids = (Array.isArray(searchRes) ? searchRes : []).slice(-500);
            for (const uid of uids) {
              fFetched++;
              const msg = await client.fetchOne(uid, { uid: true, source: true });
              if (!msg || !msg.source) continue;
              const { simpleParser } = await import('mailparser');
              const parsed = await simpleParser(msg.source);
              if (!this.matchFilter(a.filters, parsed, isSent)) continue;
              const saved = await this.archiveOne(a, folder, String(uid), parsed, isSent);
              if (saved) fStored++;
            }
            folderStats.push({ folder, isSent, fetched: fFetched, stored: fStored });
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

    const fetched = folderStats.reduce((s, f) => s + f.fetched, 0);
    const stored = folderStats.reduce((s, f) => s + f.stored, 0);

    // 结果信息带收发件箱维度，便于确认发件箱是否真的被扫到
    const detail = folderStats
      .map((f) => {
        const label = f.isSent ? '发件箱' : '收件箱';
        return f.error
          ? `${label}(${f.folder}) 失败：${f.error}`
          : `${label}(${f.folder}) 读取 ${f.fetched} 封，新增 ${f.stored} 封`;
      })
      .join('；');

    const resultText = lastErr
      ? `失败：${lastErr.slice(0, 120)}${detail ? ` | ${detail}` : ''}`
      : `${detail || '成功：无可收取的邮件'}${notes.length ? ` | ${notes.join('；')}` : ''}`;

    // 回写账户的最后收取时间与结果（此前 a.id 恒为空串，导致 update 必然失败且被静默吞掉）
    await this.base
      .update(TABLES.mailAccount.tableId, a.id, {
        '最后收取时间': new Date().getTime(),
        '最后收取结果': resultText.slice(0, 500),
      } as Record<string, unknown>)
      .catch((e) => this.logger.error(`回写账户收取结果失败 ${a.id}: ${(e as Error).message}`));

    return { ok: !lastErr, fetched, stored, error: lastErr || undefined, folders: folderStats };
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
      // 收取频率存的是中文（如「每15分钟」），必须用 parseFreqMinutes 映射；
      // 直接用 Number() 会得到 NaN 从而恒回落成 60 分钟，导致配置失效。
      const intervalMs = parseFreqMinutes(fields['收取频率'] ?? '每小时') * 60 * 1000;
      if (last && Date.now() - last < intervalMs) continue; // 未到收取频率，跳过
      const r = await this.syncAccount(id);
      results[String(fields['账户名称'] ?? id)] = r;
      synced++;
    }
    return { synced, results };
  }

  /** 解析附件下载链接（供前端下载归档附件）
   *  归档时附件会写入记录的原生「文件附件」字段，从而具备 bitablePerm 归属；
   *  这里优先用该归属换取预签名链接，避免只依赖上传后 20h 失效的 Redis 缓存。 */
  async getAttachmentUrl(recordId: string, fileToken: string): Promise<string> {
    const extra = await this.resolveAttachmentExtra(recordId, fileToken);
    if (extra) {
      try {
        const map = await this.fileUpload.getBatchTmpDownloadUrls([fileToken], extra);
        if (map[fileToken]) return map[fileToken];
      } catch (e) {
        this.logger.warn(`bitablePerm 换取下载链接失败 ${fileToken}: ${(e as Error).message}`);
      }
    }
    return this.fileUpload.resolveDownloadUrl(fileToken);
  }

  /** 从记录的「文件附件」字段里取出该附件的 bitablePerm 参数（url 上的 extra 查询串） */
  private async resolveAttachmentExtra(recordId: string, fileToken: string): Promise<string | undefined> {
    try {
      const rec = await this.base.get(this.meta.tableId, recordId);
      const list = rec?.fields?.['文件附件'];
      if (!Array.isArray(list)) return undefined;
      for (const att of list as Array<Record<string, unknown>>) {
        if (String(att?.file_token ?? '') !== fileToken) continue;
        const url = String(att?.url ?? '');
        if (!url) continue;
        try {
          return new URL(url).searchParams.get('extra') ?? undefined;
        } catch {
          return undefined;
        }
      }
    } catch (e) {
      this.logger.warn(`读取归档记录附件字段失败 ${recordId}: ${(e as Error).message}`);
    }
    return undefined;
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

  private parseAccount(f: Record<string, unknown>, recordId: string): ParsedAccount {
    let filters: MailFilterRule = {};
    try {
      if (typeof f['过滤规则'] === 'string' && f['过滤规则'].trim()) {
        filters = JSON.parse(f['过滤规则']) as MailFilterRule;
      }
    } catch {
      filters = {};
    }
    return {
      id: recordId,
      name: String(f['账户名称'] ?? ''),
      email: String(f['邮箱地址'] ?? ''),
      host: String(f['IMAP服务器'] ?? ''),
      port: Number(f['IMAP端口'] ?? 993) || 993,
      secure: String(f['使用SSL'] ?? '是') !== '否',
      user: String(f['用户名'] ?? ''),
      pass: String(f['密码'] ?? ''),
      freqMinutes: parseFreqMinutes(f['收取频率'] ?? '每小时'),
      filters,
      enabled: String(f['启用'] ?? '启用') !== '停用',
      sentFolder: String(f['发件箱文件夹'] ?? '').trim(),
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
    isSent = false,
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
    // 上传失败的附件不再静默丢弃：记录到「附件失败原因」，页面上可看到
    const failed: string[] = [];
    for (const att of attachments) {
      const buf = att.content;
      if (!buf || !Buffer.isBuffer(buf)) continue;
      const name = att.filename || 'attachment';
      const mime = att.contentType || 'application/octet-stream';
      try {
        const { file_token } = await this.fileUpload.uploadFile(buf, name, mime);
        meta.push({ name, size: buf.length, type: mime, file_token });
      } catch (e) {
        const reason = (e as Error).message;
        this.logger.warn(`附件上传失败 (${name}): ${reason}`);
        failed.push(`${name}：${reason.slice(0, 80)}`);
      }
    }

    const body = parsed.text || (parsed.html ? this.stripHtml(parsed.html) : '') || '';
    const dateIso = parsed.date ? new Date(parsed.date).toISOString() : new Date().toISOString();

    const fields: Record<string, unknown> = {
      '邮件UID': uid,
      '归属账户': acc.name,
      '邮箱文件夹': folder,
      '邮件方向': isSent ? '发件' : '收件',
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
    };
    // 附件 token 同时写入原生「文件附件」字段，使其具备 bitablePerm 归属，
    // 否则下载只能依赖上传后 20h 过期的 Redis 缓存。
    if (meta.length > 0) {
      fields['文件附件'] = meta.map((m) => ({ file_token: m.file_token }));
    }
    if (failed.length > 0) {
      fields['附件失败原因'] = failed.join('；').slice(0, 500);
    }

    await this.base.create(this.meta.tableId, fields);

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
