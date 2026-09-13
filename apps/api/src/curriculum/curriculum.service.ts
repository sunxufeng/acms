import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { TABLES, type SessionUser } from '@acms/contracts';
import type { BaseRecord, FilterGroup } from '@acms/base-adapter';
import { getSqlStore } from '../base.provider.js';
import type { SqlStore } from '../sql-store/sql-store.js';
import { requireModule } from '../shared/require-module.js';
import {
  computeLate,
  firstLinkId,
  hasLinkId,
  numOf,
  planDeploy,
  ratio,
  toDateStr,
  toMs,
} from './curriculum.logic.js';

/**
 * 课程规划专用逻辑（通用 CRUD 承载不了的三件事）：
 *
 *  1. `deploy`     把某次「单元开课」下的全部环节按顺序部署到该教学班的课次上
 *  2. `coverage`   按教学班汇总覆盖率（单元数 / 状态分布 / 环节部署数 / 部署到课次的占比）
 *  3. `recomputeLate`  按「截止时间 vs 提交时间」重算作业迟交（补齐改时间与批量导入的场景）
 *
 * 直连 `getSqlStore()` 而**不走 BaseClient**：这 12 张表是本系统自建的新表，
 * 飞书侧不存在、也不在 SQL_TABLES 灰度清单里（与 department.service.ts 同一套路）。
 * 通用 CRUD 走 BaseClient，部署时需保证 SQL_TABLES 覆盖这些 tableId（或置 `*`）。
 *
 * ⚠️ SqlStore.search 返回的记录 id 字段名是 `recordId` 而不是 `id`（本项目已反复踩坑），
 *    这里一律通过 `r.recordId` 取，不要写成 `(r as any).id`。
 */
@Injectable()
export class CurriculumService {
  private readonly logger = new Logger('Curriculum');

  /** 需要建表的新表（漏一张，对应接口就全线 500） */
  private static readonly OWN_TABLES: readonly { tableId: string; name: string }[] = [
    TABLES.curriculumUnit,
    TABLES.curriculumUnitBlock,
    TABLES.curriculumUnitClass,
    TABLES.unitClassBlock,
    TABLES.learningOutcome,
    TABLES.unitOutcome,
    TABLES.lessonEntry,
    TABLES.lessonOutcome,
    TABLES.homeworkSubmission,
    TABLES.homeworkTracker,
  ];

  /** 启动期幂等建表（未配置 DATABASE_URL 时静默跳过，接口会返回 SQL_DISABLED） */
  async ensureTables(): Promise<void> {
    const sql = getSqlStore();
    if (!sql) {
      this.logger.warn('[curriculum] 未配置 DATABASE_URL，跳过建表（课程规划功能不可用）');
      return;
    }
    for (const t of CurriculumService.OWN_TABLES) {
      // 第三个参数是字段元信息：这里留空，读出的日期/数字保持 jsonb 原值（毫秒戳 / number），
      // 由 curriculum.logic.ts 的 toDateStr/toMs 统一兼容，避免依赖 acms_fields 元数据是否齐备
      await sql.ensureTable(t.tableId, t.name, []);
    }
    this.logger.log(`[curriculum] ${CurriculumService.OWN_TABLES.length} 张表已就绪`);
  }

  private sql(): SqlStore {
    const sql = getSqlStore();
    if (!sql) throw new BadRequestException('SQL_DISABLED:未配置数据库，课程规划功能不可用');
    return sql;
  }

  /** 拉全量（SqlStore 单页上限 500，必须显式翻页；否则报表口径会静默少算） */
  private async fetchAll(sql: SqlStore, tableId: string, filter?: FilterGroup): Promise<BaseRecord[]> {
    const out: BaseRecord[] = [];
    let token: string | undefined;
    let guard = 0;
    do {
      const res = await sql.search(tableId, { pageSize: 500, pageToken: token, filter });
      out.push(...res.items);
      token = res.hasMore ? res.pageToken : undefined;
    } while (token && guard++ < 60);
    return out;
  }

