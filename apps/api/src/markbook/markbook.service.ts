import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { TABLES } from '@acms/contracts';
import { getSqlStore } from '../base.provider.js';
import {
  buildColumnFields,
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
import {
  homeworkRatesOf,
  readHomeworkTables,
  type HomeworkRate,
} from './homework-link.data.js';
import { normHomeworkName } from './homework-link.logic.js';
// 输入解析与期末总评共用同一个纯函数（「85%」「字母等级」「* 免考」「缺 缺考」都在那里）
import { parseScoreInput } from '../exam-grade/exam-grade.logic.js';

/** 列（一列 = 一次考核） */
export interface GridColumn {
  id: string;
  name: string;
  type: string;
  /** 该「考核类型」的颜色（取自考核类型表，用于列头色块；未配置为空串） */
  typeColor: string;
  /** 该列属于哪个科目（文本，与「班级」同一套口径；空 = 不区分科目） */
  subject: string;
  /**
   * 列描述（自由文本）。2026-09-20 补进返回体：
   * 原先只在写入时用得到，读取不返回 ⇒ 前端编辑一列时初始化成空串，
   * 保存后**描述被静默清空**（老师改个权重，顺带丢了备注）。
   */
  desc: string;
  weight: number;
  fullMark: number;
  scaleId: string;
  date: string;
  sort: number;
  status: string;
  studentVisible: string;
  parentVisible: string;
  completeDate: string;
  /** 该列绑定的作业名称（列上的「关联作业」字段，空 = 未绑定） */
  homeworkName: string;
  /** 绑定作业后附带的完成率（只读展示，见 homework-link.data.ts） */
  homework?: HomeworkRate;
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
  /**
   * 单元格状态：正常 / 免考 / 缺考。
   *
   * 「未录入」不在这里 —— 没有条目就是未录入。
   * 三态的区别直接决定期末总评的分母：
   *   · 免考 → 默认不进分母（可配「计0分」）
   *   · 缺考 → 默认按 0 分进分母（可配「不计入分母」）
   * 老实现只有「有值 / 没值」两态，缺考和免考都无法表达。
   */
  status: string;
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
  /** 列 key → 该列绑定作业的完成率（仅含绑定了作业的列；见 HomeworkSyncService） */
  homeworkRates: Record<string, HomeworkRate>;
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

    // 「绩点」与「是否计入GPA」是 2026-09-16 为考试与成绩新加的两个字段。
    //
    // 为什么单独补一次元数据：ACMS 不做学分制，GPA 只能用「等级 → 绩点」的映射来算；
    // 等级表没配绩点时**必须明说「未配置绩点」**，而不是显示一堆 0.00。
    // ⚠️ 这里只登记这两个字段，其余字段保持无元数据（它们由本 service 手工取值），
    //    避免一次性给老表加元数据改变既有读取行为。
    await sql.ensureTable(TABLES.gradeScaleLevel.tableId, '成绩等级表', [
      { name: '绩点', type: 2, property: { formatter: '0.0' } },
      { name: '是否计入GPA', type: 3, property: { options: [{ name: '是' }, { name: '否' }] } },
    ]);

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

  /**
   * 考核类型索引：类型名 → 颜色 / 缺省权重 / 是否计入总评。
   *
   * 为什么成绩册要读这张表：
   *   1. 列头色块（颜色）
   *   2. **第二层权重的缺省值** —— 以前只有 `markbookWeight`（教学班 × 类型），
   *      没配的班一律按 1 计；现在「考核类型」表给全局缺省，`markbookWeight` 仍可覆盖。
   *   3. 「计入总评 = 否」的类型在结转时整类跳过（由 exam-grade 读取）。
   *
   * 读失败不抛错（返回空索引）：成绩册的主体功能不应当因为一张配置表没建好就挂掉，
   * 最多少一个色块、权重回落成 1 —— 与改造前行为一致。
   */
  private async examTypeIndex(): Promise<Map<string, { color: string; weight: number | null; counted: boolean }>> {
    const out = new Map<string, { color: string; weight: number | null; counted: boolean }>();
    try {
      const sql = getSqlStore();
      if (!sql) return out;
      const rows = await this.readAll(TABLES.examType.tableId);
      for (const r of rows) {
        const name = String(r.f['类型名称'] ?? '').trim();
        if (!name) continue;
        const w = Number(r.f['缺省权重']);
        out.set(name, {
          color: String(r.f['颜色'] ?? '').trim(),
          weight: Number.isFinite(w) && w > 0 ? w : null,
          counted: String(r.f['计入总评'] ?? '是') !== '否',
        });
      }
    } catch {
      /* 配置表还没建 / 读失败 → 空索引，不影响成绩册本身 */
    }
    return out;
  }

  /**
   * 考核类型候选（「成绩类型权重」等页面的下拉数据源）。
   *
   * 🔴 为什么候选项来自**「考核类型」表**而不是字典表：
   *   考核类型是真的业务配置（缺省权重 / 计入总评 / 颜色），而且权重是按**类型名等值匹配**的
   *   （`configsOf` 里 `String(w.f['类型'])` 与列上的「考核类型」逐字比）。
   *   若再放一份到字典，改名后两处不同步 ⇒ 权重**静默不生效**（总评看着就是没加权）。
   *   所以只认这张表（与成绩册列头取颜色、期末考试取「计入总评」都读同一张表）。
   *
   * 🔴 为什么不让前端直接调 `/exam-types`：那张表属「考核类型」模块（`module:examTypes:read`），
   *   而配权重的老师通常只有成绩册权限，直连会 403 ⇒ 下拉空白，看着像「一个类型都没配」。
   *   这里挂 `module:markbook:read`，返回的也只是**名称列表**（不含权重等配置）。
   *
   * ⚠️ 不过滤「状态 = 停用」的类型：停用的类型可能仍被历史列/历史权重引用，
   *   下拉里若没有它，编辑存量记录时那张 select 会显示成「未填写」（值还在、只是看着像丢了）。
   */
  async listTypeOptions(cls = ''): Promise<{
    items: string[];
    /**
     * 富信息（成绩册「新建/修改考核列」的下拉用它）：
     * label 里带上**该类型的权重**，这样老师选类型时就知道这一列会按多少权重算，
     * 不必再跳去「成绩类型权重」页对着看。
     */
    detail: { value: string; label: string; weight: number | null; counted: boolean; color: string }[];
  }> {
    try {
      const c = normClass(cls);
      const typeRows = await this.readAll(TABLES.examType.tableId);
      // 传了班级才读权重表（不带 cls 的调用方——如「成绩类型权重」页——不需要）
      const weightRows = c ? await this.readAll(TABLES.markbookWeight.tableId) : [];

      /**
       * 本班已配的「类型 → 权重」。匹配口径与 `configsOf` 完全一致（`normClass(班级) === cls`），
       * 否则会出现「下拉说本班权重 20、实际算的时候按缺省 50」这种对不上。
       */
      const byClass = new Map<string, number>();
      for (const w of weightRows) {
        if (normClass(w.f['班级']) !== c) continue;
        const name = String(w.f['类型'] ?? '').trim();
        if (name) byClass.set(name, safeWeight(w.f['权重']));
      }

      const types = typeRows
        .map((r) => ({
          name: String(r.f['类型名称'] ?? '').trim(),
          // 排序：表上的「排序」字段优先（运营可在「考核类型」页调）；
          // 都为空（生产现状：defaults 给了 0）时按「缺省权重」升序兜底 ——
          // 也就是日常练习 → 平时成绩 → 实践课程 → 月考 → 期末考试，符合教学推进顺序。
          // 最后按名称兜底，保证**顺序是确定的**（否则下拉顺序会随数据库返回顺序变）。
          sort: Number(r.f['排序']) || 0,
          weight: Number(r.f['缺省权重']) || 0,
          counted: String(r.f['计入总评'] ?? '是') !== '否',
          color: String(r.f['颜色'] ?? '').trim(),
        }))
        .filter((x) => x.name)
        .sort((a, b) => a.sort - b.sort || a.weight - b.weight || a.name.localeCompare(b.name, 'zh-CN'));

      const detail = types.map((x) => {
        const own = byClass.get(x.name);
        const wPart = own !== undefined ? `本班权重 ${own}` : `缺省权重 ${x.weight || 1}`;
        return {
          value: x.name,
          // 括号里那两件事正是「选了对不对」的判据：该类型的权重、以及算不算进期末
          label: `${x.name}（${wPart}${x.counted ? '' : ' · 不计入总评'}）`,
          weight: own ?? x.weight ?? null,
          counted: x.counted,
          color: x.color,
        };
      });

      return { items: detail.map((d) => d.value), detail };
    } catch {
      // 表还没建 / 读失败 → 空候选（页面下拉为空，但不影响其它功能）
      return { items: [], detail: [] };
    }
  }

  private columnOf(
    id: string,
    f: Record<string, any>,
    typeIdx?: Map<string, { color: string; weight: number | null; counted: boolean }>,
  ): GridColumn {
    const type = String(f['考核类型'] ?? '');
    return {
      id,
      name: String(f['列名称'] ?? ''),
      type,
      typeColor: typeIdx?.get(type)?.color ?? '',
      subject: String(f['科目'] ?? '').trim(),
      desc: String(f['描述'] ?? ''),
      weight: safeWeight(f['列权重']),
      fullMark: Number(f['满分']) > 0 ? Number(f['满分']) : 100,
      scaleId: this.linkIds(f['等级体系'])[0] ?? '',
      date: String(f['考核日期'] ?? ''),
      sort: Number(f['排序'] ?? 0) || 0,
      status: String(f['状态'] ?? '启用'),
      studentVisible: String(f['学生可见'] ?? ''),
      parentVisible: String(f['家长可见'] ?? ''),
      completeDate: String(f['完成日期'] ?? ''),
      // 作业绑定的唯一真源（值 = 作业名称，见 homework-link.logic.ts 文件头）
      homeworkName: normHomeworkName(f['关联作业']),
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
      homeworkRates: {},
    };
    if (!c) return empty;

    const [allColumns, students, cfg, targetRows, typeIdx] = await Promise.all([
      this.readAll(TABLES.markbookColumn.tableId),
      this.studentsOf(c),
      this.configsOf(c),
      this.readAll(TABLES.markbookTarget.tableId),
      this.examTypeIndex(),
    ]);

    const columns = allColumns
      .filter((x) => normClass(x.f['班级']) === c && String(x.f['状态'] ?? '启用') !== '停用')
      .map((x) => this.columnOf(x.id, x.f, typeIdx))
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
        // 老数据没有这个字段 → 空串按「正常」处理（不是未录入：有条目就说明录过）
        status: String(e.f['单元格状态'] ?? '正常') || '正常',
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

    // 两层权重的第二层：`markbookWeight`（教学班 × 类型）优先，
    // 没配的班回落到「考核类型」表上的全局缺省权重（2026-09-16 新增）。
    // 以前没配就一律按 1 计，等于第二层权重形同虚设。
    const tw = new Map(cfg.typeWeights.map((x) => [x.type, x.weight]));
    for (const [name, meta] of typeIdx) {
      if (!tw.has(name) && meta.weight != null) tw.set(name, meta.weight);
    }
    const mergedTypeWeights = [...tw.entries()]
      .map(([type, weight]) => ({ type, weight }))
      .sort((a, b) => a.type.localeCompare(b.type, 'zh-CN'));
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

    // 「成绩册 → 作业」的反向展示：给绑定了作业的列附上该班完成率（已完成 / 应完成）。
    // 纯只读增强，不引入任何写路径；读失败不影响网格本身（最多少一个列头角标）。
    const homeworkRates: Record<string, HomeworkRate> = {};
    try {
      const binds = columns
        .filter((x) => x.homeworkName)
        .map((x) => ({ columnId: x.id, homeworkName: x.homeworkName }));
      if (binds.length) {
        const sql = getSqlStore();
        if (sql) {
          const tables = await readHomeworkTables(sql, c);
          Object.assign(homeworkRates, homeworkRatesOf(tables, binds, students.map((s) => s.id)));
          for (const col of columns) {
            const r = homeworkRates[col.id];
            if (r) col.homework = r;
          }
        }
      }
    } catch (e) {
      this.logger.warn(`[markbook] 作业完成率读取失败（忽略）: ${(e as Error).message}`);
    }

    return {
      cls: c,
      columns,
      students,
      cells,
      summary,
      levels: cfg.levelList,
      scales: cfg.scaleList,
      typeWeights: mergedTypeWeights,
      homeworkRates,
    };
  }

  /** 列定义快速索引（保存条目时算快照用） */
  private async columnIndex(cls: string): Promise<{
    columns: Map<string, { col: ColumnDef; fullMark: number }>;
    levels: LevelDef[];
    targets: Map<string, number | null>;
    typeWeights: Map<string, number>;
  }> {
    const [allColumns, cfg, targetRows, typeIdx] = await Promise.all([
      this.readAll(TABLES.markbookColumn.tableId),
      this.configsOf(normClass(cls)),
      this.readAll(TABLES.markbookTarget.tableId),
      this.examTypeIndex(),
    ]);
    const columns = new Map<string, { col: ColumnDef; fullMark: number }>();
    for (const x of allColumns) {
      if (normClass(x.f['班级']) !== normClass(cls)) continue;
      const g = this.columnOf(x.id, x.f, typeIdx);
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
      // 与 getGrid 同一套合并规则：markbookWeight 优先，缺省回落考核类型表
      typeWeights: (() => {
        const m = new Map(cfg.typeWeights.map((x) => [x.type, x.weight]));
        for (const [name, meta] of typeIdx) if (!m.has(name) && meta.weight != null) m.set(name, meta.weight);
        return m;
      })(),
    };
  }

  /**
   * 批量保存条目（二维录入的主写入口）。
   *
   * 解析交给 `parseScoreInput`（与期末总评同一套纯函数），支持：
   *   `85` / `85%` / 字母等级 / `*` 或「免」= 免考 / 「缺」= 缺考 / 越界截断。
   *
   * 返回里带上 `warnings` 与 `errors`：
   *   · warnings = 已自动修正（超满分截断、负数归 0），前端出黄条
   *   · errors   = **没落库**（非法输入如「八十八」），前端出红条并保留用户原值
   * 老实现用 `Number(raw)`，非法输入会 `NaN` → 静默跳过，老师只看到「输入没了」。
   *
   * ⚠️ id 固定为 `${列ID}__${学生ID}`，同一格重复提交是 upsert 而不是新记录。
   */
  async saveEntries(
    cls: string,
    rows: {
      columnId: string;
      studentId: string;
      score: number | string | null;
      status?: string;
      comment?: string;
      visibleStudent?: string;
      visibleParent?: string;
    }[],
  ): Promise<{
    saved: number;
    removed: number;
    skipped: number;
    warnings: { columnId: string; studentId: string; message: string }[];
    errors: { columnId: string; studentId: string; value: string; message: string }[];
  }> {
    const sql = getSqlStore();
    if (!sql) throw new Error('未配置数据库');
    const idx = await this.columnIndex(cls);
    const now = Date.now();
    const upserts: { id: string; fields: Record<string, unknown> }[] = [];
    const deletes: string[] = [];
    const warnings: { columnId: string; studentId: string; message: string }[] = [];
    const errors: { columnId: string; studentId: string; value: string; message: string }[] = [];
    let skipped = 0;

    for (const r of rows) {
      const meta = idx.columns.get(String(r.columnId));
      if (!meta) {
        skipped++;
        continue;
      }
      const id = `${r.columnId}__${r.studentId}`;
      const raw = r.score;
      const levels = meta.col.scaleId
        ? idx.levels.filter((l) => l.scaleId === meta.col.scaleId)
        : idx.levels;

      // 显式状态优先（前端把「免」/「缺」当状态传，而不是当分数传）
      const explicitStatus = String(r.status ?? '').trim();
      const isEmpty = raw === null || raw === undefined || String(raw).trim() === '';

      // 三态下的删除规则：
      //   · 状态=正常 且 空 → 删除该条目（未录入）
      //   · 状态=免考/缺考 → **即使没有分数也要落库**（这正是要表达的信息）
      if (isEmpty && (explicitStatus === '' || explicitStatus === '正常')) {
        deletes.push(id);
        continue;
      }

      const parsed = parseScoreInput(isEmpty ? (explicitStatus === '缺考' ? '缺' : '*') : raw, {
        fullMark: meta.fullMark,
        levels,
      });

      if (!parsed.ok) {
        errors.push({
          columnId: String(r.columnId),
          studentId: String(r.studentId),
          value: parsed.display,
          message: parsed.error ?? '输入无法解析',
        });
        continue;
      }
      if (parsed.warning) {
        warnings.push({ columnId: String(r.columnId), studentId: String(r.studentId), message: parsed.warning });
      }

      // 状态：显式传入优先，否则用解析结果
      const status = explicitStatus || parsed.status;
      const score = status === '免考' ? null : parsed.score;
      const normed = score == null ? null : normScore(score, meta.fullMark);
      const snap = snapshotOf(levels, normed, idx.targets.get(String(r.studentId)) ?? null);

      const fields: Record<string, unknown> = {
        成绩册列: String(r.columnId),
        学生: String(r.studentId),
        班级: normClass(cls),
        得分: score == null ? '' : score,
        单元格状态: status,
        百分制: normed == null ? '' : normed,
        等级: status === '免考' ? '' : snap.level,
        等级序号: status === '免考' ? null : snap.levelOrder,
        是否关注: status === '免考' ? '' : snap.levelConcern ? '是' : '',
        是否达标: status === '免考' ? '' : snap.attained,
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
    return { saved: upserts.length, removed, skipped, warnings, errors };
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
    subject?: string;
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
    /**
     * 字段构造放在纯函数 `buildColumnFields` 里（2026-09-20）。
     *
     * 抽出去是为了能单测：这条「未传的字段不覆盖」的规则一旦回退成
     * `String(payload.x ?? '')`，症状是「改一下权重，把科目/可见性/完成闸门一起清空」——
     * 不报错、不留痕，而且科目没了期末总评就拆不出科目。纯函数才测得住。
     *
     * ⚠️ 「关联作业」不在这里：它由作业同步面板走 /markbook/homework-bind 单独绑定（唯一真源）。
     */
    const fields = buildColumnFields(payload);
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
