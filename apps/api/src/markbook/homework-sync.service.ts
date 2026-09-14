import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { TABLES, type SessionUser } from '@acms/contracts';
import { getSqlStore } from '../base.provider.js';
import { runAs, systemActor } from '../shared/actor-context.js';
import { requireModule } from '../shared/require-module.js';
import { MarkbookService } from './markbook.service.js';
import { textOf } from './markbook.logic.js';
import {
  completionOf,
  fetchAll,
  homeworkRatesOf,
  readExistingEntries,
  readHomeworkTables,
  type HomeworkRate,
} from './homework-link.data.js';
import {
  HOMEWORK_BIND_FIELD,
  completionRate,
  normHomeworkName,
  planHomeworkSync,
  summarizePlan,
  type PlanRow,
  type SyncMode,
} from './homework-link.logic.js';

/**
 * 作业 ↔ 成绩册联动服务（主方向：作业 → 成绩册）。
 *
 * 定位：成绩册已有一套成熟的写入口（`MarkbookService.saveEntries`，内含等级快照、
 * 两层权重、条目 id 约定 `${列ID}__${学生ID}`）。本服务**不重写这套逻辑**，
 * 只负责「把作业的完成情况翻译成一批 score」，然后交给 saveEntries 落库 ——
 * 这样等级 / 等级序号 / 是否达标 / 关注标记的快照口径与手工录入**逐字节相同**。
 *
 * 三条硬约定：
 *  1. `planHomeworkSync()` 是 preview 与 sync 的**同一份**计划器（见 homework-link.logic.ts），
 *     预览看到的格子 = 实际写入的格子。
 *  2. 写库包在 `runAs(systemActor('homework-sync', …))` 里：这次写入的来源是「作业同步」
 *     而不是某个人的手工录入，审计要能区分（否则出问题查不出是谁改的成绩）。
 *  3. 未完成 / 无提交**留空**，不写 0（语义见 homework-link.logic.ts 文件头）。
 *
 * 权限：预览 / 作业目录走 `module:markbook:read`，绑定 / 同步走 `module:markbook:update`。
 */
@Injectable()
export class HomeworkSyncService {
  private readonly logger = new Logger('HomeworkSync');

  constructor(private readonly markbook: MarkbookService) {}

  private sql() {
    const sql = getSqlStore();
    if (!sql) throw new BadRequestException('SQL_DISABLED:未配置数据库，作业同步不可用');
    return sql;
  }

  /** 该班所有考核列（含绑定信息 + 名册），供本服务各方法复用 */
  private async context(cls: string) {
    const c = normHomeworkName(cls);
    if (!c) throw new BadRequestException('VALIDATION:班级不能为空');
    const grid = await this.markbook.getGrid(c);
    const students = grid.students.map((s) => ({ id: s.id, name: s.name }));
    return {
      cls: c,
      columns: grid.columns,
      students,
      rosterIds: students.map((s) => s.id),
    };
  }

  /**
   * 定位目标列。**找不到就报错，绝不静默新建** ——
   * 静默建列会让「绑定错了」表现成「多出来一列莫名其妙的全是分」，比报错难查得多。
   */
  private async resolveColumn(cls: string, homeworkName: string, columnId?: string) {
    const ctx = await this.context(cls);
    if (!ctx.students.length) throw new BadRequestException(`VALIDATION:班级「${cls}」下没有在读学生，无法同步`);

    let col = columnId ? ctx.columns.find((x) => x.id === columnId) : undefined;
    if (columnId && !col) throw new BadRequestException('VALIDATION:指定的考核列不存在，或不属于该班级（或已停用）');

    if (!col) {
      const name = normHomeworkName(homeworkName);
      const bound = ctx.columns.filter((x) => normHomeworkName(x.homeworkName) === name);
      if (!bound.length) {
        throw new BadRequestException(
          `VALIDATION:该班还没有关联作业「${name}」的成绩册列。请先在成绩册新建一列（如「${name}」），` +
            '并把该列的「关联作业」设为这个作业名称，再回来同步。',
        );
      }
      if (bound.length > 1) {
        throw new BadRequestException(
          `VALIDATION:该班有 ${bound.length} 列都关联了作业「${name}」（${bound.map((x) => x.name).join('、')}），` +
            '请显式指定要同步到哪一列。',
        );
      }
      col = bound[0];
    }
    return { ctx, col: col as (typeof ctx.columns)[number] };
  }