  /** 按 record id 批量取名（关联字段展示用；新表没有 acms_fields 元数据，只能逐个取） */
  private async namesOf(sql: SqlStore, tableId: string, nameField: string, ids: Iterable<string>): Promise<Map<string, string>> {
    const uniq = Array.from(new Set(Array.from(ids).filter(Boolean)));
    const map = new Map<string, string>();
    for (let i = 0; i < uniq.length; i += 20) {
      const batch = uniq.slice(i, i + 20);
      const recs = await Promise.all(batch.map((id) => sql.get(tableId, id)));
      recs.forEach((rec, idx) => {
        const id = batch[idx] as string;
        map.set(id, String(rec?.fields?.[nameField] ?? '') || id);
      });
    }
    return map;
  }

  // ────────────────────────────────────────────────────────────────
  // 1) 部署环节到课次
  // ────────────────────────────────────────────────────────────────

  /**
   * 把「单元开课」对应的单元环节按顺序部署到该教学班的课次上。
   *
   * - 取该开课的开始/结束日期区间内的课次，按课次日期升序
   * - 第 i 个环节 → 第 i 个课次（课时数只做展示，不做跨节编排）
   * - `replaceExisting`（默认 true）会先清掉该开课已生成的部署记录再重建；
   *   传 false 则保留已部署的环节，只补没部署过的
   * - 逐条 upsert unitClassBlock（记录 id = `ucb_<开课id>__<环节id>`，重跑不会堆重复数据）
   */
  async deploy(
    user: SessionUser,
    unitClassId: string,
    body: { replaceExisting?: boolean } = {},
  ): Promise<DeployResult> {
    requireModule(user, 'curriculum', 'update');
    const sql = this.sql();

    const unitClass = await sql.get(TABLES.curriculumUnitClass.tableId, unitClassId);
    if (!unitClass) throw new NotFoundException('NOT_FOUND');
    const unitId = firstLinkId(unitClass.fields['单元']);
    const classId = firstLinkId(unitClass.fields['教学班']);
    if (!unitId) throw new BadRequestException('VALIDATION:该开课未关联单元，无法部署');
    if (!classId) throw new BadRequestException('VALIDATION:该开课未关联教学班，无法部署');

    const start = toDateStr(unitClass.fields['开始日期']);
    const end = toDateStr(unitClass.fields['结束日期']);

    // 环节：按「排序」数值升序；排序相同时按创建时间（稳定），先建的在前。
    // ⚠️ 「环节状态 = 停用」的环节不参与部署（也不计入覆盖率的环节总数）——
    //    否则教师把某一环停用后，部署率永远到不了 100%，等于这个开关没意义。
    const blockRows = await this.fetchAll(sql, TABLES.curriculumUnitBlock.tableId, {
      conjunction: 'and',
      conditions: [{ field: '所属单元', op: 'contains', value: [unitId] }],
    });
    const ownBlocks = blockRows.filter((r) => hasLinkId(r.fields['所属单元'], unitId));
    const blocks = ownBlocks
      .filter((r) => String(r.fields['环节状态'] ?? '启用') !== '停用')
      .sort(
        (a, b) =>
          numOf(a.fields['排序']) - numOf(b.fields['排序']) ||
          String(a.audit?.createdAt ?? '').localeCompare(String(b.audit?.createdAt ?? '')),
      );
    if (!blocks.length) {
      throw new BadRequestException(
        ownBlocks.length
          ? 'VALIDATION:该单元下的环节都已停用，请先在「单元环节」里启用需要部署的环节'
          : 'VALIDATION:该单元下还没有环节，请先到「单元环节」里维护',
      );
    }

    const sessions = await this.sessionsOfClass(sql, classId, start, end);
    if (!sessions.length) {
      const range = start || end ? `（${start || '不限'} ~ ${end || '不限'}）` : '';
      throw new BadRequestException(
        `VALIDATION:该教学班在开课区间${range}内没有排课课次，无法部署`,
      );
    }

    const existing = (await this.fetchAll(sql, TABLES.unitClassBlock.tableId, {
      conjunction: 'and',
      conditions: [{ field: '所属开课', op: 'contains', value: [unitClassId] }],
    })).filter((r) => hasLinkId(r.fields['所属开课'], unitClassId));

    const replaceExisting = body.replaceExisting !== false;
    if (replaceExisting) {
      for (const r of existing) await sql.delete(TABLES.unitClassBlock.tableId, r.recordId);
    }
    const deployedBlockIds = replaceExisting
      ? []
      : existing.map((r) => firstLinkId(r.fields['环节'])).filter(Boolean);

    const plan = planDeploy(
      blocks.map((b) => b.recordId),
      sessions.map((s) => s.recordId),
      deployedBlockIds,
      replaceExisting,
    );

    const sessionById = new Map(sessions.map((s) => [s.recordId, s]));
    // 逐条写而不是走 bulkInsert：bulkInsert 不写 created_by，部署记录的「创建人」
    // 会一律落成 system:unknown，把「谁部署的」这条线索丢掉。环节数量是十位数量级，
    // 逐条 createWithId 的开销可以忽略（它本身就是 upsert，重跑不会堆重复数据）。
    for (const p of plan.pairs) {
      const session = sessionById.get(p.sessionId);
      // 授课日期统一落「本地零点的毫秒戳」：课次日期读出来可能是 'YYYY-MM-DD'（有字段元数据时）
      // 也可能是毫秒戳（无元数据时），两种都先归一到日期串再取本地零点，
      // 这样部署生成的记录与前台用 DateField 改出来的值形态完全一致。
      const day = toDateStr(session?.fields['课次日期']);
      await sql.createWithId(TABLES.unitClassBlock.tableId, `ucb_${unitClassId}__${p.blockId}`, {
        所属开课: [unitClassId],
        环节: [p.blockId],
        课次: [p.sessionId],
        单元: [unitId],
        授课日期: day ? (toMs(`${day}T00:00:00`) ?? '') : '',
        部署状态: '未开始',
      });
    }

    const unitName = String((await sql.get(TABLES.curriculumUnit.tableId, unitId))?.fields['单元名称'] ?? '');
    return {
      ok: true,
      开课: unitClassId,
      开课名称: String(unitClass.fields['开课名称'] ?? ''),
      单元: unitId,
      单元名称: unitName,
      环节数: blocks.length,
      可用课次数: sessions.length,
      已部署: plan.pairs.length,
      已跳过: plan.skippedBlockIds.length,
      课次不足的环节数: plan.overflowBlockIds.length,
      空余课次数: plan.idleSessionIds.length,
      覆盖重建: replaceExisting,
    };
  }

