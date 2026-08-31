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
export interface FolderStat {
  folder: string;
  isSent: boolean;
  fetched: number;
  stored: number;
  error?: string;
}

/**
 * 后台同步任务的实时进度。
 * 「立即收取」改为异步后 HTTP 立即返回，前端轮询该状态展示进度，
 * 避免大邮箱（数百封）同步耗时超过 nginx proxy_read_timeout 而被掐断成 504。
 */
export interface SyncProgress {
  running: boolean;
  startedAt: number;
  finishedAt?: number;
  fetched: number;
  stored: number;
  folders: FolderStat[];
  error?: string;
  result?: string;
}

@Injectable()
export class MailArchiveService extends BaseRecordService {
  private readonly logger = new Logger('MailArchive');

  /** 账户 ID → 最近一次同步的进度（「立即收取」异步化后供前端轮询） */
  private readonly syncStates = new Map<string, SyncProgress>();

  /**
   * ⚠️ 后两个参数必须写显式 @Inject，否则会被父类的注入元数据覆盖。
   *
   * 父类 BaseRecordService 的构造函数是 (meta, @Inject(BASE_CLIENT) base, @Inject(AuditService) audit)，
   * 其 self:paramtypes 的 index 2 是 AuditService。而 Nest 的 Inject 装饰器内部用
   * Reflect.getMetadata（会沿原型链继承父类元数据）读取后再 defineMetadata 写回子类，
   * 于是父类那条 index 2 = AuditService 会残留到本类的 index 2（即 fileUpload）槽位，
   * 表现为 this.fileUpload.uploadFile is not a function。
   *
   * 结论：子类的构造参数多于父类时，多出来的槽位一律显式标注 token。
   */
  constructor(
    @Inject(BASE_CLIENT) base: BaseClient,
    @Inject(AuditService) audit: AuditService,
    @Inject(FileUploadService) private readonly fileUpload: FileUploadService,
    @Inject(MailAccountService) private readonly accountSvc: MailAccountService,
  ) {
    super(MAIL_ARCHIVE_META, base, audit);
  }