  /** 组装计划（preview / sync 共用） */
  private async buildPlan(cls: string, homeworkName: string, columnId: string | undefined, mode: SyncMode) {
    const { ctx, col } = await this.resolveColumn(cls, homeworkName, columnId);
    const sql = this.sql();
    const hmName = normHomeworkName(homeworkName) || normHomeworkName(col.homeworkName);
    const [tables, existing] = await Promise.all([
      readHomeworkTables(sql, ctx.cls, hmName),
      readExistingEntries(sql, col.id),
    ]);
    const trackers = tables.trackers.get(hmName) ?? new Map();
    const submissions = tables.submissions.get(hmName) ?? new Map();
    const rows = planHomeworkSync({
      students: ctx.students,
      trackers,
      submissions,
      existing,
      fullMark: col.fullMark,
      mode,
    });
    const completion = completionOf(tables, hmName, ctx.rosterIds);
    return { ctx, col, hmName, existing, rows, completion };
  }

  /**
   * 预览：返回**将要写入的每一格**（学生 / 当前值 / 将写入值 / 原因）。
   * 批量写成绩不能盲写，所以这个接口是必需的，且与 sync 共用同一份计划器。
   */
  async preview(
    user: SessionUser,
    q: { cls?: string; homeworkName?: string; columnId?: string; mode?: SyncMode },
  ): Promise<HomeworkSyncPreview> {
    requireModule(user, 'markbook', 'read');
    const cls = normHomeworkName(q?.cls);
    const homeworkName = normHomeworkName(q?.homeworkName);
    const mode: SyncMode = q?.mode === 'overwrite' ? 'overwrite' : 'fill-empty';
    if (!cls) throw new BadRequestException('VALIDATION:班级不能为空');

    const { col, hmName, rows, completion } = await this.buildPlan(cls, homeworkName, q?.columnId, mode);
    if (!hmName) throw new BadRequestException('VALIDATION:作业名称不能为空');

    const sum = summarizePlan(rows);
    return {
      cls,
      homeworkName: hmName,
      columnId: col.id,
      columnName: col.name,
      fullMark: col.fullMark,
      mode,
      done: completion.done,
      total: completion.total,
      rate: completionRate(completion.done, completion.total),
      ...sum,
      rows,
    };
  }

  /**
   * 执行同步：按计划写入成绩册条目。
   *
   * - 只写「空格」（默认）或「覆盖已有值」（mode='overwrite'）
   * - 未完成 / 无提交的格子**不写**；overwrite 模式下若该格有遗留分数则**清空**
   *   （overwrite 的语义 = 让这一列如实反映作业状态）
   * - 覆盖时把条目上原有的「评语 / 学生可见 / 家长可见」**原样带过去**：
   *   saveEntries 走 bulkInsert（ON CONFLICT DO UPDATE SET data = EXCLUDED.data）是整行替换，
   *   不带这些字段就会把教师手工写的评语抹掉。
   */
  async sync(
    user: SessionUser,
    body: { cls?: string; homeworkName?: string; columnId?: string; mode?: SyncMode },
  ): Promise<HomeworkSyncResult> {
    requireModule(user, 'markbook', 'update');
    const cls = normHomeworkName(body?.cls);
    const homeworkName = normHomeworkName(body?.homeworkName);
    const mode: SyncMode = body?.mode === 'overwrite' ? 'overwrite' : 'fill-empty';
    if (!cls) throw new BadRequestException('VALIDATION:班级不能为空');

    const { ctx, col, hmName, existing, rows, completion } = await this.buildPlan(
      cls,
      homeworkName,
      body?.columnId,
      mode,
    );
    if (!hmName) throw new BadRequestException('VALIDATION:作业名称不能为空');

    // 明细行 → saveEntries 的入参。score=null 表示删除该条目（overwrite 的清空路径）
    const payload = rows
      .filter((r) => r.willWrite || r.willClear)
      .map((r) => {
        const ex = existing.get(r.studentId);
        return {
          columnId: col.id,
          studentId: r.studentId,
          score: r.willClear ? null : r.next,
          // 原样回写：整行替换语义下，不回写等于把评语/可见性抹掉
          comment: ex?.comment ?? '',
          visibleStudent: ex?.visibleStudent ?? '',
          visibleParent: ex?.visibleParent ?? '',
        };
      });

    if (payload.length) {
      await runAs(systemActor('homework-sync', '系统 · 作业同步'), async () => {
        await this.markbook.saveEntries(ctx.cls, payload);
      });
    }
    this.logger.log(
      `[homework-sync] ${ctx.cls} / ${hmName} → 列「${col.name}」✓ 写入 ${payload.length} 格（fill=${payload.filter((p) => p.score != null).length}，clear=${payload.filter((p) => p.score == null).length}）`,
    );

    const sum = summarizePlan(rows);
    return {
      cls,
      homeworkName: hmName,
      columnId: col.id,
      columnName: col.name,
      fullMark: col.fullMark,
      mode,
      done: completion.done,
      total: completion.total,
      rate: completionRate(completion.done, completion.total),
      ...sum,
      rows,
      saved: payload.length,
    };
  }