  /**
   * 取某教学班在给定日期区间内的课次（按课次日期升序）。
   *
   * 课次与教学班的关联字段是「关联教学班」（关联类型，存 record id 数组）。
   * 数据质量问题兜底：历史课次可能只填了「教学班文本」没挂关联 ——
   * 关联筛不出任何课时，退回按教学班名称做文本匹配。
   */
  private async sessionsOfClass(
    sql: SqlStore,
    classId: string,
    start: string,
    end: string,
  ): Promise<BaseRecord[]> {
    let rows = (await this.fetchAll(sql, TABLES.session.tableId, {
      conjunction: 'and',
      conditions: [{ field: '关联教学班', op: 'contains', value: [classId] }],
    })).filter((r) => hasLinkId(r.fields['关联教学班'], classId));

    if (!rows.length) {
      const cls = await sql.get(TABLES.teachingClass.tableId, classId);
      const className = String(cls?.fields['教学班名称'] ?? '').trim();
      if (className) {
        rows = (await this.fetchAll(sql, TABLES.session.tableId, {
          conjunction: 'and',
          conditions: [{ field: '教学班文本', op: 'contains', value: [className] }],
        })).filter((r) => String(r.fields['教学班文本'] ?? '').includes(className));
      }
    }

    return rows
      .map((r) => ({ r, date: toDateStr(r.fields['课次日期']) }))
      .filter(({ date }) => {
        if (!date) return false;
        if (start && date < start) return false;
        if (end && date > end) return false;
        return true;
      })
      .sort(
        (a, b) =>
          a.date.localeCompare(b.date) ||
          String(a.r.fields['开始时间'] ?? '').localeCompare(String(b.r.fields['开始时间'] ?? '')),
      )
      .map(({ r }) => r);
  }

