import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { TABLES } from '@acms/contracts';
import { getSqlStore } from '../base.provider.js';
import {
  effectiveWeight,
  normClass,
  normScore,
  pickLevel,
  safeWeight,
  snapshotOf,
  weightedTotal,
  type ColumnDef,
  type LevelDef,
} from './markbook.logic.js';

/** 列（一列 = 一次考核） */
export interface GridColumn {
  id: string;
  name: string;
  type: string;
  weight: number;
  fullMark: number;
  scaleId: string;
  date: string;
  sort: number;
  status: string;
  studentVisible: string;
  parentVisible: string;
  completeDate: string;
}

/** 名单里的学生 */
export interface GridStudent {
  id: string;
  name: string;
  enName: string;
}

/** 单元格（一条成绩册条目） */
export interface GridCell {
  columnId: string;
  studentId: string;
  score: number | null;
  level: string;
  levelOrder: number | null;
  concern: boolean;
  attained: string;
  comment: string;
}

/** 每个学生的汇总行 */
export interface GridSummary {
  studentId: string;
  total: number | null;
  level: string;
  levelOrder: number | null;
  concern: boolean;
  targetLevel: string;
  targetOrder: number | null;
  attained: boolean | null;
  filled: number;
  weightSum: number;
}

export interface MarkbookGrid {
  cls: string;
  columns: GridColumn[];
  students: GridStudent[];
  cells: GridCell[];
  summary: GridSummary[];
  levels: LevelDef[];
  scales: { id: string; name: string; isDefault: boolean }[];
  typeWeights: { type: string; weight: number }[];
}

export interface MarkbookClassOption {
  cls: string;
  students: number;
  columns: number;
  entries: number;
}

/**
 * 成绩册服务。
 *
 * 读取侧一律「全表拉 + 内存过滤」：ACMS 单校量级（学生 82、列几十、条目几千）
 * 完全撑得住，换来的是**不用手写 jsonb SQL**（少一类易错点）。
 * 量级上来了再改成 SQL 聚合。
 */
@Injectable()
export class MarkbookService implements OnModuleInit {
  private readonly logger = new Logger('Markbook');

  async onModuleInit(): Promise<void> {
    await this.ensureTables();
  }

  /** 幂等建表（6 张：等级体系 / 等级 / 类型权重 / 列 / 条目 / 个人目标） */
  async ensureTables(): Promise<void> {
    const sql = getSqlStore();
    if (!sql) {
      this.logger.warn('[markbook] 未配置 DATABASE_URL，跳过建表（成绩册不可用）');
      return;
    }
    const list: [string, string][] = [
      [TABLES.gradeScale.tableId, '成绩等级体系表'],
      [TABLES.gradeScaleLevel.tableId, '成绩等级表'],
      [TABLES.markbookWeight.tableId, '成绩类型权重表'],
      [TABLES.markbookColumn.tableId, '成绩册列表'],
      [TABLES.markbookEntry.tableId, '成绩册条目表'],
      [TABLES.markbookTarget.tableId, '成绩个人目标表'],
    ];
    for (const [tableId, name] of list) await sql.ensureTable(tableId, name, []);
    this.logger.log(`[markbook] 已就绪 ${list.length} 张表`);
  }

  /** 通用读取：返回 [{ id, fields }]（SqlStore 的 id 字段名是 recordId，统一兜底） */
  private async readAll(tableId: string): Promise<{ id: string; f: Record<string, any> }[]> {
    const sql = getSqlStore();
    if (!sql) return [];
    const res = await sql.search(tableId, { pageSize: 5000 });
    return (res.items || []).map((r) => {
      const x = r as unknown as { recordId?: string; id?: string; fields?: Record<string, any> };
      return { id: String(x.recordId ?? x.id ?? ''), f: (x.fields || {}) as Record<string, any> };
    });
  }

