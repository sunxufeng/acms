import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  NOTE_ARCHIVE_JOBS,
  NOTE_ARCHIVE_FAIL,
  NOTE_ARCHIVE_KINDS,
  NOTE_ARCHIVE_OK,
  TABLES,
  beijingClock,
  beijingDate,
  isArchivedNote,
  noteArchiveBody,
  noteArchiveFileName,
  noteArchiveRecordId,
  noteMatchesArchiveJob,
  normalizeOwnerFolderName,
  normalizeNoteStatus,
  type NoteArchiveJobKey,
} from '@acms/contracts';
import { getSqlStore } from '../base.provider.js';
import { getUserAccessToken } from '../ai/lib/config/userConfigStore.js';
import { createDriveFolder, listDriveFiles, sendText, uploadDriveFile } from '../ai/lib/feishu/client.js';

/** 归档进度（与「批量抓音频」同一套形状：跑完仍留在 Map 里供前端/排查读取） */
export interface NoteArchiveProgress {
  job: NoteArchiveJobKey;
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

/**
 * 「我的笔记 → 飞书云盘」每日归档服务（2026-09-22 峰哥要求）。
 *
 * ## 两个任务（时间与规则见 `contracts/note-archive.ts`）
 * - **01:00**：有效 ∧ 标题含 IDP → `VULJ…`（全量根目录下的「IDP」子文件夹）
 * - **01:30**：全部有效 → `K6Ij…`
 * 两边都「按人建子文件夹 + 明细与总结两份 md + 文件名前缀日期 + 已复制过跳过」。
 *
 * ## 为什么以「笔记快照表」为准（而不是正文表 / 实时列表）
 * 实测：快照表 780（有效 763）是**超集**；正文表 658 少 122 条（那些只有总结没有明细）；
 * 实时列表 767 要打 13 套上游凭证才能枚举，且不能离线重跑。
 * 明细取不到就只出总结，并在进度里计 `noDetail` —— **不静默漏**。
 *
 * ## 幂等
 * 判据是**归档记录表**（行 id = `<笔记ID>__<任务>`）里 `状态=成功`，不是「云盘里有没有同名文件」——
 * 名字比不可靠（标题会被截断、同名同日同标题是真实存在的），而记录表是本地事实。
 * 因此单次跑不完可以放心重跑（第二天继续），也不会重复复制。
 */
@Injectable()
export class NoteArchiveService implements OnModuleInit {
  private readonly logger = new Logger(NoteArchiveService.name);
  private readonly jobs = new Map<NoteArchiveJobKey, NoteArchiveProgress>();
  /** `任务:日期` → 已跑过（进程内即可，理由同音频任务：蓝绿重启只丢这个标记，任务本身幂等） */
  private readonly ranDay = new Set<string>();
  /** `${根}:${归一后的人名}` → 文件夹 token（每次运行从云盘现状重建，不跨天缓存） */
  private readonly folderCache = new Map<string, string>();
  private tableReady = false;

  async onModuleInit(): Promise<void> {
    try {
      await this.ensureArchiveTable();
    } catch (e) {
      this.logger.warn(`归档记录表建表失败（下次运行会重试）：${(e as Error).message.slice(0, 160)}`);
    }
    this.startCron();
  }

  private async ensureArchiveTable(): Promise<void> {
    const sql = getSqlStore();
    if (!sql || this.tableReady) return;
    const T = { TEXT: 1, NUMBER: 2 } as const;
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
    this.tableReady = true;
    this.logger.log('笔记归档记录表已就绪');
  }

