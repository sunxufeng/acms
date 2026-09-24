import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  ARCHIVE_JOB_FIELDS,
  NOTE_ARCHIVE_FAIL,
  NOTE_ARCHIVE_JOB_SEEDS,
  NOTE_ARCHIVE_KINDS,
  NOTE_ARCHIVE_OK,
  TABLES,
  archiveJobRowFields,
  archiveJobScheduleText,
  beijingClock,
  beijingDate,
  isArchivedNote,
  noteArchiveBody,
  noteArchiveFileName,
  noteArchiveRecordId,
  noteMatchesArchiveJob,
  normalizeNoteStatus,
  normalizeOwnerFolderName,
  parseArchiveJobRow,
  shouldRunArchiveJob,
  validateArchiveJob,
  weekdaySummary,
  type NoteArchiveJobDef,
  type NoteArchiveJobKey,
} from '@acms/contracts';
import { getSqlStore } from '../base.provider.js';
import { getUserAccessToken } from '../ai/lib/config/userConfigStore.js';
import { createDriveFolder, listDriveFiles, sendText, uploadDriveFile } from '../ai/lib/feishu/client.js';

/** 归档进度（与「批量抓音频」同一套形状：跑完仍留在 Map 里供前端/排查读取） */
export interface NoteArchiveProgress {
  job: string;
  label: string;
  running: boolean;
  trigger: 'cron' | 'manual' | 'check';
  /** 本次候选（筛选后、未扣已归档） */
  total: number;
  /** 已处理（含跳过） */
  done: number;
  /** 真正上传的文件数（一篇笔记最多 2 个：明细 + 总结） */
  uploaded: number;
  /** 已归档过、本次跳过 */
  skipped: number;
  /** 只有总结、没有明细 */
  noDetail: number;
  failed: number;
  /** 命中/新建的按人文件夹数 */
  folders: number;
  startedAt: number;
  finishedAt?: number;
  error?: string;
}

/** 归档记录表的字段（与 ensureTable 共用一份，避免两处手抄字段名） */
const ARCHIVE_FIELDS = {
  笔记ID: '笔记ID',
  任务: '任务',
  归属人: '归属人',
  文件夹: '文件夹',
  文件夹Token: '文件夹Token',
  明细文件: '明细文件',
  总结文件: '总结文件',
  状态: '状态',
  错误: '错误',
  归档时间: '归档时间',
  明细字数: '明细字数',
  总结字数: '总结字数',
} as const;