  /**
   * 分组维度（成绩册里的「班级」）取自学生档案的哪些字段，按优先级排列。
   *
   * ⚠️ 实测（2026-09-13，82 名学生）：「当前班级」是**关联字段且全为 null**
   *    （`{"link_record_ids": null}`），取不到可读值；「当前年级」才是真正有值的那一列
   *    （Pre-1 / Pre-2 / Pre-3 / 大一 / 未来企业家班 / 全球领航计划）。
   *    所以这里按序回落 —— 将来「当前班级」的关联补上了，会自动优先用它，不必改代码。
   */
  private static readonly CLASS_FIELDS = ['当前班级', '当前年级'] as const;

  /** 取某学生记录的分组维度（班级） */
  private classOf(f: Record<string, any>): string {
    for (const k of MarkbookService.CLASS_FIELDS) {
      const t = normClass(f[k]);
      if (t) return t;
    }
    return '';
  }

  private levelOf(f: Record<string, any>): LevelDef {
    const num = (k: string): number | null => {
      const v = f[k];
      if (v === null || v === undefined || v === '') return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    return {
      id: String(f.id ?? ''),
      scaleId: String(f['所属体系'] ?? ''),
      label: String(f['显示值'] ?? f['等级名称'] ?? ''),
      order: num('序号') ?? 999,
      min: num('分数下限'),
      max: num('分数上限'),
      concern: String(f['是否关注'] ?? '') === '是' || f['是否关注'] === true,
    };
  }

  private columnOf(id: string, f: Record<string, any>): GridColumn {
    return {
      id,
      name: String(f['列名称'] ?? ''),
      type: String(f['考核类型'] ?? ''),
      weight: safeWeight(f['列权重']),
      fullMark: Number(f['满分']) > 0 ? Number(f['满分']) : 100,
      scaleId: this.linkIds(f['等级体系'])[0] ?? '',
      date: String(f['考核日期'] ?? ''),
      sort: Number(f['排序'] ?? 0) || 0,
      status: String(f['状态'] ?? '启用'),
      studentVisible: String(f['学生可见'] ?? ''),
      parentVisible: String(f['家长可见'] ?? ''),
      completeDate: String(f['完成日期'] ?? ''),
    };
  }

  /** 关联字段兼容：单值时是字符串，多值时是数组，也可能带 `__link` 数组 */
  private linkIds(v: unknown): string[] {
    if (v == null || v === '') return [];
    if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean);
    return [String(v)];
  }

  /** 可选班级列表（取自学生档案的「当前班级」）+ 该班列数/已录条目数 */
  async listClasses(): Promise<MarkbookClassOption[]> {
    const [students, columns, entries] = await Promise.all([
      this.readAll(TABLES.studentProfile.tableId),
      this.readAll(TABLES.markbookColumn.tableId),
      this.readAll(TABLES.markbookEntry.tableId),
    ]);
    const colToCls = new Map<string, string>();
    for (const c of columns) colToCls.set(c.id, normClass(c.f['班级']));

    const map = new Map<string, MarkbookClassOption>();
    const ensure = (cls: string): MarkbookClassOption => {
      let o = map.get(cls);
      if (!o) {
        o = { cls, students: 0, columns: 0, entries: 0 };
        map.set(cls, o);
      }
      return o;
    };
    for (const s of students) {
      const cls = this.classOf(s.f);
      if (cls) ensure(cls).students++;
    }
    for (const c of columns) {
      const cls = normClass(c.f['班级']);
      if (cls) ensure(cls).columns++;
    }
    for (const e of entries) {
      const cls = colToCls.get(this.linkIds(e.f['成绩册列'])[0] ?? '') ?? '';
      if (cls) ensure(cls).entries++;
    }
    return [...map.values()].sort((a, b) => a.cls.localeCompare(b.cls, 'zh-CN'));
  }