  // ────────────────────────────────────────────────────────────────
  // 2) 覆盖率统计
  // ────────────────────────────────────────────────────────────────

  /**
   * 按教学班汇总覆盖率。
   *
   * 口径：
   *   - 单元总数 = 该班开课记录数（一个单元在一班只开一次课）
   *   - 环节总数 = 该班所有来开课单元的「单元环节」数之和
   *   - 已部署环节 = unitClassBlock 里挂到该开课上的环节数
   *   - 已部署到课次的占比 = 挂了课次的部署环节 / 环节总数（这是 Gibbon 说的 "coverage"）
   *
   * 全量拉取后在内存聚合：单元规划是「百量级」数据，一次读全比写 SQL 聚合简单且口径可控。
   */
  async coverage(
    user: SessionUser,
    query: { 课程方案?: string; 学年?: string; 教学班?: string } = {},
  ): Promise<CoverageResult> {
    requireModule(user, 'curriculum', 'read');
    const sql = this.sql();
    const updatedAt = Date.now();

    // 1) 单元：按课程方案 / 学年过滤
    let units = await this.fetchAll(sql, TABLES.curriculumUnit.tableId);
    if (query.课程方案) units = units.filter((r) => hasLinkId(r.fields['课程方案'], String(query.课程方案)));
    if (query.学年) units = units.filter((r) => hasLinkId(r.fields['学年'], String(query.学年)));
    const unitById = new Map(units.map((r) => [r.recordId, r]));
    const unitIds = new Set(unitById.keys());

    // 2) 环节：只算落在上面这些单元里的，且「停用」的不计入（与 deploy 的口径保持一致，
    //    否则停用一个环节后部署率永远到不了 100%）
    const blocks = (await this.fetchAll(sql, TABLES.curriculumUnitBlock.tableId)).filter(
      (r) =>
        unitIds.has(firstLinkId(r.fields['所属单元'])) &&
        String(r.fields['环节状态'] ?? '启用') !== '停用',
    );
    const blockCountOfUnit = new Map<string, number>();
    for (const b of blocks) {
      const uid = firstLinkId(b.fields['所属单元']);
      blockCountOfUnit.set(uid, (blockCountOfUnit.get(uid) ?? 0) + 1);
    }

    // 3) 开课：只算上面这些单元的开课
    let unitClasses = (await this.fetchAll(sql, TABLES.curriculumUnitClass.tableId)).filter((r) =>
      unitIds.has(firstLinkId(r.fields['单元'])),
    );
    if (query.教学班) unitClasses = unitClasses.filter((r) => hasLinkId(r.fields['教学班'], String(query.教学班)));
    const ucById = new Map(unitClasses.map((r) => [r.recordId, r]));

    // 4) 部署环节：只算上面这些开课的
    const deployed = (await this.fetchAll(sql, TABLES.unitClassBlock.tableId)).filter((r) =>
      ucById.has(firstLinkId(r.fields['所属开课'])),
    );
    const deployOfUnitClass = new Map<string, { total: number; onSession: number; byStatus: Map<string, number> }>();
    for (const d of deployed) {
      const ucid = firstLinkId(d.fields['所属开课']);
      const acc = deployOfUnitClass.get(ucid) ?? { total: 0, onSession: 0, byStatus: new Map<string, number>() };
      acc.total++;
      if (firstLinkId(d.fields['课次'])) acc.onSession++;
      const st = String(d.fields['部署状态'] ?? '未开始');
      acc.byStatus.set(st, (acc.byStatus.get(st) ?? 0) + 1);
      deployOfUnitClass.set(ucid, acc);
    }

    // 5) 取展示名（教学班；单元名已在 unitById 里）
    const classNames = await this.namesOf(
      sql,
      TABLES.teachingClass.tableId,
      '教学班名称',
      unitClasses.map((r) => firstLinkId(r.fields['教学班'])),
    );
    const unitNames = await this.namesOf(sql, TABLES.curriculumUnit.tableId, '单元名称', unitIds);

    // 6) 按教学班聚合
    const byClass = new Map<string, CoverageRow>();
    for (const uc of unitClasses) {
      const classId = firstLinkId(uc.fields['教学班']) || '未关联教学班';
      const unitId = firstLinkId(uc.fields['单元']);
      const agg = deployOfUnitClass.get(uc.recordId) ?? { total: 0, onSession: 0, byStatus: new Map() };
      const blockTotal = blockCountOfUnit.get(unitId) ?? 0;
      const fresh: CoverageRow = {
        教学班: classId,
        教学班名称: classNames.get(classId) ?? classId,
        单元总数: 0,
        未开始: 0,
        进行中: 0,
        已完成: 0,
        已取消: 0,
        环节总数: 0,
        已部署环节数: 0,
        已部署课次环节数: 0,
        部署率: 0,
        未部署环节数: 0,
        单元: [],
      };
      const row = byClass.get(classId) ?? fresh;

      row.单元总数++;
      const status = String(uc.fields['开课状态'] ?? '未开始');
      if (status === '进行中') row.进行中++;
      else if (status === '已完成') row.已完成++;
      else if (status === '已取消') row.已取消++;
      else row.未开始++;
      row.环节总数 += blockTotal;
      row.已部署环节数 += agg.total;
      row.已部署课次环节数 += agg.onSession;
      row.单元.push({
        开课: uc.recordId,
        开课名称: String(uc.fields['开课名称'] ?? ''),
        单元: unitId,
        单元名称: unitNames.get(unitId) ?? unitId,
        开课状态: status,
        开始日期: toDateStr(uc.fields['开始日期']),
        结束日期: toDateStr(uc.fields['结束日期']),
        环节总数: blockTotal,
        已部署环节数: agg.total,
        已完成环节数: agg.byStatus.get('已完成') ?? 0,
        已跳过环节数: agg.byStatus.get('已跳过') ?? 0,
      });
      byClass.set(classId, row);
    }

    const items = Array.from(byClass.values()).map((row) => {
      row.部署率 = ratio(row.已部署课次环节数, row.环节总数);
      row.未部署环节数 = Math.max(0, row.环节总数 - row.已部署环节数);
      row.单元.sort((a, b) => a.开始日期.localeCompare(b.开始日期) || a.单元名称.localeCompare(b.单元名称, 'zh-CN'));
      return row;
    });
    items.sort((a, b) => a.教学班名称.localeCompare(b.教学班名称, 'zh-CN'));

    const 汇总 = items.reduce(
      (acc, r) => {
        acc.教学班数++;
        acc.单元总数 += r.单元总数;
        acc.未开始 += r.未开始;
        acc.进行中 += r.进行中;
        acc.已完成 += r.已完成;
        acc.已取消 += r.已取消;
        acc.环节总数 += r.环节总数;
        acc.已部署环节数 += r.已部署环节数;
        acc.已部署课次环节数 += r.已部署课次环节数;
        return acc;
      },
      {
        教学班数: 0,
        单元总数: 0,
        未开始: 0,
        进行中: 0,
        已完成: 0,
        已取消: 0,
        环节总数: 0,
        已部署环节数: 0,
        已部署课次环节数: 0,
        部署率: 0,
      },
    );
    汇总.部署率 = ratio(汇总.已部署课次环节数, 汇总.环节总数);

    return { items, 汇总, updatedAt };
  }