  /**
   * 起「每天 01:00 / 01:30 归档」的定时器。
   *
   * 🔴 与「每日音频抓取」同一范式：**不是** `setInterval(24h)` —— 蓝绿部署每次都重启进程，
   *    24 小时计时清零，部署一勤就永远等不到那一刻。改成「每小时醒一次，看北京时间到点没到点、
   *    今天跑没跑过」，判据是**日期 + 时刻**，与进程活了多久无关。
   *    重启最坏多跑一次，而任务按归档记录表幂等。
   */
  private startCron(): void {
    if (String(process.env.GETNOTE_ARCHIVE_CRON ?? '').trim().toLowerCase() === 'off') {
      this.logger.log('GETNOTE_ARCHIVE_CRON=off，跳过每日笔记归档定时器');
      return;
    }
    const tick = () => {
      const { day, minutes } = beijingClock();
      for (const job of Object.values(NOTE_ARCHIVE_JOBS)) {
        const marker = `${job.key}:${day}`;
        if (this.ranDay.has(marker)) continue;
        if (minutes < job.hour * 60 + job.minute) continue;
        this.ranDay.add(marker);
        this.logger.log(`每日笔记归档开始：${job.label}（${String(job.hour).padStart(2, '0')}:${String(job.minute).padStart(2, '0')}）`);
        void this.runScheduled(job.key);
      }
    };
    setTimeout(tick, 3 * 60 * 1000).unref?.();
    setInterval(tick, 60 * 60 * 1000).unref?.();
  }