  /** 班级名单（学生档案的分组维度匹配，排除已毕业/已离校/已流失） */
  private async studentsOf(cls: string): Promise<GridStudent[]> {
    const rows = await this.readAll(TABLES.studentProfile.tableId);
    const BAD = /毕业|离校|流失|退学/;
    return rows
      .filter((r) => this.classOf(r.f) === cls && !BAD.test(String(r.f['当前状态'] ?? '')))
      .map((r) => ({
        id: r.id,
        name: String(r.f['学生姓名'] ?? ''),
        enName: String(r.f['英文名'] ?? ''),
      }))
      .filter((s) => s.name)
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  }

  /** 等级体系 + 等级 + 班级的类型权重 */
  private async configsOf(cls: string) {
    const [scales, levels, weights] = await Promise.all([
      this.readAll(TABLES.gradeScale.tableId),
      this.readAll(TABLES.gradeScaleLevel.tableId),
      this.readAll(TABLES.markbookWeight.tableId),
    ]);
    const scaleList = scales
      .filter((s) => String(s.f['状态'] ?? '启用') !== '停用')
      .map((s) => ({ id: s.id, name: String(s.f['名称'] ?? ''), isDefault: String(s.f['是否默认'] ?? '') === '是' }));
    const defaultScaleId = scaleList.find((s) => s.isDefault)?.id ?? scaleList[0]?.id ?? '';
    const levelList = levels.map((l) => {
      const lv = this.levelOf({ ...l.f, id: l.id });
      return lv.scaleId ? lv : { ...lv, scaleId: defaultScaleId };
    });
    const typeWeights = weights
      .filter((w) => normClass(w.f['班级']) === cls)
      .map((w) => ({ type: String(w.f['类型'] ?? ''), weight: safeWeight(w.f['权重']) }));
    return { scaleList, levelList, typeWeights, defaultScaleId };
  }