  // ────────────────────────────────────────────────────────────────
  // 3) 作业迟交核算
  // ────────────────────────────────────────────────────────────────

  /**
   * 重算作业迟交（是否迟交 / 迟交分钟数）。
   *
   * 新建时已由 RecordMeta.defaults 算过一次；这里是补算入口，覆盖两种场景：
   *   1. 教师事后改了「截止时间」或「提交时间」
   *   2. 批量导入 / 迁移进来的历史提交记录
   *
   * `dryRun=true` 只回结果不写库，方便先在页面上确认影响范围。
   */
  async recomputeLate(
    user: SessionUser,
    body: { ids?: string[]; 教学班?: string; dryRun?: boolean } = {},
  ): Promise<RecomputeLateResult> {
    requireModule(user, 'lessonPlan', 'update');
    const sql = this.sql();

    let rows: BaseRecord[];
    if (body.ids?.length) {
      const recs = await Promise.all(body.ids.map((id) => sql.get(TABLES.homeworkSubmission.tableId, id)));
      rows = recs.filter((r): r is BaseRecord => !!r);
    } else if (body.教学班) {
      rows = (await this.fetchAll(sql, TABLES.homeworkSubmission.tableId, {
        conjunction: 'and',
        conditions: [{ field: '教学班', op: 'contains', value: [String(body.教学班)] }],
      })).filter((r) => hasLinkId(r.fields['教学班'], String(body.教学班)));
    } else {
      rows = await this.fetchAll(sql, TABLES.homeworkSubmission.tableId);
    }

    const dryRun = body.dryRun === true;
    let 缺时间 = 0;
    let 无变化 = 0;
    const changes: RecomputeLateChange[] = [];
    for (const r of rows) {
      const late = computeLate(r.fields['提交时间'], r.fields['截止时间']);
      if (!late) {
        缺时间++;
        continue;
      }
      const before = String(r.fields['是否迟交'] ?? '');
      const beforeMin = numOf(r.fields['迟交分钟数']);
      if (before === late.是否迟交 && beforeMin === late.迟交分钟数) {
        无变化++;
        continue;
      }
      changes.push({
        id: r.recordId,
        作业名称: String(r.fields['作业名称'] ?? ''),
        原是否迟交: before,
        新是否迟交: late.是否迟交,
        原迟交分钟数: beforeMin,
        新迟交分钟数: late.迟交分钟数,
      });
      if (!dryRun) {
        await sql.update(TABLES.homeworkSubmission.tableId, r.recordId, {
          是否迟交: late.是否迟交,
          迟交分钟数: late.迟交分钟数,
        });
      }
    }

    return {
      scanned: rows.length,
      changed: changes.length,
      unchanged: 无变化,
      missingTime: 缺时间,
      dryRun,
      // 明细可能很长，只回前 50 条给界面看
      changes: changes.slice(0, 50),
      truncated: changes.length > 50,
    };
  }
}