  private async runScheduled(jobKey: NoteArchiveJobKey): Promise<void> {
    try {
      const p = this.start(jobKey, { trigger: 'cron' });
      // start 是异步跑，这里等它由内部自己收尾；失败会把 error 记在进度里并发告警
      void p;
    } catch (e) {
      this.logger.error(`每日笔记归档启动失败：${(e as Error).message}`);
      await this.alert(`笔记归档（${NOTE_ARCHIVE_JOBS[jobKey].label}）启动失败：${(e as Error).message.slice(0, 180)}`);
    }
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

  /** 当前进度（含最近一次已完成的） */
  status(): Record<string, NoteArchiveProgress | null> {
    const out: Record<string, NoteArchiveProgress | null> = {};
    for (const k of Object.keys(NOTE_ARCHIVE_JOBS) as NoteArchiveJobKey[]) out[k] = this.jobs.get(k) ?? null;
    return out;
  }

  /** 体检：令牌能不能用、两个目标文件夹可达吗、待归档多少（**手动跑之前先看这个**） */
  async check(): Promise<{
    ok: boolean;
    userOpenId: string;
    folders: { job: string; label: string; token: string; ok: boolean; subFolders: number; error?: string }[];
    pending: { job: string; label: string; pending: number; alreadyArchived: number }[];
  }> {
    const openId = String(process.env.NOTE_ARCHIVE_USER_OPENID ?? 'ou_d76a678e745598605144be152b041084').trim();
    await this.ensureArchiveTable().catch(() => {}); // 首次体检时表可能还没建
    let token = '';
    let tokenErr = '';
    try {
      token = await this.userToken();
    } catch (e) {
      tokenErr = (e as Error).message;
    }
    const folders: { job: string; label: string; token: string; ok: boolean; subFolders: number; error?: string }[] = [];
    for (const job of Object.values(NOTE_ARCHIVE_JOBS)) {
      if (!token) {
        folders.push({ job: job.key, label: job.label, token: job.rootFolderToken, ok: false, subFolders: 0, error: tokenErr });
        continue;
      }
      const r = await listDriveFiles({ folderToken: job.rootFolderToken, pageSize: 100, userAccessToken: token });
      if (r && r.error) {
        folders.push({ job: job.key, label: job.label, token: job.rootFolderToken, ok: false, subFolders: 0, error: r.error });
      } else {
        const files: Array<{ type: string }> =
          (r as { files?: Array<{ type: string }> }).files ?? [];
        folders.push({
          job: job.key,
          label: job.label,
          token: job.rootFolderToken,
          ok: true,
          subFolders: files.filter((f: { type: string }) => f.type === 'folder').length,
        });
      }
    }
    const pending = await Promise.all(
      Object.values(NOTE_ARCHIVE_JOBS).map(async (job) => {
        const c = await this.countPending(job.key);
        return { job: job.key, label: job.label, pending: c.pending, alreadyArchived: c.archived };
      }),
    );
    return { ok: token !== '' && folders.every((f) => f.ok), userOpenId: openId, folders, pending };
  }

  /** 候选集合（有效 ∧ 任务标题过滤）与其中已归档的数量 */
  private async countPending(jobKey: NoteArchiveJobKey): Promise<{ pending: number; archived: number }> {
    const sql = getSqlStore();
    if (!sql) return { pending: 0, archived: 0 };
    const job = NOTE_ARCHIVE_JOBS[jobKey];
    const archived = await this.loadArchivedSet(jobKey);
    const status = await this.loadStatusMap();
    let pending = 0;
    let done = 0;
    let token: string | undefined;
    for (let i = 0; i < 40; i += 1) {
      const page = await sql.search(TABLES.noteSnapshot.tableId, { pageSize: 500, ...(token ? { pageToken: token } : {}) });
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
      const page = await sql.search(TABLES.noteStatus.tableId, { pageSize: 500, ...(token ? { pageToken: token } : {}) });
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
   */
  start(jobKey: NoteArchiveJobKey, opts: { limit?: number; trigger: 'cron' | 'manual' }): NoteArchiveProgress {
    const job = NOTE_ARCHIVE_JOBS[jobKey];
    const cur = this.jobs.get(jobKey);
    if (cur?.running) return cur;
    const progress: NoteArchiveProgress = {
      job: jobKey,
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
    this.jobs.set(jobKey, progress);
    void this.run(jobKey, opts.limit ?? 0, progress)
      .then(() => {
        progress.running = false;
        progress.finishedAt = Date.now();
        this.logger.log(
          `笔记归档完成（${job.label}）：候选 ${progress.total}，跳过 ${progress.skipped}，` +
            `上传 ${progress.uploaded}，无明细 ${progress.noDetail}，失败 ${progress.failed}，文件夹 ${progress.folders}`,
        );
      })
      .catch(async (e) => {
        progress.running = false;
        progress.finishedAt = Date.now();
        progress.error = (e as Error).message.slice(0, 300);
        this.logger.error(`笔记归档异常（${job.label}）：${progress.error}`);
        await this.alert(`${job.label} 归档异常：${progress.error}`);
      });
    return progress;
  }

  private async run(jobKey: NoteArchiveJobKey, limit: number, p: NoteArchiveProgress): Promise<void> {
    const sql = getSqlStore();
    if (!sql) throw new Error('SQL 存储不可用（SQL_TABLES 未开启？）');
    await this.ensureArchiveTable();
    const job = NOTE_ARCHIVE_JOBS[jobKey];
    const token = await this.userToken();

    const archived = await this.loadArchivedSet(jobKey);
    const status = await this.loadStatusMap();
    this.folderCache.clear();

    // ① 先枚举候选（快照表是全量超集）
    type Cand = { id: string; title: string; owner: string; createdMs: number; summary: string };
    const cands: Cand[] = [];
    let pageToken: string | undefined;
    for (let i = 0; i < 40; i += 1) {
      const page = await sql.search(TABLES.noteSnapshot.tableId, { pageSize: 500, ...(pageToken ? { pageToken } : {}) });
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
    p.total = fresh.length;
    const todo = limit > 0 ? fresh.slice(0, limit) : fresh;

    // ② 逐篇归档（串行 + 节流：飞书云盘并发写同名目录会撞 232140101）
    for (const c of todo) {
      try {
        const folder = await this.ensureOwnerFolder(job.rootFolderToken, normalizeOwnerFolderName(c.owner), token, p);
        const detailRec = await sql.get(TABLES.noteBody.tableId, c.id).catch(() => null);
        const detail = String((detailRec?.fields ?? {})['原始记录'] ?? '').trim();
        const date = beijingDate(c.createdMs);
        const names: string[] = [];
        for (const kind of NOTE_ARCHIVE_KINDS) {
          const content = kind === '明细' ? detail : c.summary;
          if (!content.trim()) {
            if (kind === '明细') p.noDetail += 1;
            continue;
          }
          const fileName = noteArchiveFileName({ date: date || '日期未知', title: c.title, kind, noteId: c.id });
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
        await this.saveArchiveRecord(c, jobKey, folder, names, detail.length, c.summary.length, NOTE_ARCHIVE_OK, '');
        p.done += 1;
      } catch (e) {
        p.failed += 1;
        p.done += 1;
        await this.saveArchiveRecord(c, jobKey, null, [], 0, 0, NOTE_ARCHIVE_FAIL, (e as Error).message.slice(0, 240)).catch(() => {});
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

  /** 写归档记录（行 id = `<笔记ID>__<任务>`，upsert 幂等） */
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