  /** 取整个班级的网格（列 × 学生 + 单元格 + 按学生汇总） */
  async getGrid(cls: string): Promise<MarkbookGrid> {
    const c = normClass(cls);
    const empty: MarkbookGrid = {
      cls: c,
      columns: [],
      students: [],
      cells: [],
      summary: [],
      levels: [],
      scales: [],
      typeWeights: [],
    };
    if (!c) return empty;

    const [allColumns, students, cfg, targetRows] = await Promise.all([
      this.readAll(TABLES.markbookColumn.tableId),
      this.studentsOf(c),
      this.configsOf(c),
      this.readAll(TABLES.markbookTarget.tableId),
    ]);

    const columns = allColumns
      .filter((x) => normClass(x.f['班级']) === c && String(x.f['状态'] ?? '启用') !== '停用')
      .map((x) => this.columnOf(x.id, x.f))
      .sort((a, b) => a.sort - b.sort || a.date.localeCompare(b.date) || a.name.localeCompare(b.name, 'zh-CN'));

    const colIds = new Set(columns.map((x) => x.id));
    const stuIds = new Set(students.map((s) => s.id));

    const entryRows = await this.readAll(TABLES.markbookEntry.tableId);
    const cells: GridCell[] = [];
    for (const e of entryRows) {
      const columnId = this.linkIds(e.f['成绩册列'])[0] ?? '';
      const studentId = this.linkIds(e.f['学生'])[0] ?? '';
      if (!colIds.has(columnId) || !stuIds.has(studentId)) continue;
      const raw = e.f['得分'];
      const score = raw === '' || raw === null || raw === undefined ? null : Number(raw);
      cells.push({
        columnId,
        studentId,
        score: Number.isFinite(score as number) ? (score as number) : null,
        level: String(e.f['等级'] ?? ''),
        levelOrder: Number.isFinite(Number(e.f['等级序号'])) && e.f['等级序号'] !== '' ? Number(e.f['等级序号']) : null,
        concern: String(e.f['是否关注'] ?? '') === '是',
        attained: String(e.f['是否达标'] ?? ''),
        comment: String(e.f['评语'] ?? ''),
      });
    }

    // 目标：学生 × 班级
    const targets = new Map<string, { level: string; order: number | null }>();
    for (const t of targetRows) {
      if (normClass(t.f['班级']) !== c) continue;
      const sid = this.linkIds(t.f['学生'])[0] ?? '';
      if (!sid) continue;
      const order = Number(t.f['目标等级序号']);
      targets.set(sid, {
        level: String(t.f['目标等级'] ?? ''),
        order: Number.isFinite(order) && t.f['目标等级序号'] !== '' ? order : null,
      });
    }

    const tw = new Map(cfg.typeWeights.map((x) => [x.type, x.weight]));
    const cellMap = new Map(cells.map((x) => [`${x.columnId}__${x.studentId}`, x]));
    const summary: GridSummary[] = students.map((s) => {
      const items: { score: number; weight: number }[] = [];
      for (const col of columns) {
        const cell = cellMap.get(`${col.id}__${s.id}`);
        if (!cell || cell.score == null) continue;
        items.push({
          score: normScore(cell.score, col.fullMark),
          // 两层权重：列权重 × 类型权重
          weight: effectiveWeight(col.weight, tw.get(col.type) ?? 1),
        });
      }
      const agg = weightedTotal(items);
      // 该生用哪套等级：优先列上指定的体系，否则默认体系
      const scaleIds = new Set(columns.map((x) => x.scaleId).filter(Boolean));
      const useScale = scaleIds.size === 1 ? [...scaleIds][0] : scaleIds.size > 1 ? '' : cfg.defaultScaleId;
      const levels = useScale ? cfg.levelList.filter((l) => l.scaleId === useScale) : cfg.levelList;
      const lv = pickLevel(levels, agg.total);
      const tgt = targets.get(s.id) ?? { level: '', order: null };
      return {
        studentId: s.id,
        total: agg.total,
        level: lv ? lv.label : '',
        levelOrder: lv ? lv.order : null,
        concern: lv ? lv.concern : false,
        targetLevel: tgt.level,
        targetOrder: tgt.order,
        attained: tgt.order == null || !lv ? null : lv.order <= tgt.order,
        filled: agg.count,
        weightSum: agg.weightSum,
      };
    });

    return {
      cls: c,
      columns,
      students,
      cells,
      summary,
      levels: cfg.levelList,
      scales: cfg.scaleList,
      typeWeights: cfg.typeWeights,
    };
  }

  /** 列定义快速索引（保存条目时算快照用） */
  private async columnIndex(cls: string): Promise<{
    columns: Map<string, { col: ColumnDef; fullMark: number }>;
    levels: LevelDef[];
    targets: Map<string, number | null>;
    typeWeights: Map<string, number>;
  }> {
    const [allColumns, cfg, targetRows] = await Promise.all([
      this.readAll(TABLES.markbookColumn.tableId),
      this.configsOf(normClass(cls)),
      this.readAll(TABLES.markbookTarget.tableId),
    ]);
    const columns = new Map<string, { col: ColumnDef; fullMark: number }>();
    for (const x of allColumns) {
      if (normClass(x.f['班级']) !== normClass(cls)) continue;
      const g = this.columnOf(x.id, x.f);
      columns.set(x.id, {
        col: {
          id: x.id,
          name: g.name,
          type: g.type,
          weight: g.weight,
          fullMark: g.fullMark,
          scaleId: g.scaleId || cfg.defaultScaleId,
        },
        fullMark: g.fullMark,
      });
    }
    const targets = new Map<string, number | null>();
    for (const t of targetRows) {
      if (normClass(t.f['班级']) !== normClass(cls)) continue;
      const sid = this.linkIds(t.f['学生'])[0] ?? '';
      const order = Number(t.f['目标等级序号']);
      if (sid) targets.set(sid, Number.isFinite(order) && t.f['目标等级序号'] !== '' ? order : null);
    }
    return {
      columns,
      levels: cfg.levelList,
      targets,
      typeWeights: new Map(cfg.typeWeights.map((x) => [x.type, x.weight])),
    };
  }

