import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { TABLES, type SessionUser } from '@acms/contracts';
import { BaseClient } from '@acms/base-adapter';
import { BASE_CLIENT, getSqlStore } from '../base.provider.js';
import type { SqlStore } from '../sql-store/sql-store.js';
import { AuditService } from '../audit/audit.service.js';
import { requireModule } from '../shared/require-module.js';
import { currentActor, runAs, systemActor } from '../shared/actor-context.js';
import {
  ALERT_COUNT_THRESHOLD,
  ALERT_WINDOW_RECENT,
  alertIdOf,
  alertWindows,
  buildLetterBody,
  emptyStatsRow,
  evaluateWindow,
  factOf,
  firstLinkId,
  hasLinkId,
  isNegativeBehaviour,
  letterTypeOf,
  numOf,
  tierPointsOf,
  toDateStr,
  toMs,
  windowRangeOf,
  type BehaviourFact,
  type StatsRow,
} from './behaviour.logic.js';

/** 后台写入身份：不用它，审计里的「创建人/更新人」会落成 system:unknown */
const RECALC_ACTOR = () => systemActor('behaviour-recalc', '系统 · 行为告警重算');

/**
 * 行为记录（Behaviour）的**派生逻辑**：告警重算 / 家长信件生成 / 按班级年级汇总 /
 * 取出某条行为的跟进流水。通用 CRUD 表达不了这些跨表 + 派生写，正是本 service 的职责。
 *
 * ── 数据访问为什么两条路并存 ────────────────────────────────────────
 *  · 标准 CRUD（记录/跟进/告警/信件的增删改查）走 BaseClient —— 这样模块字段遮蔽（field-mask）、
 *    审计四件套、关联解析全都与全站一致。
 *  · 本 service 的派生逻辑**直连 getSqlStore()** —— 这 4 张表是本系统自建的新表，飞书侧不存在，
 *    走 BaseClient 要依赖 SQL_TABLES 灰度清单；直连 SQL 与 department / curriculum 两个模块同一套路。
 *  · 读学生档案（补年级/班级）走 BaseClient —— 学生档案是**既有飞书表**，直连 SQL 反而在
 *    未迁移的环境里必然失败（表不存在）。失败只降级不报错（年级归到「未填年级」）。
 *
 * ⚠️ SqlStore.search 返回的记录 id 字段名是 `recordId` 而不是 `id`（本项目已 3 次踩过），
 *    本文件一律 `(r as any).recordId ?? (r as any).id ?? ''` 兜底。
 */
@Injectable()
export class BehaviourService {
  private readonly logger = new Logger('Behaviour');

  /** 需要建表的新表（漏一张，对应接口就全线 500） */
  private static readonly OWN_TABLES: readonly { tableId: string; name: string }[] = [
    TABLES.behaviourRecord,
    TABLES.behaviourFollowUp,
    TABLES.behaviourLetter,
    TABLES.studentAlert,
  ];

