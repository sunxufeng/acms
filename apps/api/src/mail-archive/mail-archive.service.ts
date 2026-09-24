import { Injectable, Logger, Inject, NotFoundException } from '@nestjs/common';
import type { SessionUser } from '@acms/contracts';
import { TABLES, USER_TABLE } from '@acms/contracts';
import { BaseClient } from '@acms/base-adapter';
import { BASE_CLIENT, baseClientProvider } from '../base.provider.js';
import { AuditService } from '../audit/audit.service.js';
import { FileUploadService } from '../file-upload/file-upload.service.js';
import { FileStorageService } from '../file-storage/file-storage.service.js';
import { BaseRecordService } from '../shared/generic-crud.module.js';
import { FieldMaskService } from '../shared/field-mask.service.js';
import { buildFilter } from '../shared/record.util.js';
import { MAIL_ARCHIVE_META, idsOf } from './mail-archive.meta.js';
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

/** 附件上传的并发上限。太高会撞飞书上传接口限流（表现为大量 502），
 *  太低则大邮件仍然很慢。3 是实测下来既不超时也不触发限流的档位。 */
const ATTACHMENT_CONCURRENCY = 3;

/**
 * 「邮件 → 联系人 → 学生」三方一致化（2026-09-24 峰哥需求）。
 *
 * 规则（**只补不覆盖**，两个方向都做）：
 *   A. 邮件关联了联系人 ⇒ 把该联系人匹配到的**学生**补进邮件的「关联学生」
 *   B. 邮件关联了学生   ⇒ 把「关联学生ID」指向该学生的**联系人**补进「关联联系人」
 *
 * 为什么要 B（反向）：生产实测「关联联系人」几乎没人用（6383 封里只有 1 封），
 * 而老师习惯直接在邮件上挂学生 —— 只做 A 的话这条链子中间是空的，等于没效果。
 * 反过来，已有学生的邮件几乎都能找到家长联系人（数据上立刻见效）。
 *
 * 为什么落在**服务端**：所有关联写入都走 `link()`（前端「关联」面板的唯一入口），
 * 在这里收口一次就覆盖全部调用方；前端联动只能覆盖"手工点的那一下"，
 * 而 IMAP 同步、批量导入、以后的接口都绕过它。
 */
/**
 * 联系人「关联学生ID」的最低可信度。
 *
 * 该字段是 `matchStudents()` 按姓名/手机号**猜**出来的（带 `匹配置信度` 分数）。
 * 只认 ≥85（姓名 / 学生手机 / 家长电话 这三档；生产里 55–79 是「昵称包含学生姓名」这类弱匹配）
 * —— 弱匹配会把邮件挂到**错误的学生档案**上，而学生档案下方会直接显示这封邮件，错了很难被发现。
 * 所以**宁可不补，也不补错**。
 */
const LINK_MIN_CONFIDENCE = 85;

/** 联系人索引（联系人 id ↔ 学生 id）的缓存时长：3686 行全表扫，两次写入之间不必重扫 */
const CONTACT_INDEX_TTL_MS = 60_000;

/** 违规/悬空值的识别：`{"link_record_ids": null}` 这类「看着有值、解析后为空」的壳 */
function isShellLinkValue(raw: unknown): boolean {
  if (raw == null || Array.isArray(raw)) return false;
  const s = String(raw).trim();
  if (!s || s === '[]') return false;
  return idsOf(raw).length === 0;
}

/** 单个附件上传的超时（ms）。
 *  ⚠️ Node 的 fetch **默认没有超时** —— 飞书网关挂起时请求会一直挂着不返回，
 *  此前整轮同步就被这样的悬挂请求拖死（表现为日志里 UPLOAD_BAD_RESPONSE:502
 *  与 fetch failed 交替出现）。加了超时后是「快速失败」，下一轮再试即可。 */
const ATTACHMENT_UPLOAD_TIMEOUT_MS = 30_000;

/**
 * 有界并发执行：最多同时跑 limit 个任务，返回数组顺序与输入一致。
 * 单个任务抛错不会中断其他任务，也不会让 worker 提前退出导致剩余任务无人执行。
 */