export interface DeployResult {
  ok: boolean;
  开课: string;
  开课名称: string;
  单元: string;
  单元名称: string;
  环节数: number;
  /** 开课区间内可用的课次数 */
  可用课次数: number;
  /** 本次实际写入的部署条数 */
  已部署: number;
  /** replaceExisting=false 时已部署过、本次跳过的环节数 */
  已跳过: number;
  /** 课次不够，没能排进去的环节数 */
  课次不足的环节数: number;
  /** 没排到环节的空余课次数 */
  空余课次数: number;
  覆盖重建: boolean;
}

export interface CoverageUnitRow {
  开课: string;
  开课名称: string;
  单元: string;
  单元名称: string;
  开课状态: string;
  开始日期: string;
  结束日期: string;
  环节总数: number;
  已部署环节数: number;
  已完成环节数: number;
  已跳过环节数: number;
}

export interface CoverageRow {
  教学班: string;
  教学班名称: string;
  单元总数: number;
  未开始: number;
  进行中: number;
  已完成: number;
  已取消: number;
  环节总数: number;
  已部署环节数: number;
  已部署课次环节数: number;
  /** 已部署到课次的环节 / 环节总数（0~1，四位小数） */
  部署率: number;
  未部署环节数: number;
  单元: CoverageUnitRow[];
}

export interface CoverageSummary {
  教学班数: number;
  单元总数: number;
  未开始: number;
  进行中: number;
  已完成: number;
  已取消: number;
  环节总数: number;
  已部署环节数: number;
  已部署课次环节数: number;
  部署率: number;
}

export interface CoverageResult {
  items: CoverageRow[];
  汇总: CoverageSummary;
  updatedAt: number;
}

export interface RecomputeLateChange {
  id: string;
  作业名称: string;
  原是否迟交: string;
  新是否迟交: string;
  原迟交分钟数: number;
  新迟交分钟数: number;
}

export interface RecomputeLateResult {
  /** 扫描条数 */
  scanned: number;
  /** 需要改写的条数 */
  changed: number;
  /** 已经没有变化、跳过的条数 */
  unchanged: number;
  /** 截止时间或提交时间缺失、判定不了的条数 */
  missingTime: number;
  dryRun: boolean;
  changes: RecomputeLateChange[];
  truncated: boolean;
}
