import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  ARCHIVE_JOB_FIELDS,
  TABLES,
  archiveJobScheduleText,
  beijingClock,
  jobSlotKey,
  shouldRunArchiveJob,
  type NoteArchiveJobDef,
} from '@acms/contracts';
import { getSqlStore } from '../base.provider.js';
import { runAs, systemActor } from '../shared/actor-context.js';
import { NoteArchiveService } from '../note-archive/note-archive.service.js';
import { WeilingService } from '../weiling/weiling.service.js';
import { MailArchiveService } from '../mail-archive/mail-archive.service.js';
import { GetnoteSourceService } from '../getnote/sources.service.js';

/**
 * 「定时任务」的统一调度器（2026-09-24，方案 A）。
 *
 * 背景：原来三家各写各的定时器 ——
 *   · 笔记归档：每小时 tick + 判到点（**正确范式**）
 *   · 每日音频抓取：同上
 *   · 卫瓴联系人同步：`setInterval(24h)`（**错的**：蓝绿部署每次重启都把 24 小时计时清零，
 *     时间点会一直往后漂；实测一天部署 4 次就跑了 4 次，而且用户改不了）
 *   · 知识库同步：`getnote/sources.module` 里硬编码的「每 15 分钟」cron 表达式
 * 现在统一由本调度器驱动：任务行里配「任务类型 + 频率 + 执行时间 + 执行日」，
 * 用户自己在「定时任务」页改，不需要发版。
 *
 * ── tick 间隔为什么是 **60 秒** ─────────────────────────────────────
 * 最细的频率档是「每15分钟」，只有分钟级 tick 才判得准（每小时 tick 会漏掉 3/4 的槽位）。
 * 成本：每分钟一次本地小表查询（任务表只有几行），与三个任务本身的开销比可忽略。
 *
 * ── 与「笔记归档」自己那套的关系 ───────────────────────────────────
 * 🔴 `NoteArchiveService.startCron()` 已删除，否则同一任务会被调度**两次**（两边都判到点）。
 *    归档执行体 `start()` 保留（含它自己的 running 去重与「上次运行」回写），这里只负责"到点叫它"。
 */
@Injectable()
export class ScheduledTasksRunner implements OnModuleInit {
  private readonly logger = new Logger('ScheduledTasks');
  /** 已跑过的时间槽：`${任务key}:${天}[:${小时}[:${15分钟格}]]`，见 contracts 的 `jobSlotKey` */
  private readonly ranSlots = new Set<string>();
  /** 同一天内累积的槽位键，跨天时清理（避免 Set 无限增长） */
  private slotDay = '';
  private running = false;

  constructor(
    private readonly notes: NoteArchiveService,
    private readonly weiling: WeilingService,
    private readonly mail: MailArchiveService,
    private readonly getnoteSources: GetnoteSourceService,
  ) {}

  onModuleInit(): void {
    if (String(process.env.SCHEDULED_TASKS_CRON ?? '').trim().toLowerCase() === 'off') {
      this.logger.log('SCHEDULED_TASKS_CRON=off，跳过定时任务调度器');
      return;
    }
    // 启动 90 秒后先跑一次：进程刚起来时别和建表/预热抢资源，但也别等太久
    //（错过的槽位靠「补跑窗口」在下一分钟 tick 补上）
    setTimeout(() => void this.tick(), 90_000).unref?.();
    setInterval(() => void this.tick(), 60_000).unref?.();
    this.logger.log('定时任务调度器已启动（每分钟检查一次，任务在「定时任务」页配置）');
  }

  /** 检查所有任务，到点的触发 */
  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const { day, minutes, weekday } = beijingClock();
      if (this.slotDay !== day) {
        this.ranSlots.clear();
        this.slotDay = day;
      }
      const jobs = await this.notes.loadJobs();
      for (const job of jobs) {
        const slot = jobSlotKey(job, day, minutes);
        // `shouldRunArchiveJob` 是**纯函数**（contracts），与测试共用同一份判据：
        // 启用 + 本槽位未跑 + 今天在执行日里 + 已到点（每天还要求在补跑窗口内）
        if (!shouldRunArchiveJob(job, minutes, this.ranSlots.has(slot), weekday)) continue;
        this.ranSlots.add(slot);
        this.logger.log(`定时触发：${job.label}（${job.kind} · ${archiveJobScheduleText(job)}）`);
        // 不 await：一个任务跑几分钟很正常，不能让别的任务被它挡住
        void this.dispatch(job).catch((e) =>
          this.logger.warn(`定时任务执行失败（${job.label}）：${(e as Error).message.slice(0, 160)}`),
        );
      }
    } catch (e) {
      this.logger.warn(`定时检查失败：${(e as Error).message.slice(0, 160)}`);
    } finally {
      this.running = false;
    }
  }

  /** 按任务类型分发。三种执行体各自负责自己的幂等与进度。 */
  private async dispatch(job: NoteArchiveJobDef): Promise<void> {
    if (job.kind === '卫瓴联系人同步') {
      // 后台写库没有会话，显式声明身份（与邮件归档同一范式）
      const r = await runAs(systemActor('scheduled-tasks', '系统 · 定时任务'), () =>
        this.weiling.syncAll(false),
      );
      await this.writeRunResult(
        job,
        r.ok ? `同步联系人 ${r.count} 条` : `未执行：${r.message ?? '未知原因'}`,
      );
      return;
    }
    if (job.kind === '邮件收取') {
      const r = await runAs(systemActor('scheduled-tasks', '系统 · 定时任务'), () => this.mail.syncAll());
      // ⚠️ 这里只是"触发检查"：每个账户是否真去收，仍由该账户自己的「收取频率」决定
      //    （节流在 `MailArchiveService.syncAll` 内）。所以改了任务时间不会绕过账户频率。
      await this.writeRunResult(job, `检查后触发 ${r.synced} 个账户收取`);
      return;
    }
    if (job.kind === '知识库同步') {
      // 与「邮件收取」同模型：这里只决定**多久检查一次**，每条知识库配置自己的
      // 「收取频率」仍然生效（节流在 `GetnoteSourceService.syncAllDue` 内）。
      const r = await runAs(systemActor('scheduled-tasks', '系统 · 定时任务'), () =>
        this.getnoteSources.syncAllDue(),
      );
      await this.writeRunResult(job, `检查后触发 ${r.synced} 个知识库同步，跳过 ${r.skipped} 个`);
      return;
    }
    // 笔记归档：执行体自己是异步的（立刻返回进度），「上次运行」由它回写
    this.notes.start(job, { trigger: 'cron' });
  }

  /** 把本次结果写回任务行（页面上「上次运行」两列）；写失败不影响任务本身 */
  private async writeRunResult(job: NoteArchiveJobDef, detail: string): Promise<void> {
    const sql = getSqlStore();
    if (!sql) return;
    try {
      await sql.update(TABLES.noteArchiveJob.tableId, job.key, {
        [ARCHIVE_JOB_FIELDS.上次运行]: stamp(Date.now()),
        [ARCHIVE_JOB_FIELDS.上次运行详情]: detail.slice(0, 300),
      });
    } catch (e) {
      this.logger.warn(`回写任务结果失败（${job.label}）：${(e as Error).message.slice(0, 120)}`);
    }
  }
}

/** 北京时间 `YYYY-MM-DD HH:mm`（服务器时区不可信，一律走 Asia/Shanghai） */
function stamp(ms: number): string {
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