/** 时间字段四种形态（毫秒数 / 秒数 / 数字串 / ISO 或 `YYYY-MM-DD`）统一成毫秒 */
function toMs(v: unknown): number {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v > 1e11 ? v : v * 1000;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n > 1e11 ? n : n * 1000;
  }
  const t = new Date(s.replace(/\//g, '-')).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/** 北京时间 `YYYY-MM-DD HH:mm`（写「上次运行」用） */
function beijingStamp(ms: number): string {
  if (!ms || !Number.isFinite(ms)) return '';
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(ms));
  const pick = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}`;
}

/**
 * 「我的笔记 → 飞书云盘」定时归档服务（2026-09-22 峰哥要求）。
 *
 * ## 任务来自**数据表**（菜单「定时任务」里可增删改 + 手动运行）
 * 2026-09-22 首版把两条任务（01:00 归档 IDP、01:30 归档全部有效）写成了代码常量；
 * 当天晚些时候按峰哥要求做成可维护的数据行（`TABLES.noteArchiveJob`）。
 * 种子两条沿用 `idp` / `all` 作为**任务标识** ⇒ 已产生的归档记录继续有效。
 *
 * ## 为什么以「笔记快照表」为准（而不是正文表 / 实时列表）
 * 实测：快照表 780（有效 763）是**超集**；正文表 658 少 122 条（那些只有总结没有明细）；
 * 实时列表 767 要打 13 套上游凭证才能枚举，且不能离线重跑。
 * 明细取不到就只出总结，并在进度里计 `noDetail` —— **不静默漏**。
 *
 * ## 幂等
 * 判据是**归档记录表**（行 id = `<笔记ID>__<任务标识>`）里 `状态=成功`，不是「云盘里有没有同名文件」——
 * 名字比不可靠（标题会被截断、同名同日同标题是真实存在的），而记录表是本地事实。
 * 因此单次跑不完可以放心重跑（第二天继续），也不会重复复制。
 */
@Injectable()
export class NoteArchiveService implements OnModuleInit {
  private readonly logger = new Logger(NoteArchiveService.name);
  private readonly jobs = new Map<NoteArchiveJobKey, NoteArchiveProgress>();
  /** `${根}:${归一后的人名}` → 文件夹 token（每次运行从云盘现状重建，不跨天缓存） */
  private readonly folderCache = new Map<string, string>();
  /** `names:${文件夹token}` → 该文件夹里已有的文件名集合（本次运行内缓存，防中断重跑重复上传） */
  private readonly nameCache = new Map<string, Set<string>>();
  private tableReady = false;

  async onModuleInit(): Promise<void> {
    try {
      await this.ensureTables();
    } catch (e) {
      this.logger.warn(`归档建表失败（下次运行会重试）：${(e as Error).message.slice(0, 160)}`);
    }
    // 🔴 定时器**已移出本服务**（2026-09-24）：统一由 `ScheduledTasksRunner` 按
    //    「定时任务」页的任务行驱动。这里若再自建一份 cron 循环，同一任务会被调度两次
    //    （两边都判到点、都写「上次运行」），且出问题时分不清是谁跑的。
  }

  private async ensureTables(): Promise<void> {
    const sql = getSqlStore();
    if (!sql || this.tableReady) return;
    const T = { TEXT: 1, NUMBER: 2, MULTI: 4 } as const;
    await sql.ensureTable(TABLES.noteArchive.tableId, '笔记归档记录表', [
      { name: ARCHIVE_FIELDS.笔记ID, type: T.TEXT },
      { name: ARCHIVE_FIELDS.任务, type: T.TEXT },
      { name: ARCHIVE_FIELDS.归属人, type: T.TEXT },
      { name: ARCHIVE_FIELDS.文件夹, type: T.TEXT },
      { name: ARCHIVE_FIELDS.文件夹Token, type: T.TEXT },
      { name: ARCHIVE_FIELDS.明细文件, type: T.TEXT },
      { name: ARCHIVE_FIELDS.总结文件, type: T.TEXT },
      { name: ARCHIVE_FIELDS.状态, type: T.TEXT },
      { name: ARCHIVE_FIELDS.错误, type: T.TEXT },
      { name: ARCHIVE_FIELDS.归档时间, type: T.NUMBER },
      { name: ARCHIVE_FIELDS.明细字数, type: T.NUMBER },
      { name: ARCHIVE_FIELDS.总结字数, type: T.NUMBER },
    ]);
    await sql.ensureTable(TABLES.noteArchiveJob.tableId, '笔记归档任务表', [
      { name: ARCHIVE_JOB_FIELDS.任务名称, type: T.TEXT },
      { name: ARCHIVE_JOB_FIELDS.启用, type: T.TEXT },
      // 「定时任务」通用化新增（2026-09-24）：ensureTable 的字段登记是 upsert ⇒
      // 往这个数组里加一行，部署时就会自动在 acms_fields 里补上（幂等，不需要手工脚本）
      { name: ARCHIVE_JOB_FIELDS.任务类型, type: T.TEXT },
      { name: ARCHIVE_JOB_FIELDS.频率, type: T.TEXT },
      { name: ARCHIVE_JOB_FIELDS.执行时间, type: T.TEXT },
      { name: ARCHIVE_JOB_FIELDS.执行日, type: T.MULTI },
      { name: ARCHIVE_JOB_FIELDS.目标文件夹, type: T.TEXT },
      { name: ARCHIVE_JOB_FIELDS.标题关键词, type: T.TEXT },
      { name: ARCHIVE_JOB_FIELDS.输出内容, type: T.MULTI },
      { name: ARCHIVE_JOB_FIELDS.按人分文件夹, type: T.TEXT },
      { name: ARCHIVE_JOB_FIELDS.补跑窗口, type: T.NUMBER },
      { name: ARCHIVE_JOB_FIELDS.上次运行, type: T.TEXT },
      { name: ARCHIVE_JOB_FIELDS.上次运行详情, type: T.TEXT },
    ]);
    await this.seedJobs();
    this.tableReady = true;
    this.logger.log('笔记归档表已就绪（记录表 + 任务表）');
  }

  /**
   * 写入种子任务 —— **只在表为空时**。
   *
   * 不能每次都写：用户删掉的任务在重启后自己长回来，比"少一条任务"难解释得多。
   * 种子标识沿用 `idp` / `all` ⇒ 首跑已产生的归档记录继续有效（升级不重跑）。
   */
  private async seedJobs(): Promise<void> {
    const sql = getSqlStore();
    if (!sql) return;
    const n = await sql.count(TABLES.noteArchiveJob.tableId).catch(() => 0);
    if (n > 0) return;
    for (const job of NOTE_ARCHIVE_JOB_SEEDS) {
      await sql.createWithId(TABLES.noteArchiveJob.tableId, job.key, archiveJobRowFields(job));
    }
    this.logger.log(`已写入 ${NOTE_ARCHIVE_JOB_SEEDS.length} 条归档任务种子`);
  }

  /** 读全部任务（按 row id = 任务标识）。表很小，不做缓存 —— 用户刚改完就要生效 */
  async loadJobs(): Promise<NoteArchiveJobDef[]> {
    const sql = getSqlStore();
    if (!sql) return [];
    const out: NoteArchiveJobDef[] = [];
    let token: string | undefined;
    for (let i = 0; i < 10; i += 1) {
      const page = await sql
        .search(TABLES.noteArchiveJob.tableId, { pageSize: 100, ...(token ? { pageToken: token } : {}) })
        .catch(() => null);
      if (!page) break;
      for (const r of page.items ?? []) {
        const id = String((r as unknown as { recordId?: string }).recordId ?? '').trim();
        if (id) out.push(parseArchiveJobRow(id, r.fields as Record<string, unknown>));
      }
      if (!page.hasMore || !page.pageToken) break;
      token = page.pageToken;
    }
    return out.sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute) || a.key.localeCompare(b.key));
  }

  /** 取单个任务（运行/体检用）；找不到返回 null */
  async findJob(id: string): Promise<NoteArchiveJobDef | null> {
    const jobs = await this.loadJobs();
    return jobs.find((j) => j.key === id) ?? null;
  }


  /** 归档失败/异常时发飞书 IM —— 不告警就会「静默不归档」，谁也不知道 */
  private async alert(text: string): Promise<void> {
    const chatId = String(process.env.NOTE_ARCHIVE_ALERT_CHAT ?? 'oc_ea45f82679bd3c90715d83da8a46f247').trim();
    if (!chatId) return;
    try {
      await sendText(chatId, `【ACMS 笔记归档】${text}`, undefined, { receiveIdType: 'chat_id' });
    } catch (e) {
      this.logger.warn(`归档告警发送失败：${(e as Error).message.slice(0, 120)}`);
    }
  }

  /** 取「以谁的身份写云盘」的 token：目标是峰哥名下的文件夹，所以用他的用户令牌（refresh 自动续期） */
  private async userToken(): Promise<string> {
    const openId = String(process.env.NOTE_ARCHIVE_USER_OPENID ?? 'ou_d76a678e745598605144be152b041084').trim();
    const t = await getUserAccessToken(openId);
    if (!t) throw new Error(`拿不到用户飞书令牌（openId=${openId.slice(0, 12)}…）—— 需要该用户重新授权云盘`);
    return t;
  }

  /** 各任务「最近一次」进度（键 = 任务标识；页面按行取自己的那条） */
  status(): Record<string, NoteArchiveProgress> {
    const out: Record<string, NoteArchiveProgress> = {};
    for (const [k, v] of this.jobs) out[k] = v;
    return out;
  }

  /**
   * 体检：令牌能不能用、每个任务的目标文件夹可达吗、待归档多少、**配置有没有问题**（**手动跑之前先看这个**）。
   *
   * 为什么要把配置问题一起返回：任务现在是人手填的（时间/文件夹/关键词），
   * 配错的后果是**凌晨静默失败**。页面上当场标红，比事后翻日志便宜得多。
   */
  async check(): Promise<{
    ok: boolean;
    userOpenId: string;
    tokenOk: boolean;
    tokenError: string;
    jobs: {
      id: string;
      label: string;
      enabled: boolean;
      schedule: string;
      kinds: string[];
      rootFolderToken: string;
      problems: string[];
      folderOk: boolean;
      folderError: string;
      subFolders: number;
      pending: number;
      archived: number;
    }[];
  }> {
    const openId = String(process.env.NOTE_ARCHIVE_USER_OPENID ?? 'ou_d76a678e745598605144be152b041084').trim();
    await this.ensureTables().catch(() => {}); // 首次体检时表可能还没建
    let token = '';
    let tokenErr = '';
    try {
      token = await this.userToken();
    } catch (e) {
      tokenErr = (e as Error).message;
    }
    const jobs = await this.loadJobs();
    const out: Awaited<ReturnType<NoteArchiveService['check']>>['jobs'] = [];
    for (const job of jobs) {
      const problems = validateArchiveJob(job);
      const counts = await this.countPending(job).catch(() => ({ pending: 0, archived: 0 }));
      let folderOk = false;
      let folderError = token ? '' : tokenErr;
      let subFolders = 0;
      if (token) {
        const r = await listDriveFiles({ folderToken: job.rootFolderToken, pageSize: 100, userAccessToken: token });
        if (r && 'error' in r && r.error) {
          folderError = String(r.error);
        } else {
          const files = (r as { files?: Array<{ type: string }> }).files ?? [];
          folderOk = true;
          subFolders = files.filter((f) => f.type === 'folder').length;
        }
      }
      out.push({
        id: job.key,
        label: job.label,
        enabled: job.enabled,
        schedule: archiveJobScheduleText(job),
        kinds: [...job.kinds],
        rootFolderToken: job.rootFolderToken,
        problems,
        folderOk,
        folderError,
        subFolders,
        pending: counts.pending,
        archived: counts.archived,
      });
    }
    return {
      ok: token !== '' && out.every((j) => j.folderOk && !j.problems.length),
      userOpenId: openId,
      tokenOk: token !== '',
      tokenError: tokenErr,
      jobs: out,
    };
  }

  /** 候选集合（有效 ∧ 任务标题过滤）与其中已归档的数量 */
  private async countPending(job: NoteArchiveJobDef): Promise<{ pending: number; archived: number }> {
    const sql = getSqlStore();
    if (!sql) return { pending: 0, archived: 0 };
    const archived = await this.loadArchivedSet(job.key);
    const status = await this.loadStatusMap();
    let pending = 0;
    let done = 0;
    let token: string | undefined;
    for (let i = 0; i < 40; i += 1) {
      const page = await sql.search(TABLES.noteSnapshot.tableId, {
        pageSize: 500,
        ...(token ? { pageToken: token } : {}),
      });
      for (const r of page.items ?? []) {
        const f = (r.fields ?? {}) as Record<string, unknown>;
        const id = String(f['笔记ID'] ?? '').trim();
        if (!id) continue;
        if (isArchivedNote(normalizeNoteStatus(status.get(id)))) continue;
        if (!noteMatchesArchiveJob(f['标题'], job)) continue;
        if (archived.has(id)) done += 1;
        else pending += 1;
      }
      if (!page.hasMore || !page.pageToken) break;
      token = page.pageToken;
    }
    return { pending, archived: done };
  }

  /** 已归档（状态=成功）的笔记 id 集合 */
  private async loadArchivedSet(jobKey: NoteArchiveJobKey): Promise<Set<string>> {
    const sql = getSqlStore();
    const out = new Set<string>();
    if (!sql) return out;
    let token: string | undefined;
    for (let i = 0; i < 40; i += 1) {
      // 表还没建时不要炸掉整个体检/运行（首次调用就属于这种）
      const page = await sql
        .search(TABLES.noteArchive.tableId, { pageSize: 500, ...(token ? { pageToken: token } : {}) })
        .catch(() => null);
      if (!page) break;
      for (const r of page.items ?? []) {
        const f = (r.fields ?? {}) as Record<string, unknown>;
        if (String(f[ARCHIVE_FIELDS.任务] ?? '') !== jobKey) continue;
        if (String(f[ARCHIVE_FIELDS.状态] ?? '') !== NOTE_ARCHIVE_OK) continue;
        const id = String(f[ARCHIVE_FIELDS.笔记ID] ?? '').trim();
        if (id) out.add(id);
      }
      if (!page.hasMore || !page.pageToken) break;
      token = page.pageToken;
    }
    return out;
  }

  /** 笔记状态（缺行 = 有效，判据在 contracts 的 `normalizeNoteStatus` / `isArchivedNote`） */
  private async loadStatusMap(): Promise<Map<string, string>> {
    const sql = getSqlStore();
    const map = new Map<string, string>();
    if (!sql) return map;
    let token: string | undefined;
    for (let i = 0; i < 40; i += 1) {
      const page = await sql.search(TABLES.noteStatus.tableId, {
        pageSize: 500,
        ...(token ? { pageToken: token } : {}),
      });
      for (const r of page.items ?? []) {
        const f = (r.fields ?? {}) as Record<string, unknown>;
        const rr = r as unknown as { recordId?: string; id?: string };
        const id = String(f['笔记ID'] ?? rr.recordId ?? rr.id ?? '').trim();
        if (id) map.set(id, normalizeNoteStatus(f['状态']));
      }
      if (!page.hasMore || !page.pageToken) break;
      token = page.pageToken;
    }
    return map;
  }

  /**
   * 触发一次归档（异步执行，立即返回进度对象）。
   * 同一任务的第二次调用会被忽略（正在跑）。
   *
   * ⚠️ **不校验 `enabled`** —— 手动运行的意义就是"现在立刻跑一次"，
   *    停用只约束定时器（见 `shouldRunArchiveJob`）。
   */
  start(job: NoteArchiveJobDef, opts: { limit?: number; trigger: 'cron' | 'manual' }): NoteArchiveProgress {
    const cur = this.jobs.get(job.key);
    if (cur?.running) return cur;
    const progress: NoteArchiveProgress = {
      job: job.key,
      label: job.label,
      running: true,
      trigger: opts.trigger,
      total: 0,
      done: 0,
      uploaded: 0,
      skipped: 0,
      noDetail: 0,
      failed: 0,
      folders: 0,
      startedAt: Date.now(),
    };
    this.jobs.set(job.key, progress);
    void this.run(job, opts.limit ?? 0, progress)
      .then(async () => {
        progress.running = false;
        progress.finishedAt = Date.now();
        this.logger.log(
          `笔记归档完成（${job.label}）：候选 ${progress.total}，跳过 ${progress.skipped}，` +
            `上传 ${progress.uploaded}，无明细 ${progress.noDetail}，失败 ${progress.failed}，文件夹 ${progress.folders}`,
        );
        await this.writeRunResult(job, progress).catch(() => {});
      })
      .catch(async (e) => {
        progress.running = false;
        progress.finishedAt = Date.now();
        progress.error = (e as Error).message.slice(0, 300);
        this.logger.error(`笔记归档异常（${job.label}）：${progress.error}`);
        await this.writeRunResult(job, progress).catch(() => {});
        await this.alert(`${job.label} 归档异常：${progress.error}`);
      });
    return progress;
  }

  /** 把本次结果写回任务行（页面上「上次运行」两列；写失败不影响归档本身） */
  private async writeRunResult(job: NoteArchiveJobDef, p: NoteArchiveProgress): Promise<void> {
    const sql = getSqlStore();
    if (!sql) return;
    const parts = [
      `候选 ${p.total}`,
      `上传 ${p.uploaded}`,
      `跳过 ${p.skipped}`,
      `无明细 ${p.noDetail}`,
      `失败 ${p.failed}`,
    ];
    if (p.error) parts.push(`错误：${p.error.slice(0, 80)}`);
    await sql.update(TABLES.noteArchiveJob.tableId, job.key, {
      [ARCHIVE_JOB_FIELDS.上次运行]: beijingStamp(p.finishedAt ?? Date.now()),
      [ARCHIVE_JOB_FIELDS.上次运行详情]: parts.join(' · '),
    });
  }

  private async run(job: NoteArchiveJobDef, limit: number, p: NoteArchiveProgress): Promise<void> {
    const sql = getSqlStore();
    if (!sql) throw new Error('SQL 存储不可用（SQL_TABLES 未开启？）');
    await this.ensureTables();
    const problems = validateArchiveJob(job);
    if (problems.length) throw new Error(`任务配置有问题：${problems.join('；')}`);
    const token = await this.userToken();

    const archived = await this.loadArchivedSet(job.key);
    const status = await this.loadStatusMap();
    this.folderCache.clear();
    this.nameCache.clear();

    // ① 先枚举候选（快照表是全量超集）
    type Cand = { id: string; title: string; owner: string; createdMs: number; summary: string };
    const cands: Cand[] = [];
    let pageToken: string | undefined;
    for (let i = 0; i < 40; i += 1) {
      const page = await sql.search(TABLES.noteSnapshot.tableId, {
        pageSize: 500,
        ...(pageToken ? { pageToken } : {}),
      });
      for (const r of page.items ?? []) {
        const f = (r.fields ?? {}) as Record<string, unknown>;
        const id = String(f['笔记ID'] ?? '').trim();
        if (!id) continue;
        if (isArchivedNote(normalizeNoteStatus(status.get(id)))) continue;
        if (!noteMatchesArchiveJob(f['标题'], job)) continue;
        cands.push({
          id,
          title: String(f['标题'] ?? '').trim(),
          owner: String(f['归属人'] ?? '').trim(),
          createdMs: toMs(f['笔记创建时间']),
          summary: String(f['总结'] ?? ''),
        });
      }
      if (!page.hasMore || !page.pageToken) break;
      pageToken = page.pageToken;
    }
    // 已归档的排除在外（这就是「已经复制过的跳过」的判据）
    const fresh = cands.filter((c) => !archived.has(c.id));
    p.skipped = cands.length - fresh.length;
    p.total = fresh.length;
    const todo = limit > 0 ? fresh.slice(0, limit) : fresh;

    // ② 逐篇归档（串行 + 节流：飞书云盘并发写同名目录会撞 232140101）
    for (const c of todo) {
      try {
        const folder = job.groupByOwner
          ? await this.ensureOwnerFolder(job.rootFolderToken, normalizeOwnerFolderName(c.owner), token, p)
          : { name: '', token: job.rootFolderToken };
        const detailRec = await sql.get(TABLES.noteBody.tableId, c.id).catch(() => null);
        const detail = String((detailRec?.fields ?? {})['原始记录'] ?? '').trim();
        const date = beijingDate(c.createdMs);
        const names: string[] = [];
        for (const kind of job.kinds) {
          const content = kind === '明细' ? detail : c.summary;
          if (!content.trim()) {
            if (kind === '明细') p.noDetail += 1;
            continue;
          }
          const fileName = noteArchiveFileName({ date: date || '日期未知', title: c.title, kind, noteId: c.id });
          // 第二道防线：文件夹里**已有同名文件**就不重复上传。
          // 主判据是归档记录表，但一次运行被中断（部署/重启）时记录还没写，
          // 重跑就会把同一篇的两个文件再传一遍（云盘允许重名 ⇒ 出现一模一样的副本）。
          // 名字里带笔记 ID，所以按名字比是可靠的。
          if (await this.fileExists(folder.token, fileName, token)) {
            names.push(fileName);
            continue;
          }
          const up = await uploadDriveFile({
            folderToken: folder.token,
            fileName,
            content: noteArchiveBody({
              title: c.title,
              kind,
              noteId: c.id,
              owner: c.owner,
              createdAtMs: c.createdMs,
              content,
            }),
            userAccessToken: token,
          });
          if (up && up.error) throw new Error(`${kind} 上传失败：${up.error}`);
          names.push(fileName);
          p.uploaded += 1;
          await new Promise((r) => setTimeout(r, 300)); // 节流：QPS 友好，也让失败更早暴露
        }
        await this.saveArchiveRecord(c, job.key, folder, names, detail.length, c.summary.length, NOTE_ARCHIVE_OK, '');
        p.done += 1;
      } catch (e) {
        p.failed += 1;
        p.done += 1;
        await this.saveArchiveRecord(c, job.key, null, [], 0, 0, NOTE_ARCHIVE_FAIL, (e as Error).message.slice(0, 240)).catch(
          () => {},
        );
        this.logger.warn(`笔记归档失败（${c.id} ${c.title.slice(0, 20)}）：${(e as Error).message.slice(0, 160)}`);
      }
    }

    // ③ 有失败必有告警（静默不归档是最坏的失败方式）
    if (p.failed > 0) {
      await this.alert(
        `${job.label} 归档：候选 ${p.total}，成功 ${p.done - p.failed}，**失败 ${p.failed}**，` +
          `无明细 ${p.noDetail}。失败明细见「笔记归档记录表」（状态=失败）。`,
      );
    }
  }

  /**
   * 清掉某个任务的归档记录（「**补归档**」用：目标文件夹换过之后，旧记录会让同批笔记
   * 在新文件夹里永远不再出现）。
   *
   * ⚠️ 只删记录、**不动云盘上的文件** —— 旧文件夹里的东西原样留着（那是用户的资产，
   *    脚本没有资格替人删）。调用方必须先让用户明确确认。
   */
  async clearRecords(jobKey: NoteArchiveJobKey): Promise<{ removed: number }> {
    const sql = getSqlStore();
    if (!sql) return { removed: 0 };
    let removed = 0;
    let token: string | undefined;
    for (let i = 0; i < 40; i += 1) {
      const page = await sql
        .search(TABLES.noteArchive.tableId, { pageSize: 500, ...(token ? { pageToken: token } : {}) })
        .catch(() => null);
      if (!page) break;
      for (const r of page.items ?? []) {
        const f = (r.fields ?? {}) as Record<string, unknown>;
        if (String(f[ARCHIVE_FIELDS.任务] ?? '') !== jobKey) continue;
        const id = String((r as unknown as { recordId?: string }).recordId ?? '').trim();
        if (!id) continue;
        await sql.delete(TABLES.noteArchive.tableId, id).catch(() => {});
        removed += 1;
      }
      if (!page.hasMore || !page.pageToken) break;
      token = page.pageToken;
    }
    return { removed };
  }

  /** 某任务已有多少条归档记录（「补归档」前置判断 + 删除任务时的提示） */
  async countRecords(jobKey: NoteArchiveJobKey): Promise<number> {
    const sql = getSqlStore();
    if (!sql) return 0;
    let n = 0;
    let token: string | undefined;
    for (let i = 0; i < 40; i += 1) {
      const page = await sql
        .search(TABLES.noteArchive.tableId, { pageSize: 500, ...(token ? { pageToken: token } : {}) })
        .catch(() => null);
      if (!page) break;
      for (const r of page.items ?? []) {
        const f = (r.fields ?? {}) as Record<string, unknown>;
        if (String(f[ARCHIVE_FIELDS.任务] ?? '') === jobKey) n += 1;
      }
      if (!page.hasMore || !page.pageToken) break;
      token = page.pageToken;
    }
    return n;
  }

  /** 找出/新建「按人」的文件夹（每次运行都从云盘现状重建缓存，不跨天） */
  private async ensureOwnerFolder(
    rootToken: string,
    ownerName: string,
    token: string,
    p: NoteArchiveProgress,
  ): Promise<{ name: string; token: string }> {
    const cacheKey = `${rootToken}:${ownerName}`;
    const cached = this.folderCache.get(cacheKey);
    if (cached) return { name: ownerName, token: cached };
    const list = await listDriveFiles({ folderToken: rootToken, pageSize: 100, userAccessToken: token });
    if (list && 'error' in list && list.error) throw new Error(`列目标文件夹失败：${list.error}`);
    const files: Array<{ file_token: string; name: string; type: string }> =
      (list as { files?: Array<{ file_token: string; name: string; type: string }> }).files ?? [];
    for (const f of files) {
      if (f.type !== 'folder') continue;
      const norm = normalizeOwnerFolderName(f.name);
      if (!this.folderCache.has(`${rootToken}:${norm}`)) this.folderCache.set(`${rootToken}:${norm}`, f.file_token);
    }
    const hit = this.folderCache.get(cacheKey);
    if (hit) return { name: ownerName, token: hit };
    const created = await createDriveFolder({ name: ownerName, parentFolderToken: rootToken, userAccessToken: token });
    if (created && created.error) throw new Error(`新建人文件夹失败：${created.error}`);
    const newToken = created.token || '';
    this.folderCache.set(cacheKey, newToken);
    p.folders += 1;
    this.logger.log(`已新建归档文件夹：${ownerName}`);
    return { name: ownerName, token: newToken };
  }

  /**
   * 文件夹里是否已有这个文件名（**每次运行按需列一次该人文件夹**，之后走内存缓存）。
   *
   * 为什么要这一层：中断后重跑时归档记录还没写（记录是「文件都传完」才写），
   * 只按记录判会重复上传，而云盘允许同名 ⇒ 文件夹里会出现一模一样的副本。
   * 名字里带笔记 ID（`…-明细__<id>.md`）⇒ 按名字比是可靠的，不是模糊匹配。
   */
  private async fileExists(folderToken: string, fileName: string, token: string): Promise<boolean> {
    const key = `names:${folderToken}`;
    let names = this.nameCache.get(key);
    if (!names) {
      names = new Set<string>();
      const list = await listDriveFiles({ folderToken, pageSize: 100, userAccessToken: token });
      const files: Array<{ name: string }> = (list as { files?: Array<{ name: string }> }).files ?? [];
      for (const f of files) names.add(f.name);
      this.nameCache.set(key, names);
    }
    if (names.has(fileName)) return true;
    names.add(fileName); // 本次运行内后续不再重复查
    return false;
  }

  /** 写归档记录（行 id = `<笔记ID>__<任务标识>`，upsert 幂等） */
  private async saveArchiveRecord(
    c: { id: string; title: string; owner: string },
    jobKey: NoteArchiveJobKey,
    folder: { name: string; token: string } | null,
    names: string[],
    detailLen: number,
    summaryLen: number,
    state: string,
    error: string,
  ): Promise<void> {
    const sql = getSqlStore();
    if (!sql) return;
    const id = noteArchiveRecordId(c.id, jobKey);
    const fields: Record<string, unknown> = {
      [ARCHIVE_FIELDS.笔记ID]: c.id,
      [ARCHIVE_FIELDS.任务]: jobKey,
      [ARCHIVE_FIELDS.归属人]: c.owner,
      [ARCHIVE_FIELDS.文件夹]: folder?.name ?? '',
      [ARCHIVE_FIELDS.文件夹Token]: folder?.token ?? '',
      [ARCHIVE_FIELDS.明细文件]: names.find((n) => n.includes('-明细')) ?? '',
      [ARCHIVE_FIELDS.总结文件]: names.find((n) => n.includes('-总结')) ?? '',
      [ARCHIVE_FIELDS.状态]: state,
      [ARCHIVE_FIELDS.错误]: error,
      [ARCHIVE_FIELDS.归档时间]: Date.now(),
      [ARCHIVE_FIELDS.明细字数]: detailLen,
      [ARCHIVE_FIELDS.总结字数]: summaryLen,
    };
    const exists = await sql.get(TABLES.noteArchive.tableId, id).catch(() => null);
    if (exists) await sql.update(TABLES.noteArchive.tableId, id, fields);
    else await sql.createWithId(TABLES.noteArchive.tableId, id, fields);
  }
}