async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      // 上面已保证 i < items.length；这里断言是 noUncheckedIndexedAccess 下的必要收窄
      const item = items[i] as T;
      try {
        out[i] = await fn(item, i);
      } catch {
        // 调用方应自行 catch；这里的兜底只是防止一个任务炸掉整个 worker
        // 从而让后面还没认领的任务永远没人执行。
        out[i] = undefined as unknown as R;
      }
    }
  };
  const n = Math.max(1, Math.min(limit, items.length || 1));
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}

/**
 * 把「最后收取时间」这类 datetime 字段值解析成毫秒时间戳。
 *
 * ⚠️ 全站通用坑：`BaseClient.fromReadFields` 会把 datetime 字段的毫秒时间戳
 * 转成 **字符串** —— "YYYY-MM-DD HH:mm"（带时间）或 "YYYY-MM-DD"（不带时间）。
 * 因此 `typeof v === 'number'` 判断日期字段**恒为 false**。
 *
 * 曾经的写法 `const last = typeof lastRaw === 'number' ? lastRaw : 0` 使 last 恒为 0，
 * 再配合 `if (last && ...)` 的 falsy 兜底，把「读不到时间」当成了「从没收过，赶紧同步」。
 * 结果：账户配置的「每天」实际退化成「每 15 分钟全量跑一轮」，放大 96 倍。
 *
 * 教训：**判断日期字段有没有值，绝不能靠 typeof === 'number'**；
 * 而且用 falsy 兜底会把「读不到」误解为「从未做过」——方向完全相反。
 */
function parseDateTimeValue(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
  const s = String(raw ?? '').trim();
  if (!s) return 0;
  // "2026-09-07 12:31" / "2026-09-07" 都能被 Date.parse 按本地时区解析
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
}

/** 一次同步的各阶段耗时累加（ms），用于定位「慢在哪一段」 */
export interface SyncTiming {
  /** IMAP 连接 + 登录 */
  connect: number;
  /** 预加载已归档 UID（飞书 search 翻页） */
  existing: number;
  /** IMAP FETCH 下载原始 MIME */
  fetch: number;
  /** simpleParser 解析 MIME */
  parse: number;
  /** 附件上传到飞书 */
  upload: number;
  /** 归档记录写入飞书 */
  write: number;
  /** 整轮总耗时 */
  total: number;
}

/** 单个文件夹的收取结果 */
export interface FolderStat {
  folder: string;
  isSent: boolean;
  /** 实际从 IMAP 下载并解析的封数（不含已归档被跳过的） */
  fetched: number;
  stored: number;
  /** 因已归档而在下载前就跳过的封数 —— 增量同步的稳态下这里应该是绝大多数 */
  skipped?: number;
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