  /**
   * 同步单个账户；返回本次收取统计（含每个文件夹的明细）。
   * @param progress 传入则由同步过程实时写入 fetched/stored，供前端轮询展示进度。
   */
  async syncAccount(accountId: string, progress?: SyncProgress): Promise<{
    ok: boolean;
    fetched: number;
    stored: number;
    error?: string;
    folders: FolderStat[];
    resultText?: string;
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

        // 批量预加载该账户已归档的 UID（一次翻页扫完，替代此前「每封一次飞书查询」）。
        // 邮件量从数十封涨到数百封后，逐封查重意味着数百次 API 调用，是同步变慢的主因。
        const existing = await this.loadExistingUids(a.name);
        this.logger.log(`账户 ${a.name} 已归档 ${existing.size} 封，开始增量收取`);

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
            // ⚠️ 必须传 { uid: true }：imapflow 不传时返回的是 1..N 的**序号**（sequence number），
            // 会随邮件删除整体前移而漂移，不能作为去重键。实测同一邮箱：
            // 序号 = 1..20，而真实 UID = 84..102,105（其中 103/104 已被删除）。
            const searchRes = await client.search({}, { uid: true });
            // 不再截断（此前 .slice(-500) 会静默丢弃单文件夹超过 500 封的较早邮件）。
            // 依赖邮件UID去重避免重复入库；超大邮箱的逐封解析开销由「收取频率」节流控制。
            const uids = Array.isArray(searchRes) ? searchRes : [];
            for (const uid of uids) {
              fFetched++;
              if (progress) progress.fetched++;
              // uid 要放在第三个参数 options 里才会走 `UID FETCH`；
              // 放在第二个参数 query 里只是「顺便取回 UID 属性」，并不会改变按序号取的模式。
              const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
              if (!msg || !msg.source) continue;
              const { simpleParser } = await import('mailparser');
              const parsed = await simpleParser(msg.source);
              if (!this.matchFilter(a.filters, parsed, isSent)) continue;
              // 以服务端返回的 UID 为准（imapflow 的 FETCH 响应总是带 uid）
              const mailUid = msg.uid != null ? String(msg.uid) : String(uid);
              const saved = await this.archiveOne(a, folder, mailUid, parsed, isSent, existing);
              if (saved) {
                fStored++;
                if (progress) progress.stored++;
              }
            }
            folderStats.push({ folder, isSent, fetched: fFetched, stored: fStored });
            if (progress) {
              // 进度里保留每个文件夹的实时计数，便于前端展示「收件箱 x/y」
              const cur = progress.folders.find((f) => f.folder === folder);
              if (cur) Object.assign(cur, { fetched: fFetched, stored: fStored });
              else progress.folders.push({ folder, isSent, fetched: fFetched, stored: fStored });
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

    return { ok: !lastErr, fetched, stored, error: lastErr || undefined, folders: folderStats, resultText };
  }

  /**
   * 异步启动「立即收取」：HTTP 立即返回，同步在后台执行，进度写入 syncStates 供轮询。
   * 同一个账户已在同步中时直接返回现有状态，不重复启动（避免并发把同一批邮件收两遍）。
   */
  startSync(accountId: string): SyncProgress {
    const running = this.syncStates.get(accountId);
    if (running?.running) return running;
    const state: SyncProgress = {
      running: true,
      startedAt: Date.now(),
      fetched: 0,
      stored: 0,
      folders: [],
    };
    this.syncStates.set(accountId, state);
    void this.runSync(accountId, state); // 不 await：后台跑
    return state;
  }

  /** 查询某账户当前/最近一次同步进度 */
  getSyncStatus(accountId: string): SyncProgress {
    return this.syncStates.get(accountId) ?? {
      running: false, startedAt: 0, fetched: 0, stored: 0, folders: [],
    };
  }

  /** 后台执行同步并把结果回填到进度对象 */
  private async runSync(accountId: string, state: SyncProgress): Promise<void> {
    try {
      const r = await this.syncAccount(accountId, state);
      state.folders = r.folders;
      state.error = r.error;
      state.result = r.resultText;
    } catch (e) {
      state.error = (e as Error).message;
    } finally {
      state.running = false;
      state.finishedAt = Date.now();
    }
  }

  /**
   * 预加载某账户已归档的全部「文件夹+UID」组合。
   * 替代此前每封邮件一次飞书 search 的做法：数百封邮件 = 数百次 API 调用 → 降为 1 次翻页扫描。
   * 返回的 key 形如 `INBOX\u0000123`，与 archiveOne 的 uidKey 保持一致。
   */
  private async loadExistingUids(accountName: string): Promise<Set<string>> {
    const set = new Set<string>();
    let pageToken: string | undefined;
    let guard = 0;
    do {
      const res = await this.base.search(this.meta.tableId, {
        pageSize: 100,
        pageToken,
        filter: buildFilter([{ field: '归属账户', value: [accountName] }]),
      });
      for (const item of res.items) {
        const f = (item.fields ?? {}) as Record<string, unknown>;
        const uid = this.plainText(f['邮件UID']);
        if (!uid) continue;
        set.add(this.uidKey(this.plainText(f['邮箱文件夹']), uid));
      }
      pageToken = res.pageToken;
    } while (pageToken && guard++ < 500);
    return set;
  }

  /** 飞书文本字段可能返回 string 或 [{ text }]，统一取纯文本 */
  private plainText(v: unknown): string {
    if (v == null) return '';
    if (typeof v === 'string') return v.trim();
    if (Array.isArray(v)) {
      const first = (v as Array<{ text?: unknown }>)[0];
      return typeof first?.text === 'string' ? first.text.trim() : '';
    }
    return '';
  }

  /** 去重键：IMAP 的 UID 按文件夹独立编号，必须带文件夹维度 */
  private uidKey(folder: string, uid: string): string {
    return `${folder} ${uid}`;
  }

  /**
   * 返回邮件归档各筛选列（发件人/收件人/归属账户/邮箱文件夹/关联学生）的
   * 真实去重候选项，供列表页下拉框动态加载（避免写死枚举、也避免只显示空「全部」）。
   * 一次翻页扫描全表，关联字段取解析后的名称（text）。每个字段上限 300 项，按中文排序。
   */
  async getFilterOptions(): Promise<Record<string, string[]>> {
    const fields = ['发件人', '收件人', '归属账户', '邮箱文件夹', '关联学生'];
    const sets: Record<string, Set<string>> = {};
    for (const f of fields) sets[f] = new Set();
    let pageToken: string | undefined;
    let guard = 0;
    do {
      const res = await this.base.search(this.meta.tableId, { pageSize: 100, pageToken });
      for (const item of res.items) {
        const flds = (item.fields ?? {}) as Record<string, unknown>;
        for (const f of fields) {
          const set = sets[f];
          if (!set) continue;
          const v = flds[f];
          if (v == null) continue;
          if (Array.isArray(v)) {
            // 关联字段：[{ text, link }]
            for (const el of v as Array<{ text?: unknown }>) {
              const t = typeof el?.text === 'string' ? (el.text as string).trim() : '';
              if (t) set.add(t);
            }
          } else if (typeof v === 'string' && v.trim()) {
            set.add(v.trim());
          }
        }
      }
      pageToken = res.pageToken;
    } while (pageToken && guard++ < 200);
    const out: Record<string, string[]> = {};
    for (const f of fields) {
      const set = sets[f];
      out[f] = set ? Array.from(set).sort((a, b) => a.localeCompare(b, 'zh-CN')).slice(0, 300) : [];
    }
    return out;
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

  /** 单封邮件落库；已存在（同账户+同文件夹+同UID）则跳过，返回是否新增。
   *  @param existing 该账户已归档的 uidKey 集合（由 loadExistingUids 一次性预加载）。
   *                  传了就走内存去重，不再逐封查飞书。 */
  private async archiveOne(
    acc: ParsedAccount,
    folder: string,
    uid: string,
    parsed: { from?: { text?: string }; to?: { text?: string }; cc?: { text?: string }; subject?: string; date?: Date; text?: string; html?: string; attachments?: Array<{ filename?: string; contentType?: string; content?: Buffer }> },
    isSent = false,
    existing?: Set<string>,
  ): Promise<boolean> {
    // 去重：同账户 + 同文件夹 + 同 UID 已存在则跳过。
    // ⚠️ IMAP 的 UID 是按文件夹独立编号的，收件箱与发件箱会有相同 UID，
    // 因此去重必须带「邮箱文件夹」维度，否则发件箱邮件会被误判为重复而丢失。
    const key = this.uidKey(folder, uid);
    if (existing) {
      if (existing.has(key)) return false;
    } else {
      // 未预加载时的兜底（保持原有逐封查询语义）
      const dup = await this.base.search(this.meta.tableId, {
        pageSize: 1,
        filter: buildFilter([
          { field: '邮件UID', value: [uid] },
          { field: '归属账户', value: [acc.name] },
          { field: '邮箱文件夹', value: [folder] },
        ]),
      });
      if (dup.items.length > 0) return false;
    }

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
      '关联学生': [], // 关联字段（type=18）必须是数组，空数组表示未关联
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
    // 同一批次内再次遇到相同 key 时直接跳过，避免重复入库
    existing?.add(key);

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

  /**
   * 手动关联/解除关联学生（招生老师在 UI 上操作）。
   * studentIds 为完整列表：传 [] 即清空关联；传若干 record_id 即设为这些学生。
   * 关联字段（type=18）写入格式为 [{ record_id }]，base-adapter 透传。
   */
  async linkStudents(recordId: string, studentIds: string[]): Promise<void> {
    // 飞书单向关联（type=18）写入格式为 record_id 字符串数组：["recxxx"]
    const links = (studentIds || [])
      .filter((id) => typeof id === 'string' && id.length > 0);
    await this.base.update(this.meta.tableId, recordId, { '关联学生': links });
  }
}