  /**
   * 批量保存条目（二维录入的主写入口）。
   * - `score` 为 null/'' → **删除**该条目（保持表干净，不存空壳）
   * - 有值 → 计算「等级 / 等级序号 / 是否达标 / 是否关注」快照后 upsert
   * ⚠️ id 固定为 `${列ID}__${学生ID}`，同一格重复提交是 upsert 而不是新记录
   */
  async saveEntries(
    cls: string,
    rows: { columnId: string; studentId: string; score: number | string | null; comment?: string; visibleStudent?: string; visibleParent?: string }[],
  ): Promise<{ saved: number; removed: number; skipped: number }> {
    const sql = getSqlStore();
    if (!sql) throw new Error('未配置数据库');
    const idx = await this.columnIndex(cls);
    const now = Date.now();
    const upserts: { id: string; fields: Record<string, unknown> }[] = [];
    const deletes: string[] = [];
    let skipped = 0;

    for (const r of rows) {
      const meta = idx.columns.get(String(r.columnId));
      if (!meta) {
        skipped++;
        continue;
      }
      const id = `${r.columnId}__${r.studentId}`;
      const raw = r.score;
      if (raw === null || raw === undefined || raw === '') {
        deletes.push(id);
        continue;
      }
      const score = Number(raw);
      if (!Number.isFinite(score)) {
        skipped++;
        continue;
      }
      const normed = normScore(score, meta.fullMark);
      const levels = meta.col.scaleId
        ? idx.levels.filter((l) => l.scaleId === meta.col.scaleId)
        : idx.levels;
      const snap = snapshotOf(levels, normed, idx.targets.get(String(r.studentId)) ?? null);
      const fields: Record<string, unknown> = {
        成绩册列: String(r.columnId),
        学生: String(r.studentId),
        班级: normClass(cls),
        得分: score,
        百分制: normed,
        等级: snap.level,
        等级序号: snap.levelOrder,
        是否关注: snap.levelConcern ? '是' : '',
        是否达标: snap.attained,
        录入时间: now,
      };
      if (r.comment !== undefined) fields['评语'] = r.comment;
      if (r.visibleStudent !== undefined) fields['学生可见'] = r.visibleStudent;
      if (r.visibleParent !== undefined) fields['家长可见'] = r.visibleParent;
      upserts.push({ id, fields });
    }

    if (upserts.length) await sql.bulkInsert(TABLES.markbookEntry.tableId, upserts);
    let removed = 0;
    for (const id of deletes) {
      await sql.delete(TABLES.markbookEntry.tableId, id);
      removed++;
    }
    return { saved: upserts.length, removed, skipped };
  }