  /** 联系人 ↔ 学生 索引（只含置信度达标的匹配），供「三方一致化」用；见 contactIndex() */
  private contactIdxCache?: {
    at: number;
    studentsByContact: Map<string, string[]>;
    contactsByStudent: Map<string, string[]>;
  };

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
    @Inject(FieldMaskService) mask: FieldMaskService,
  ) {
    super(MAIL_ARCHIVE_META, base, audit, mask);
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
    const syncStart = Date.now();
    // 各阶段耗时累加（ms）。此前完全埋点，同步慢时只能靠猜；现在日志里能直接看出
    // 时间花在查重预加载 / IMAP 下载 / MIME 解析 / 附件上传 / 飞书写入 的哪一段。
    const timing: SyncTiming = {
      connect: 0, existing: 0, fetch: 0, parse: 0, upload: 0, write: 0, total: 0,
    };

    try {
      const { ImapFlow } = await import('imapflow');
      const client = new ImapFlow({
        host: a.host,
        port: a.port,
        secure: a.secure,
        auth: { user: a.user, pass: a.pass },
        logger: false,
        // ⚠️ 显式超时：不设的话卡死的 IMAP 连接会一直挂着，把整轮同步（乃至后续的
        // 定时任务）无限期拖住。设成有限值，让失败快速暴露、下一轮可重试。
        connectionTimeout: 30_000,
        greetingTimeout: 30_000,
        socketTimeout: 120_000,
      });

      // ⚠️ 必须挂 error 监听 —— 这是**进程级保命**代码，不是可选的日志美化。
      // ImapFlow 是 EventEmitter：socket 超时、连接被服务端 RST、TLS 异常等都会以
      // 'error' 事件**异步**抛出，它不发生在任何 await 的调用栈上，因此外层 try/catch
      // 根本接不住。没有监听器时 Node 视其为 Unhandled 'error' event，**直接终止进程**。
      // 线上实测（2026-09-09 22:03:19）：`Error: Socket timeout` at TLSSocket._socketTimeout
      // → 整个 acms-api 崩溃，systemd restart counter 涨到 2；连带清空内存中
      // 的 getnote 管理员快照，用户下次打开「我的笔记」就要干等 5.7s 冷启动。
      client.on('error', (err: Error) => {
        this.logger.warn(
          `账户 ${a.name} IMAP 连接异常（已捕获，不影响服务）: ${err?.message ?? err}`,
        );
      });

      const tConn = Date.now();
      await client.connect();
      timing.connect = Date.now() - tConn;
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
        const tExisting = Date.now();
        const existing = await this.loadExistingUids(a.name);
        timing.existing = Date.now() - tExisting;
        this.logger.log(
          `账户 ${a.name} 已归档 ${existing.size} 封，开始增量收取（查重预加载耗时 ${timing.existing}ms）`,
        );

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
            let fSkipped = 0;
            for (const uid of uids) {
              // ⚠️ 查重必须在下载**之前**。
              // 此前是「先 fetchOne + simpleParser，再进 archiveOne 查重」，而 existing
              // 明明已经预加载好了 —— 于是每轮都要把整个邮箱的邮件重新下载并解析一遍
              // （数百封 × 每封完整 MIME），所谓「增量同步」实际上等于「全量同步」。
              // 移到下载前之后，稳态下每轮只有真正的新邮件才会产生 IMAP 流量。
              if (existing.has(this.uidKey(folder, String(uid)))) {
                fSkipped++;
                continue;
              }
              fFetched++;
              if (progress) progress.fetched++;
              // uid 要放在第三个参数 options 里才会走 `UID FETCH`；
              // 放在第二个参数 query 里只是「顺便取回 UID 属性」，并不会改变按序号取的模式。
              const t0 = Date.now();
              const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
              timing.fetch += Date.now() - t0;
              if (!msg || !msg.source) continue;
              const { simpleParser } = await import('mailparser');
              const t1 = Date.now();
              const parsed = await simpleParser(msg.source);
              timing.parse += Date.now() - t1;
              if (!this.matchFilter(a.filters, parsed, isSent)) continue;
              // 以服务端返回的 UID 为准（imapflow 的 FETCH 响应总是带 uid）
              const mailUid = msg.uid != null ? String(msg.uid) : String(uid);
              const saved = await this.archiveOne(a, folder, mailUid, parsed, isSent, existing, timing);
              if (saved) {
                fStored++;
                if (progress) progress.stored++;
              }
            }
            folderStats.push({ folder, isSent, fetched: fFetched, stored: fStored, skipped: fSkipped });
            if (progress) {
              // 进度里保留每个文件夹的实时计数，便于前端展示「收件箱 x/y」
              const cur = progress.folders.find((f) => f.folder === folder);
              if (cur) Object.assign(cur, { fetched: fFetched, stored: fStored, skipped: fSkipped });
              else
                progress.folders.push({
                  folder, isSent, fetched: fFetched, stored: fStored, skipped: fSkipped,
                });
            }
          } finally {
            lock.release();
          }
        }
      } finally {
        // ⚠️ 关闭失败不能掩盖真实错误：连接已经断掉时 logout() 自己会抛，
        // 若不接住，原本「收取成功/某封失败」的结论会被替换成一句无关的登出异常。
        try {
          await client.logout();
        } catch {
          /* 连接可能已断开，忽略 */
        }
        try {
          client.close();
        } catch {
          /* 已关闭，忽略 */
        }
      }
    } catch (e) {
      // ⚠️ imapflow 把服务器的真实原因放在 responseText 里，message 往往只是干巴巴的
      // 「Command failed」。此前只取 message，用户看到「失败：Command failed」根本无从下手
      // （2026-09-09 实测：6 个账户其实是密码/授权码不对，服务器原话是
      //  "Login fail. Account is abnormal, service is not open, password is incorrect...")。
      lastErr = this.describeImapError(e);
      this.logger.error(`账户 ${a.name} 同步失败: ${lastErr}`);
    }

    const fetched = folderStats.reduce((s, f) => s + f.fetched, 0);
    const stored = folderStats.reduce((s, f) => s + f.stored, 0);
    const skipped = folderStats.reduce((s, f) => s + (f.skipped ?? 0), 0);
    timing.total = Date.now() - syncStart;
    this.logger.log(
      `账户 ${a.name} 同步耗时 ${timing.total}ms ` +
        `[连接 ${timing.connect} / 查重预加载 ${timing.existing} / 下载 ${timing.fetch} / ` +
        `解析 ${timing.parse} / 附件上传 ${timing.upload} / 写库 ${timing.write}] ` +
        `下载 ${fetched} 封、新增 ${stored} 封、跳过已归档 ${skipped} 封`,
    );

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
   * 把 imapflow 的异常翻成「人能看懂、且知道下一步干什么」的中文提示。
   *
   * imapflow 的 Error.message 常常只是 `Command failed`，真正的服务器原话在
   * `responseText` 上；还有一类异常 message 直接是空串（连服务器都没搭上话），
   * 此前写进「最后收取结果」就是「失败：」后面一片空白 —— 用户和管理员都一脸懵。
   */
  private describeImapError(e: unknown): string {
    const err = e as {
      message?: string;
      responseText?: string;
      serverResponseCode?: string;
      code?: string;
    };
    const msg = String(err?.message ?? '').trim();
    const resp = String(err?.responseText ?? '').trim();
    const code = String(err?.serverResponseCode ?? err?.code ?? '').trim();
    const raw = `${msg} ${resp} ${code}`;

    // 登录类：腾讯企业邮/QQ 邮箱系的原话是 "Login fail. Account is abnormal, ..."，
    // 标准 IMAP 则是 AUTHENTICATIONFAILED。这类错重试没用，必须改配置。
    if (/login fail|authenticationfailed|invalid credential|authentication failed/i.test(raw)) {
      return (
        'IMAP 登录失败：邮箱密码或「客户端专用授权码」不正确，或该邮箱未开启 IMAP 服务。' +
        '请在邮箱网页端 → 设置 → 账户 中开启 IMAP/SMTP 并生成专用密码后重新填写' +
        `（服务器原话：${resp || msg || '无'}）`
      );
    }
    // 主机名/网络类
    if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(raw)) {
      return `IMAP 服务器地址无法解析：请检查「IMAP服务器」填写是否正确（${msg || resp || 'DNS 解析失败'}）`;
    }
    if (/ECONNREFUSED/i.test(raw)) {
      return `IMAP 连接被拒绝：服务器地址或端口不对（${msg || resp}）`;
    }
    if (/ETIMEDOUT|timed out|socket timeout/i.test(raw)) {
      return `IMAP 连接超时：服务器无响应，可能是端口/SSL 配置不匹配或网络不通（${msg || resp}）`;
    }
    if (/certificate|self.signed|unable to verify/i.test(raw)) {
      return `IMAP SSL 证书校验失败：请确认「启用SSL」与端口匹配（${msg || resp}）`;
    }
    // 兜底：把服务器原话带上，胜过只有一句 Command failed
    const parts = [msg, resp, code].filter(Boolean);
    return parts.length ? parts.join(' | ') : '未知错误（未拿到服务器返回信息）';
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
      // pageSize 用飞书单页上限 500（此前是 100，Sally 2287 条要串行翻 23 次）。
      // ⚠️ 别再往上调：search 直接把 pageSize 拼进 URL，超过 500 飞书会报错。
      const res = await this.base.search(this.meta.tableId, {
        pageSize: 500,
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
   * 「我」可见的**账户名 → 关联用户姓名**映射。
   *
   * ⚠️ 不能直接复用「邮件账户」列表接口：两张表的行级范围口径**不同** ——
   *    账户表 = 「自己创建的」，归档表 = 「我关联的账户」（关联用户里包含我）。
   *    别人创建、把我加进关联名单的账户，在账户列表里看不到，但它的邮件我该看得到；
   *    若这里按账户表口径算，「用户」列对这类账户会是空的。
   * 管理员（rowScope 豁免角色）拿全部账户。
   */
  private async visibleAccounts(user: SessionUser): Promise<Map<string, string>> {
    const bypass = this.meta.rowScopeBypassRoles ?? ['系统管理员'];
    const isAdmin = (user.roles ?? []).some((r) => bypass.includes(r));
    const users = await this.scopeContext().search(USER_TABLE.tableId);
    const nameById = new Map<string, string>();
    for (const u of users) nameById.set(String(u.id ?? ''), String(u['姓名'] ?? '').trim());
    const me = users.find((r) => String(r['飞书 Open ID'] ?? '').trim() === user.openId);
    const myId = String(me?.id ?? '');
    const accounts = await this.scopeContext().search(TABLES.mailAccount.tableId);
    const out = new Map<string, string>();
    for (const a of accounts) {
      const ids = idsOf(a['关联用户']);
      if (!isAdmin && (!myId || !ids.includes(myId))) continue;
      const name = String(a['账户名称'] ?? '').trim();
      if (!name) continue;
      out.set(name, ids.map((id) => nameById.get(id) ?? '').filter(Boolean).join('、'));
    }
    return out;
  }

  /**
   * 「账户名称 → 邮箱地址」映射（账户表只有几十条，一次拉全表）。
   *
   * 为什么需要这张对照表：归档记录里的「归属账户」存的是**账户名称**（写入时取 `acc.name`），
   * 而老师在界面上是按**邮箱地址**认账户的。列表页要「显示邮箱」，筛选下拉也要「按邮箱认」，
   * 两处都从这里换算 —— 只留一份对照关系，不各写各的。
   */
  private async accountEmailMap(): Promise<Map<string, string>> {
    const accounts = await this.scopeContext().search(TABLES.mailAccount.tableId);
    const out = new Map<string, string>();
    for (const a of accounts) {
      const name = String(a['账户名称'] ?? '').trim();
      const email = String(a['邮箱地址'] ?? '').trim();
      if (name && email) out.set(name, email);
    }
    return out;
  }

  /**
   * 列表页「邮箱」筛选下拉的候选：当前用户**可见**的账户（含邮箱地址）。
   *
   * 🔴 可见性直接复用 `visibleAccounts()`，**不另写一份判据** —— 否则「下拉里能选的账户」
   * 与「实际能看的邮件」一旦分叉，就会出现「下拉里有它、按它筛却一条不剩」的怪现象
   *（这一条是行级隔离与筛选口径必须同源的通用教训）。
   * 邮箱为空的老账户：下拉里退回显示账户名称（否则会出现一个选不出东西的空选项）。
   */
  async accountOptions(user: SessionUser): Promise<{ name: string; email: string }[]> {
    const visible = await this.visibleAccounts(user);
    const emails = await this.accountEmailMap();
    return [...visible.keys()].map((name) => ({ name, email: emails.get(name) ?? '' }));
  }

  /**
   * 列表：给每行注入「归属用户」= 该账户的关联人姓名（多人用「、」并列）。
   *
   * 决策 10：**不把归属冗余进归档记录**，展示时实时按账户算 ——
   * 管理员改了某个账户的关联人，列表立刻跟着变，不需要回填 6328 封历史数据。
   * 账户只有几十条，一次拉全表即可；非管理员只会拿到自己可见的账户，不构成越权。
   */
  async list(user: SessionUser, query: Record<string, string | undefined>) {
    const res = await super.list(user, query);
    if (!res.items.length) return res;
    const map = await this.visibleAccounts(user);
    const emails = await this.accountEmailMap();
    for (const it of res.items) {
      const acc = String(it['归属账户'] ?? '').trim();
      it['归属用户'] = map.get(acc) ?? '';
      // 「邮箱」= 该账户在「邮件账户」里配置的邮箱地址；与「归属用户」同样是**实时算**的，
      // 管理员改了账户邮箱，列表立刻跟着变，不用回填历史数据。
      it['邮箱'] = emails.get(acc) ?? '';
    }
    return res;
  }

  /**
   * 手动关联/解除关联，一次可只改一类。
   * @param ids.studentIds 关联学生的**完整**列表（传 [] 即清空）；`undefined` 表示不动该字段
   * @param ids.contactIds 关联联系人的完整列表，语义同上
   */
  async link(
    user: SessionUser,
    recordId: string,
    ids: { studentIds?: string[]; contactIds?: string[] },
  ): Promise<void> {
    // ⚠️ 自建写接口**不经过 detail()**，必须自己过一道行级数据范围 ——
    // 否则知道一个 record id 就能往别人的邮件上挂学生/联系人。
    if (!(await this.rowVisible(user, recordId))) throw new NotFoundException('NOT_FOUND');
    const clean = (arr: string[] | undefined): string[] =>
      (arr ?? []).filter((id) => typeof id === 'string' && id.trim().length > 0);
    const patch: Record<string, unknown> = {};
    // 关联字段（type=18）写入格式为 record_id 字符串数组：["recxxx"]
    if (ids.studentIds !== undefined) patch['关联学生'] = clean(ids.studentIds);
    if (ids.contactIds !== undefined) patch['关联联系人'] = clean(ids.contactIds);
    if (!Object.keys(patch).length) return;
    await this.base.update(this.meta.tableId, recordId, patch);

    // ① 老师手工改完之后，立刻按「三方一致化」补上传递关系（联系人 ↔ 学生）。
    //    收口在服务端而不是前端联动：前端只能覆盖"手工点的那一下"，IMAP 同步、
    //    批量导入、以后的接口都会绕过它。
    // ② ⚠️ 已知且刻意保留的语义：若老师把「学生」清空、但联系人仍挂着，
    //    这一步会把该联系人对应的学生**补回来**（因为「只补不覆盖」且没有"人工排除清单"）。
    //    要彻底表达"这封邮件与该学生无关"，需把联系人也取消。
    //    若要支持"取消后不再补"，得加一个隐藏的排除字段（峰哥 2026-09-24 决定先不做）。
    await this.reconcileRecord(recordId);
  }

  /**
   * 联系人索引：只收**置信度达标**的匹配（见 `LINK_MIN_CONFIDENCE`）。
   *   studentsByContact: 联系人 id → 学生 id[]（正常 1 个，matchStudents 是单值匹配）
   *   contactsByStudent: 学生 id → 联系人 id[]（一个学生常有爸爸/妈妈多个联系人）
   */
  private async contactIndex(): Promise<{
    studentsByContact: Map<string, string[]>;
    contactsByStudent: Map<string, string[]>;
  }> {
    if (this.contactIdxCache && Date.now() - this.contactIdxCache.at < CONTACT_INDEX_TTL_MS) {
      return this.contactIdxCache;
    }
    const studentsByContact = new Map<string, string[]>();
    const contactsByStudent = new Map<string, string[]>();
    let pageToken: string | undefined;
    let guard = 0;
    do {
      const res = await this.base.search(TABLES.weilingContact.tableId, { pageSize: 500, pageToken });
      for (const item of res.items ?? []) {
        const rec = item as { recordId?: string; id?: string; fields?: Record<string, unknown> };
        const cid = String(rec.recordId ?? rec.id ?? '').trim();
        const f = (rec.fields ?? rec) as Record<string, unknown>;
        const sid = String(f['关联学生ID'] ?? '').trim();
        const conf = Number(f['匹配置信度'] ?? 0);
        if (!cid || !sid || !Number.isFinite(conf) || conf < LINK_MIN_CONFIDENCE) continue;
        studentsByContact.set(cid, [sid]);
        const back = contactsByStudent.get(sid) ?? [];
        back.push(cid);
        contactsByStudent.set(sid, back);
      }
      pageToken = res.pageToken;
    } while (pageToken && guard++ < 40);
    this.contactIdxCache = { at: Date.now(), studentsByContact, contactsByStudent };
    return this.contactIdxCache;
  }

  /** 按联系人索引算出该邮件**应该**有的关联（并集：原有 ∪ 派生） */
  private reconcileFields(
    fields: Record<string, unknown>,
    idx: { studentsByContact: Map<string, string[]>; contactsByStudent: Map<string, string[]> },
  ): { students: string[]; contacts: string[]; changed: boolean } {
    // 🔴 判空一律用 idsOf：`{"link_record_ids": null}` 这类壳值会让
    //    `String(v) !== ''` 式的判空误判成"已有关联"（生产里 816 封都是壳值）。
    const students = new Set(idsOf(fields['关联学生']));
    const contacts = new Set(idsOf(fields['关联联系人']));
    const before = students.size + contacts.size;
    // 传递闭包：最多 3 轮。联系人的「关联学生ID」是单值 ⇒ 实际 1–2 轮就稳定；
    // 留余量是为了以后改成多值时不漏，且有 guard、不会发散。
    for (let round = 0; round < 3; round += 1) {
      let grew = false;
      for (const c of [...contacts]) {
        for (const s of idx.studentsByContact.get(c) ?? []) {
          if (!students.has(s)) { students.add(s); grew = true; }
        }
      }
      for (const s of [...students]) {
        for (const c of idx.contactsByStudent.get(s) ?? []) {
          if (!contacts.has(c)) { contacts.add(c); grew = true; }
        }
      }
      if (!grew) break;
    }
    return {
      students: [...students],
      contacts: [...contacts],
      changed: students.size + contacts.size !== before,
    };
  }

  /** 补全一封邮件的传递关联（幂等）。返回是否写了库。 */
  private async reconcileRecord(recordId: string): Promise<boolean> {
    const rec = await this.base.get(this.meta.tableId, recordId);
    if (!rec) return false;
    const f = (rec.fields ?? {}) as Record<string, unknown>;
    const idx = await this.contactIndex();
    const r = this.reconcileFields(f, idx);
    const patch: Record<string, unknown> = {};
    // 除了"有新东西可补"，顺手把壳值清成 []：它会让各处判空失效（见 isShellLinkValue）
    if (r.changed || isShellLinkValue(f['关联学生'])) patch['关联学生'] = r.students;
    if (r.changed || isShellLinkValue(f['关联联系人'])) patch['关联联系人'] = r.contacts;
    if (!Object.keys(patch).length) return false;
    await this.base.update(this.meta.tableId, recordId, patch);
    return true;
  }

  /**
   * 全量重算邮件关联（幂等）：给历史数据补上传递关系，并清掉悬空的壳值。
   *
   * 为什么需要它：`link()` 只在**老师手工改关联**时触发，历史邮件（含本次上线前
   * 那几封「已挂学生」的邮件）不会自己变。用手动入口而不是常驻定时任务 ——
   * 数据"自己变了"会让人困惑，而这个动作的语义是管理员主动发起的一次整理。
   */
  async reconcileAll(): Promise<{ scanned: number; fixed: number; cleaned: number }> {
    const idx = await this.contactIndex();
    let scanned = 0;
    let fixed = 0;
    let cleaned = 0;
    let pageToken: string | undefined;
    let guard = 0;
    do {
      const res = await this.base.search(this.meta.tableId, { pageSize: 200, pageToken });
      for (const item of res.items ?? []) {
        const rec = item as { recordId?: string; id?: string; fields?: Record<string, unknown> };
        const rid = String(rec.recordId ?? rec.id ?? '').trim();
        if (!rid) continue;
        scanned += 1;
        const f = (rec.fields ?? rec) as Record<string, unknown>;
        const shell = isShellLinkValue(f['关联学生']) || isShellLinkValue(f['关联联系人']);
        const r = this.reconcileFields(f, idx);
        if (!r.changed && !shell) continue;
        const patch: Record<string, unknown> = {};
        if (r.changed || isShellLinkValue(f['关联学生'])) patch['关联学生'] = r.students;
        if (r.changed || isShellLinkValue(f['关联联系人'])) patch['关联联系人'] = r.contacts;
        try {
          await this.base.update(this.meta.tableId, rid, patch);
          if (r.changed) fixed += 1;
          if (shell) cleaned += 1;
        } catch (e) {
          this.logger.warn(`重算关联失败 ${rid}：${(e as Error).message.slice(0, 120)}`);
        }
      }
      pageToken = res.pageToken;
    } while (pageToken && guard++ < 60);
    this.logger.log(`邮件关联重算完成：扫描 ${scanned}，补全 ${fixed}，清理壳值 ${cleaned}`);
    return { scanned, fixed, cleaned };
  }

  /**
   * 返回邮件归档各筛选列（发件人/收件人/归属账户/邮箱文件夹/关联学生）的
   * 真实去重候选项，供列表页下拉框动态加载（避免写死枚举、也避免只显示空「全部」）。
   * 一次翻页扫描全表，关联字段取解析后的名称（text）。每个字段上限 300 项，按中文排序。
   *
   * ⚠️ 「归属账户」的候选项必须收在调用方自己的可见范围内：否则非管理员的下拉里会列出
   *    全公司的邮箱账户名 —— 既是信息泄露，选了也筛不出东西（会被行范围 AND 掉）。
   */
  async getFilterOptions(user: SessionUser): Promise<Record<string, string[]>> {
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
    // 「归属账户」只留可见范围内的（管理员 = 全部，非管理员 = 自己关联的账户）
    const visible = await this.visibleAccounts(user);
    out['归属账户'] = (out['归属账户'] ?? []).filter((n) => visible.has(n));
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
    let throttled = 0;
    for (const row of res.items) {
      const id = row.recordId;
      const fields = row.fields as Record<string, unknown>;
      const name = String(fields['账户名称'] ?? id);
      // ⚠️ 「最后收取时间」读回来是 **字符串** "YYYY-MM-DD HH:mm"：base-adapter 的
      // fromReadFields 会把 datetime 的毫秒时间戳转成本地时间字符串。
      // 所以 `typeof lastRaw === 'number'` 恒为 false —— 必须走 parseDateTimeValue。
      const last = parseDateTimeValue(fields['最后收取时间']);
      // 收取频率存的是中文（如「每15分钟」），必须用 parseFreqMinutes 映射；
      // 直接用 Number() 会得到 NaN 从而恒回落成 60 分钟，导致配置失效。
      const intervalMs = parseFreqMinutes(fields['收取频率'] ?? '每小时') * 60 * 1000;
      if (last && Date.now() - last < intervalMs) {
        throttled++; // 未到收取频率，跳过
        continue;
      }
      const r = await this.syncAccount(id);
      results[name] = r;
      synced++;
    }
    // 此前这里因为 last 恒为 0 而永不跳过，日志打出来就能立刻看出节流是否真的生效
    this.logger.log(`syncAll：启用账户 ${res.items.length} 个，实际同步 ${synced} 个，按频率跳过 ${throttled} 个`);
    return { synced, results };
  }

  /** 解析附件下载链接（供前端下载归档附件）
   *  附件已全部落在本地磁盘，统一走本站代理直链；
   *  迁移前遗留的非 loc_ 标记视为失效，由 resolveViewUrl 直接 404。 */
  async getAttachmentUrl(fileToken: string): Promise<string> {
    return this.fileUpload.resolveViewUrl(fileToken);
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
    timing?: SyncTiming,
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

    // 先过滤掉没有内容的附件，避免把无效项算进并发槽位
    const attachments = (parsed.attachments ?? []).filter(
      (att): att is { filename?: string; contentType?: string; content: Buffer } =>
        Boolean(att?.content) && Buffer.isBuffer(att.content),
    );
    const meta: { name: string; size: number; type: string; file_token: string }[] = [];
    // 上传失败的附件不再静默丢弃：记录到「附件失败原因」，页面上可看到
    const failed: string[] = [];
    if (attachments.length > 0) {
      const tUp = Date.now();
      // 有界并发上传：此前是严格串行，一个附件卡住就阻塞整封邮件、进而阻塞整轮。
      // 配合 uploadFile 的超时参数，失败快速返回，不会把整轮同步拖死。
      const results = await runWithConcurrency(
        attachments,
        ATTACHMENT_CONCURRENCY,
        async (att) => {
          const buf = att.content;
          const name = att.filename || 'attachment';
          const mime = att.contentType || 'application/octet-stream';
          try {
            const { file_token } = await this.fileUpload.uploadFile(
              buf, name, mime, ATTACHMENT_UPLOAD_TIMEOUT_MS,
            );
            return { ok: true as const, name, size: buf.length, type: mime, file_token };
          } catch (e) {
            const reason = (e as Error).message;
            this.logger.warn(`附件上传失败 (${name}): ${reason}`);
            return { ok: false as const, name, reason };
          }
        },
      );
      if (timing) timing.upload += Date.now() - tUp;
      for (const r of results) {
        if (!r) continue;
        if (r.ok) meta.push({ name: r.name, size: r.size, type: r.type, file_token: r.file_token });
        else failed.push(`${r.name}：${r.reason.slice(0, 80)}`);
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

    const tWrite = Date.now();
    await this.base.create(this.meta.tableId, fields);
    if (timing) timing.write += Date.now() - tWrite;
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
}