  constructor(
    @Inject(BASE_CLIENT) private readonly base: BaseClient,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** 启动期幂等建表（未配置 DATABASE_URL 时静默跳过，接口会返回 SQL_DISABLED） */
  async ensureTables(): Promise<void> {
    const sql = getSqlStore();
    if (!sql) {
      this.logger.warn('[behaviour] 未配置 DATABASE_URL，跳过建表（行为记录功能不可用）');
      return;
    }
    for (const t of BehaviourService.OWN_TABLES) {
      // 第三个参数是字段元信息，这里留空：读出的日期/数字保持 jsonb 原值（毫秒戳 / number），
      // 由 behaviour.logic.ts 的 toDateStr / toMs 统一兼容
      await sql.ensureTable(t.tableId, t.name, []);
    }
    this.logger.log(`[behaviour] ${BehaviourService.OWN_TABLES.length} 张表已就绪`);
  }

  private sql(): SqlStore {
    const sql = getSqlStore();
    if (!sql) throw new BadRequestException('SQL_DISABLED:未配置数据库，行为记录功能不可用');
    return sql;
  }

  /** 拉全量（SqlStore 单页上限 500，必须显式翻页；否则统计口径会静默少算） */
  private async fetchAll<T extends { recordId: string; fields: Record<string, unknown> }>(
    sql: SqlStore,
    tableId: string,
  ): Promise<T[]> {
    const out: T[] = [];
    let token: string | undefined;
    let guard = 0;
    do {
      const res = await sql.search(tableId, { pageSize: 500, pageToken: token });
      out.push(...(res.items as unknown as T[]));
      token = res.hasMore ? res.pageToken : undefined;
    } while (token && guard++ < 60);
    return out;
  }

  /** 记录 id 统一取值：SqlStore 给的是 recordId，展平后的行给的是 id，两种都要认 */
  private static idOf(r: unknown): string {
    const o = (r ?? {}) as { recordId?: string; id?: string };
    return String(o.recordId ?? o.id ?? '');
  }

  // ────────────────────────────────────────────────────────────────
  // 1) 告警重算
  // ────────────────────────────────────────────────────────────────

  /** 全量/单人重算（HTTP 入口）：鉴权 + 后台身份 */
  async recalcAlerts(
    user: SessionUser,
    body: { studentId?: string } = {},
  ): Promise<BehaviourRecalcResult> {
    requireModule(user, 'behaviour', 'update');
    const studentId = String(body.studentId ?? '').trim();
    return this.recalcFor(studentId ? [studentId] : undefined);
  }

  /**
   * 行为记录写入后按学生重算（由 BehaviourRecordService 的 create/update/delete 调用）。
   * 这里不再鉴权：调用方（记录写接口）已经校验过 module:behaviour:update。
   */
  async recalcForStudents(studentIds: readonly string[]): Promise<BehaviourRecalcResult> {
    const ids = Array.from(new Set(studentIds.map((s) => String(s ?? '').trim()).filter(Boolean)));
    if (!ids.length) {
      return { ok: true, 新增: 0, 更新: 0, 解除: 0, 未变: 0, 扫描学生数: 0, 扫描记录数: 0, 未关联学生的记录: 0, 告警窗口: [], updatedAt: Date.now() };
    }
    return this.recalcFor(ids);
  }

  /**
   * 重算主体。
   *
   * 口径（唯一真源在 behaviour.logic.ts，勿在此另写一份）：
   *   · 两个窗口各出一条告警：「最近30天」与「本学期（xxxx-xxxx学年第一/第二学期）」
   *   · 负向行为的分值**绝对值**累计 或 负向条数 ≥ 3 触发；等级取满足的最高档
   *   · 记录 id = `<学生id>__<窗口>`，同一学生同一窗口只保留一条（upsert，不堆历史）
   *   · 累计与条数都低于轻度阈值时把状态改为「已解除」而不是删记录
   *
   * ⚠️ 全部写入包在 runAs(system:behaviour-recalc) 里：否则审计的
   *    created_by / updated_by 会落成 system:unknown，「谁改的」这条线索就丢了。
   */
  private async recalcFor(studentIds?: string[]): Promise<BehaviourRecalcResult> {
    const sql = this.sql();
    return runAs(RECALC_ACTOR(), async () => {
      const now = Date.now();
      const windows = alertWindows(now);

      // 1) 全表行为记录 → 事实（一次读全，避免逐学生各扫一遍表）
      const rows = await this.fetchAll<{ recordId: string; fields: Record<string, unknown>; audit?: { createdAt?: string } }>(
        sql,
        TABLES.behaviourRecord.tableId,
      );
      const byStudent = new Map<string, BehaviourFact[]>();
      let unattributed = 0;
      for (const r of rows) {
        const fallbackMs = Date.parse(String(r.audit?.createdAt ?? '')) || 0;
        const fact = factOf(BehaviourService.idOf(r), r.fields, fallbackMs);
        if (!fact.studentId) {
          unattributed++;
          continue;
        }
        const arr = byStudent.get(fact.studentId);
        if (arr) arr.push(fact);
        else byStudent.set(fact.studentId, [fact]);
      }

      // 2) 现有告警快照（按 id）+ 「有告警的学生」集合：
      //    学生的行为记录被全部删除后，也要能走到「解除」分支，所以候选学生要两边取并集
      const existingRows = await this.fetchAll<{ recordId: string; fields: Record<string, unknown> }>(
        sql,
        TABLES.studentAlert.tableId,
      );
      const alertById = new Map<string, { id: string; fields: Record<string, unknown> }>();
      for (const r of existingRows) {
        const id = BehaviourService.idOf(r);
        if (id) alertById.set(id, { id, fields: r.fields ?? {} });
      }

      const targets = studentIds?.length
        ? studentIds
        : Array.from(
            new Set([
              ...byStudent.keys(),
              ...existingRows.map((r) => firstLinkId(r.fields['学生'])).filter(Boolean),
            ]),
          );

      let 新增 = 0;
      let 更新 = 0;
      let 解除 = 0;
      let 未变 = 0;
      const tableId = TABLES.studentAlert.tableId;

      for (const studentId of targets) {
        const facts = byStudent.get(studentId) ?? [];
        // 学生姓名/班级：优先用行为记录里的冗余列（没有记录时退回现有告警上的值）
        const sample = facts[facts.length - 1];
        for (const w of windows) {
          const id = alertIdOf(studentId, w.window);
          const existing = alertById.get(id);
          const ev = evaluateWindow(facts, w.window, w.from, w.to);
          const studentName =
            sample?.studentName || String(existing?.fields['学生姓名'] ?? '');
          const className = sample?.className || String(existing?.fields['班级'] ?? '');

          if (ev.level) {
            // 命中：写入统计值；已解除的告警重新命中时「复活」为未处理
            const status = String(existing?.fields['状态'] ?? '未处理') || '未处理';
            const nextStatus = status === '已解除' ? '未处理' : status;
            const next: Record<string, unknown> = {
              学生: [studentId],
              学生姓名: studentName,
              班级: className,
              告警等级: ev.level,
              告警窗口: ev.window,
              触发原因: ev.reason,
              关联行为条数: ev.count,
              关联分值合计: ev.points,
              首次触发时间: ev.firstMs,
              最近触发时间: ev.lastMs,
              状态: nextStatus,
            };
            if (!existing) {
              await sql.createWithId(tableId, id, {
                ...next,
                处理人: '',
                处理说明: '',
                是否已通知家长: '否',
              });
              新增++;
            } else if (!sameStats(next, existing.fields)) {
              // 只更新派生字段，**不碰** 处理人/处理说明/是否已通知家长 这三个人工字段
              await sql.update(tableId, id, next);
              await this.audit.log({
                actor: currentActor()?.name ?? '系统 · 行为告警重算',
                action: '更新',
                module: 'behaviour/alerts',
                recordId: id,
                summary: `${nextStatus === '未处理' && status === '已解除' ? '重新命中，告警恢复' : '重算告警'}：${ev.level}`,
                detail: ev.reason,
              });
              更新++;
            } else {
              未变++;
            }
          } else if (existing) {
            const status = String(existing?.fields['状态'] ?? '未处理');
            if (status === '已解除') {
              未变++;
              continue;
            }
            // 解除：保留历史记录，只改状态与统计值（等级保留最后一次命中的档，便于回溯）
            const next: Record<string, unknown> = {
              告警窗口: ev.window,
              触发原因: ev.reason,
              关联行为条数: ev.count,
              关联分值合计: ev.points,
              最近触发时间: ev.lastMs || Number(existing.fields['最近触发时间'] ?? 0) || 0,
              状态: '已解除',
            };
            await sql.update(tableId, id, next);
            await this.audit.log({
              actor: currentActor()?.name ?? '系统 · 行为告警重算',
              action: '更新',
              module: 'behaviour/alerts',
              recordId: id,
              summary: '重算告警：已解除',
              detail: ev.reason,
            });
            解除++;
          }
        }
      }

      const result: BehaviourRecalcResult = {
        ok: true,
        新增,
        更新,
        解除,
        未变,
        扫描学生数: targets.length,
        扫描记录数: rows.length,
        未关联学生的记录: unattributed,
        告警窗口: windows.map((w) => w.window),
        updatedAt: now,
      };
      return result;
    });
  }

  // ────────────────────────────────────────────────────────────────
  // 2) 跟进流水（按行为记录取）
  // ────────────────────────────────────────────────────────────────

  /** `GET /behaviour/records/:id/follow-ups`：某条行为的全部跟进流水（按日期倒序） */
  async listFollowUps(user: SessionUser, recordId: string): Promise<FollowUpListResult> {
    requireModule(user, 'behaviour', 'read');
    const sql = this.sql();
    const id = String(recordId ?? '').trim();
    if (!id) return { items: [], total: 0 };
    const rows = await this.fetchAll<{ recordId: string; fields: Record<string, unknown> }>(
      sql,
      TABLES.behaviourFollowUp.tableId,
    );
    const items: Record<string, unknown>[] = rows
      .filter((r) => hasLinkId(r.fields['行为记录'], id))
      .map((r): Record<string, unknown> => ({ id: BehaviourService.idOf(r), ...r.fields }))
      .sort(
        (a, b) =>
          (toMs(b['跟进日期']) ?? 0) - (toMs(a['跟进日期']) ?? 0) ||
          String(b['id']).localeCompare(String(a['id'])),
      );
    return { items, total: items.length };
  }

  // ────────────────────────────────────────────────────────────────
  // 3) 家长通知信件生成
  // ────────────────────────────────────────────────────────────────

  /**
   * `POST /behaviour/letters/generate`：按告警等级生成一封家长通知信件草稿。
   *
   * 幂等：信件记录 id = `<告警id>__<信件类型>`，同一告警同一档重复调用只返回既有信件
   * （`created:false`），不会重复堆积。「创建时计数」= 该学生该档的历史累计次数（含本次），
   * 用于第 N 次措辞。
   *
   * ⚠️ 只生成信件记录，**不真正发邮件/短信** —— 发送状态由人工在列表里维护。
   */
  async generateLetter(
    user: SessionUser,
    body: { studentId?: string; alertId?: string; 收件家长?: string },
  ): Promise<GenerateLetterResult> {
    requireModule(user, 'behaviour', 'create');
    const sql = this.sql();
    const alertId = String(body.alertId ?? '').trim();
    if (!alertId) throw new BadRequestException('VALIDATION:缺少告警 id');

    const alert = await sql.get(TABLES.studentAlert.tableId, alertId);
    if (!alert) throw new NotFoundException('NOT_FOUND:告警不存在');
    const level = String(alert.fields['告警等级'] ?? '').trim();
    if (!level) {
      throw new BadRequestException('VALIDATION:该告警已解除或未命中等，级为空，无法生成家长通知');
    }
    const studentId = String(body.studentId ?? '').trim() || firstLinkId(alert.fields['学生']);
    if (!studentId) throw new BadRequestException('VALIDATION:该告警未关联学生');

    const letterType = letterTypeOf(level);
    const letterId = `${alertId}__${letterType}`;
    const existing = await sql.get(TABLES.behaviourLetter.tableId, letterId);
    if (existing) {
      return { ok: true, created: false, id: letterId, 信件类型: letterType, letter: { id: letterId, ...existing.fields } };
    }

    // 该学生该档的历史累计次数（含本次）：用于「第 N 次」措辞与去重口径的可见性
    const letters = await this.fetchAll<{ recordId: string; fields: Record<string, unknown> }>(
      sql,
      TABLES.behaviourLetter.tableId,
    );
    const nth =
      letters.filter(
        (r) =>
          firstLinkId(r.fields['学生']) === studentId &&
          String(r.fields['信件类型'] ?? '') === letterType,
      ).length + 1;

    const now = Date.now();
    const window = String(alert.fields['告警窗口'] ?? '');
    const range = windowRangeOf(window, now);
    const facts = await this.factsOfStudent(sql, studentId, range.from, range.to);
    const studentName = String(alert.fields['学生姓名'] ?? '') || (facts[facts.length - 1]?.studentName ?? '');
    const issueDate = toDateStr(now);
    const 信件正文 = buildLetterBody({
      studentName,
      className: String(alert.fields['班级'] ?? '') || (facts[facts.length - 1]?.className ?? ''),
      window,
      level,
      points: numOf(alert.fields['关联分值合计']),
      count: numOf(alert.fields['关联行为条数']),
      facts,
      nth,
      issueDate,
    });

    const fields: Record<string, unknown> = {
      学生: [studentId],
      学生姓名: studentName,
      告警: [alertId],
      信件类型: letterType,
      收件家长: String(body.收件家长 ?? '').trim() || `${studentName || '学生'} 家长`,
      信件正文,
      创建时计数: nth,
      状态: '草稿',
      生成时间: now,
      发送时间: '',
    };
    return runAs(systemActor('behaviour-letter', '系统 · 行为通知信件'), async () => {
      await sql.createWithId(TABLES.behaviourLetter.tableId, letterId, fields);
      await this.audit.log({
        actor: user.name || user.openId || 'unknown',
        action: '创建',
        module: 'behaviour/letters',
        recordId: letterId,
        summary: `生成家长通知信件：${letterType}（第 ${nth} 次）`,
        detail: `${studentName} · ${window} · ${level}`,
      });
      return {
        ok: true,
        created: true,
        id: letterId,
        信件类型: letterType,
        第几次: nth,
        letter: { id: letterId, ...fields },
      };
    });
  }

  // ────────────────────────────────────────────────────────────────
  // 4) 按班级/年级汇总
  // ────────────────────────────────────────────────────────────────

  /**
   * `GET /behaviour/stats`：按班级与按年级汇总行为条数（正向/负向）、涉及学生数、告警数（按等级）。
   *
   * 口径说明：
   *   · 行为按「状态 ≠ 已归档」计入（草稿也计 —— 只要记录存在就算事实，归档才是作废）
   *   · 告警按「状态 ≠ 已解除」计入；同一学生可能同时有「最近30天」与「本学期」两条，
   *     所以同时给出 `告警数`（条数）与 `告警人数`（去重学生数）
   *   · 年级优先取学生档案的「当前年级」，取不到时归入「未填年级」（学生档案读失败不影响班级维度）
   */
  async stats(
    user: SessionUser,
    query: { from?: string; to?: string; 班级?: string; 年级?: string } = {},
  ): Promise<BehaviourStatsResult> {
    requireModule(user, 'behaviour', 'read');
    const sql = this.sql();
    const now = Date.now();
    const from = query.from ? new Date(`${query.from}T00:00:00`).getTime() : 0;
    const to = query.to ? new Date(`${query.to}T23:59:59.999`).getTime() : Infinity;

    const students = await this.studentIndex();
    const records = await this.fetchAll<{ recordId: string; fields: Record<string, unknown>; audit?: { createdAt?: string } }>(
      sql,
      TABLES.behaviourRecord.tableId,
    );
    const alerts = await this.fetchAll<{ recordId: string; fields: Record<string, unknown> }>(
      sql,
      TABLES.studentAlert.tableId,
    );

    const byClass = new Map<string, StatsAcc>();
    const byGrade = new Map<string, StatsAcc>();
    const summary: StatsAcc = { row: emptyStatsRow('', ''), students: new Set(), alertStudents: new Set() };

    const bump = (acc: StatsAcc) => {
      acc.row.行为条数++;
    };

    for (const r of records) {
      const f = r.fields ?? {};
      if (String(f['状态'] ?? '') === '已归档') continue;
      const occurred = toMs(f['发生时间']) ?? toMs(f['发生日期']) ?? (Date.parse(String(r.audit?.createdAt ?? '')) || 0);
      if (occurred < from || occurred > to) continue;

      const sid = firstLinkId(f['学生']);
      const info = students.get(sid);
      const className = String(f['班级'] ?? '') || info?.className || '未填班级';
      const grade = info?.grade || '未填年级';
      if (query.班级 && className !== query.班级) continue;
      if (query.年级 && grade !== query.年级) continue;

      const negative = isNegativeBehaviour(f['行为类型'], f['分值']);
      for (const acc of [this.accOf(byClass, className, grade), this.accOf(byGrade, grade, ''), summary]) {
        bump(acc);
        if (negative) acc.row.负向条数++;
        else acc.row.正向条数++;
        if (sid) acc.students.add(sid);
      }
    }

    for (const a of alerts) {
      const f = a.fields ?? {};
      if (String(f['状态'] ?? '') === '已解除') continue;
      const level = String(f['告警等级'] ?? '');
      if (level !== '轻度' && level !== '中度' && level !== '严重') continue;
      const sid = firstLinkId(f['学生']);
      const info = students.get(sid);
      const className = String(f['班级'] ?? '') || info?.className || '未填班级';
      const grade = info?.grade || '未填年级';
      if (query.班级 && className !== query.班级) continue;
      if (query.年级 && grade !== query.年级) continue;
      for (const acc of [this.accOf(byClass, className, grade), this.accOf(byGrade, grade, ''), summary]) {
        acc.row.告警数++;
        if (level === '轻度') acc.row.轻度++;
        else if (level === '中度') acc.row.中度++;
        else acc.row.严重++;
        if (sid) acc.alertStudents.add(sid);
      }
    }

    const finish = (m: Map<string, StatsAcc>) =>
      Array.from(m.entries())
        .map(([key, acc]) => {
          acc.row.涉及学生数 = acc.students.size;
          acc.row.告警人数 = acc.alertStudents.size;
          return { ...acc.row, __key: key };
        })
        .sort((x, y) => x.__key.localeCompare(y.__key, 'zh-CN'))
        .map(({ __key, ...row }) => row as StatsRow);

    summary.row.涉及学生数 = summary.students.size;
    summary.row.告警人数 = summary.alertStudents.size;
    return {
      items: finish(byClass),
      byGrade: finish(byGrade),
      汇总: summary.row,
      阈值: {
    轻度: tierPointsOf('轻度'),
    中度: tierPointsOf('中度'),
    严重: tierPointsOf('严重'),
    条数: ALERT_COUNT_THRESHOLD,
    短窗口: ALERT_WINDOW_RECENT,
  },
      updatedAt: now,
    };
  }

  private accOf(m: Map<string, StatsAcc>, key: string, grade: string): StatsAcc {
    const hit = m.get(key);
    if (hit) return hit;
    const fresh: StatsAcc = { row: emptyStatsRow(key, grade), students: new Set(), alertStudents: new Set() };
    m.set(key, fresh);
    return fresh;
  }

  // ── 内部工具 ──────────────────────────────────────────────────────

  /** 某学生在给定区间内的行为事实 */
  private async factsOfStudent(sql: SqlStore, studentId: string, from: number, to: number): Promise<BehaviourFact[]> {
    const rows = await this.fetchAll<{ recordId: string; fields: Record<string, unknown>; audit?: { createdAt?: string } }>(
      sql,
      TABLES.behaviourRecord.tableId,
    );
    return rows
      .map((r) => factOf(BehaviourService.idOf(r), r.fields, Date.parse(String(r.audit?.createdAt ?? '')) || 0))
      .filter((f) => f.studentId === studentId && f.negative && f.occurredMs >= from && f.occurredMs <= to)
      .sort((a, b) => a.occurredMs - b.occurredMs);
  }

  /**
   * 学生档案索引：record id → { 年级, 班级 }。
   * 学生档案是既有飞书表，走 BaseClient（而非直连 SQL）；读失败一律降级为空索引，
   * 让统计退化成「按记录里的班级」，而不是整个接口 500。
   */
  private async studentIndex(): Promise<Map<string, { grade: string; className: string }>> {
    const out = new Map<string, { grade: string; className: string }>();
    try {
      let token: string | undefined;
      let guard = 0;
      do {
        const res = await this.base.search(TABLES.studentProfile.tableId, { pageSize: 500, pageToken: token });
        for (const r of res.items ?? []) {
          const rec = r as { recordId?: string; id?: string; fields?: Record<string, unknown> };
          const id = BehaviourService.idOf(rec);
          if (!id) continue;
          out.set(id, {
            grade: String(rec.fields?.['当前年级'] ?? ''),
            className: String(rec.fields?.['当前班级'] ?? ''),
          });
        }
        token = res.hasMore ? res.pageToken : undefined;
      } while (token && guard++ < 40);
    } catch (e) {
      this.logger.warn(`[behaviour] 学生档案读取失败，年级维度降级：${(e as Error).message}`);
    }
    return out;
  }
}

/** 派生统计字段是否与库里一致（一致就不写，避免每次重算都把更新时间刷成当前） */
function sameStats(next: Record<string, unknown>, cur: Record<string, unknown>): boolean {
  const keys = [
    '学生姓名', '班级', '告警等级', '告警窗口', '触发原因',
    '关联行为条数', '关联分值合计', '首次触发时间', '最近触发时间', '状态',
  ];
  return keys.every((k) => {
    const a = next[k];
    const b = cur[k];
    if (k === '关联行为条数' || k === '关联分值合计') return numOf(a) === numOf(b);
    if (k === '首次触发时间' || k === '最近触发时间') return (toMs(a) ?? 0) === (toMs(b) ?? 0);
    if (k === '学生') return true;
    return String(a ?? '') === String(b ?? '');
  });
}

interface StatsAcc {
  row: StatsRow;
  students: Set<string>;
  alertStudents: Set<string>;
}

export interface BehaviourRecalcResult {
  ok: boolean;
  新增: number;
  更新: number;
  解除: number;
  未变: number;
  扫描学生数: number;
  扫描记录数: number;
  未关联学生的记录: number;
  告警窗口: string[];
  updatedAt: number;
}

export interface FollowUpListResult {
  items: Record<string, unknown>[];
  total: number;
}

export interface GenerateLetterResult {
  ok: boolean;
  /** false = 该告警同一档已生成过（幂等命中，未重复生成） */
  created: boolean;
  id: string;
  信件类型: string;
  第几次?: number;
  letter: Record<string, unknown>;
}

export interface BehaviourStatsResult {
  /** 按班级 */
  items: StatsRow[];
  /** 按年级 */
  byGrade: StatsRow[];
  汇总: StatsRow;
  /** 当前生效的阈值（前端提示文案用，改口径时同步 behaviour.logic.ts） */
  阈值: { 轻度: number; 中度: number; 严重: number; 条数: number; 短窗口: string };
  updatedAt: number;
}