  /**
   * 该班可选作业目录（前端第二步的下拉）。
   * 顺带带上「已完成 / 总人数」和「已绑定到哪一列」，用户一眼能看出还差什么。
   */
  async catalog(user: SessionUser, cls: string): Promise<HomeworkOption[]> {
    requireModule(user, 'markbook', 'read');
    const c = normHomeworkName(cls);
    if (!c) return [];
    const sql = this.sql();
    const grid = await this.markbook.getGrid(c);
    const rosterIds = grid.students.map((s) => s.id);
    const tables = await readHomeworkTables(sql, c);

    const boundBy = new Map<string, { id: string; name: string }>();
    for (const col of grid.columns) {
      const n = normHomeworkName(col.homeworkName);
      if (n && !boundBy.has(n)) boundBy.set(n, { id: col.id, name: col.name });
    }

    return tables.names.map((name) => {
      const done = completionOf(tables, name, rosterIds);
      const trackedMap = tables.trackers.get(name);
      const roster = new Set(rosterIds);
      let tracked = 0;
      if (trackedMap) for (const sid of trackedMap.keys()) if (roster.has(sid)) tracked++;
      return {
        homeworkName: name,
        done: done.done,
        total: done.total,
        tracked,
        rate: completionRate(done.done, done.total),
        columnId: boundBy.get(name)?.id ?? '',
        columnName: boundBy.get(name)?.name ?? '',
      };
    });
  }

  /**
   * 绑定 / 解绑「列 ↔ 作业」。
   *
   * 绑定关系存在 `markbookColumn.关联作业` 字段（值 = 作业名称），不新建表。
   * 用 `sql.update`（`data = data || patch` 的 jsonb 合并）写入，
   * 所以既不会覆盖列上的其他字段，也不会被后续的列编辑（POST /markbook/columns）抹掉。
   * `homeworkName` 传空 = 解绑。
   */
  async bind(
    user: SessionUser,
    body: { cls?: string; columnId?: string; homeworkName?: string },
  ): Promise<{ ok: true; columnId: string; columnName: string; homeworkName: string }> {
    requireModule(user, 'markbook', 'update');
    const sql = this.sql();
    const cls = normHomeworkName(body?.cls);
    const columnId = String(body?.columnId ?? '');
    const homeworkName = normHomeworkName(body?.homeworkName);
    if (!columnId) throw new BadRequestException('VALIDATION:columnId 不能为空');

    const rows = await fetchAll(sql, TABLES.markbookColumn.tableId);
    const col = rows.find((r) => r.id === columnId);
    if (!col) throw new BadRequestException('VALIDATION:考核列不存在');
    if (cls && normHomeworkName(col.f['班级']) !== cls) {
      throw new BadRequestException('VALIDATION:该考核列不属于这个班级');
    }

    await runAs(systemActor('homework-sync', '系统 · 作业同步'), async () => {
      await sql.update(TABLES.markbookColumn.tableId, columnId, { [HOMEWORK_BIND_FIELD]: homeworkName });
    });
    return { ok: true, columnId, columnName: textOf(col.f['列名称']), homeworkName };
  }

  /**
   * 网格列头用的完成率（只读）。
   * 不注入 MarkbookService（会被 MarkbookService.getGrid 反向依赖），直接吃 SqlStore。
   */
  async ratesForColumns(
    cls: string,
    binds: { columnId: string; homeworkName: string }[],
    rosterIds: string[],
  ): Promise<Record<string, HomeworkRate>> {
    if (!binds.length) return {};
    const sql = getSqlStore();
    if (!sql) return {};
    const tables = await readHomeworkTables(sql, normHomeworkName(cls));
    return homeworkRatesOf(tables, binds, rosterIds);
  }
}

// ── 返回体（与 apps/web/lib/api.ts 的追加类型一一对应）──────────────────

export interface HomeworkOption {
  homeworkName: string;
  done: number;
  total: number;
  /** 追踪表里实际有记录的人数（< total 说明教师还没记全，不是学生全没做） */
  tracked: number;
  rate: number;
  /** 已绑定到哪一列（空串 = 还没建/没绑） */
  columnId: string;
  columnName: string;
}

export interface HomeworkSyncPreview {
  cls: string;
  homeworkName: string;
  columnId: string;
  columnName: string;
  fullMark: number;
  mode: SyncMode;
  done: number;
  total: number;
  rate: number;
  scanned: number;
  filled: number;
  overwritten: number;
  cleared: number;
  skipped: number;
  blank: number;
  rows: PlanRow[];
}

export interface HomeworkSyncResult extends HomeworkSyncPreview {
  /** 实际发给成绩册写入口的行数（含清空） */
  saved: number;
}

/** 列头的完成率（MarkbookGrid.columns[].homework） */
export type { HomeworkRate };