  /**
   * 重算该班所有条目的快照（等价于「以源表为准重算」的维护入口）。
   * 什么时候要用：改了等级体系（区间/序号）、改了个人目标之后 ——
   * 条目上的等级是写入时的快照，**不会**自动跟着变。
   */
  async recalc(cls: string): Promise<{ scanned: number; updated: number }> {
    const sql = getSqlStore();
    if (!sql) throw new Error('未配置数据库');
    const c = normClass(cls);
    if (!c) return { scanned: 0, updated: 0 };
    const idx = await this.columnIndex(c);
    const rows = (await this.readAll(TABLES.markbookEntry.tableId)).filter((e) => {
      const columnId = this.linkIds(e.f['成绩册列'])[0] ?? '';
      return idx.columns.has(columnId);
    });
    const upserts: { id: string; fields: Record<string, unknown> }[] = [];
    for (const e of rows) {
      const columnId = this.linkIds(e.f['成绩册列'])[0] ?? '';
      const studentId = this.linkIds(e.f['学生'])[0] ?? '';
      const meta = idx.columns.get(columnId);
      const rawScore = Number(e.f['得分']);
      if (!meta || !Number.isFinite(rawScore)) continue;
      const normed = normScore(rawScore, meta.fullMark);
      const levels = meta.col.scaleId ? idx.levels.filter((l) => l.scaleId === meta.col.scaleId) : idx.levels;
      const snap = snapshotOf(levels, normed, idx.targets.get(studentId) ?? null);
      const changed =
        String(e.f['等级'] ?? '') !== snap.level ||
        String(e.f['是否达标'] ?? '') !== snap.attained ||
        Number(e.f['等级序号'] ?? 0) !== (snap.levelOrder ?? 0) ||
        String(e.f['是否关注'] ?? '') !== (snap.levelConcern ? '是' : '') ||
        Number(e.f['百分制'] ?? 0) !== normed;
      if (!changed) continue;
      upserts.push({
        id: e.id,
        fields: {
          ...e.f,
          百分制: normed,
          等级: snap.level,
          等级序号: snap.levelOrder,
          是否关注: snap.levelConcern ? '是' : '',
          是否达标: snap.attained,
        },
      });
    }
    if (upserts.length) await sql.bulkInsert(TABLES.markbookEntry.tableId, upserts);
    return { scanned: rows.length, updated: upserts.length };
  }

  /**
   * 新建/更新一列（列管理）。
   * 列改名会同步刷新该列所有条目的「等级」快照（因为等级快照挂在条目上，
   * 但列改的是满分/等级体系 → 快照必须重算，否则新旧列混着看会对不上）。
   */
  async saveColumn(payload: {
    id?: string;
    cls: string;
    name: string;
    type?: string;
    weight?: number;
    fullMark?: number;
    scaleId?: string;
    date?: string;
    desc?: string;
    sort?: number;
    status?: string;
    studentVisible?: string;
    parentVisible?: string;
    completeDate?: string;
  }): Promise<{ id: string }> {
    const sql = getSqlStore();
    if (!sql) throw new Error('未配置数据库');
    if (!payload.id && !normClass(payload.cls)) throw new Error('班级不能为空');
    const fields: Record<string, unknown> = {
      班级: normClass(payload.cls),
      列名称: String(payload.name ?? '').trim(),
      考核类型: String(payload.type ?? ''),
      列权重: Number(payload.weight) > 0 ? Number(payload.weight) : 1,
      满分: Number(payload.fullMark) > 0 ? Number(payload.fullMark) : 100,
      等级体系: payload.scaleId ? [String(payload.scaleId)] : [],
      考核日期: String(payload.date ?? ''),
      描述: String(payload.desc ?? ''),
      排序: Number(payload.sort) || 0,
      状态: String(payload.status ?? '启用'),
      学生可见: String(payload.studentVisible ?? ''),
      家长可见: String(payload.parentVisible ?? ''),
      完成日期: String(payload.completeDate ?? ''),
    };
    if (!fields['列名称']) throw new Error('列名称不能为空');
    if (payload.id) {
      await sql.update(TABLES.markbookColumn.tableId, payload.id, fields);
      return { id: payload.id };
    }
    const id = await sql.create(TABLES.markbookColumn.tableId, fields);
    return { id: String(id) };
  }

  /** 删除一列（连同该列的条目一起删，避免留孤儿数据） */
  async deleteColumn(columnId: string): Promise<{ removedEntries: number }> {
    const sql = getSqlStore();
    if (!sql) throw new Error('未配置数据库');
    const rows = await this.readAll(TABLES.markbookEntry.tableId);
    let removed = 0;
    for (const e of rows) {
      if ((this.linkIds(e.f['成绩册列'])[0] ?? '') !== columnId) continue;
      await sql.delete(TABLES.markbookEntry.tableId, e.id);
      removed++;
    }
    await sql.delete(TABLES.markbookColumn.tableId, columnId);
    return { removedEntries: removed };
  }
}
