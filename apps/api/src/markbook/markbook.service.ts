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
  columnInTerm,
  isUnassignedTerm,
  levelOptionItems,
  snapshotOf,
  subjectColumnDrafts,
  statsOfScores,
  sumOfScores,
  targetLabelOf,
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
  /** 学年（字典「学年」；空 = 未归属） */
  year: string;
  /** 学期（字典「教学学期」；空 = 未归属） */
  term: string;
  /**
   * 是否「未归属学年学期」（历史列）。
   *
   * 界面要把它标出来：这类列在**任何**学年学期的筛选下都会出现
   * （`columnInTerm` 的兜底），不标的话老师会疑惑「我切到 2025学年 怎么还有它」。
   */
  unassigned: boolean;
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
  /**
   * 目标等级**名**。
   *
   * ⚠️ 2026-09-20 起是「目标记录上写了名字就用它，没写就按目标等级序号从等级体系反查」——
   * 因为「学生成绩目标」页的表单只有**目标分 + 目标等级序号**（没有「目标等级」字段），
   * 只认名字会永远显示「未设置」，见 `getGrid` 里的注释。
   */
  targetLevel: string;
  targetOrder: number | null;
  /**
   * 目标序号是否存在于该生的等级体系里。false = 这条目标**永远判不出达标**
   * （判定是「实际等级序号 ≤ 目标序号」，序号不在体系里必然为假），前端要显式提示。
   */
  targetOrderKnown: boolean;
  /** 目标分（成绩目标表上的「目标分」；只用于展示与提示，不参与达标判定） */
  targetScore: number | null;
  attained: boolean | null;
  filled: number;
  weightSum: number;
}

/**
 * 每项（列）的全班统计 —— 「竖排」视图的行尾均分/最高/最低。
 * 口径见 `statsOfScores`（等级制与免考不计入分母）。
 */
export interface GridColumnStat {
  columnId: string;
  count: number;
  mean: number | null;
  max: number | null;
  min: number | null;
}

/** 学生 × 考核类型 的**原始分合计**（视图里的「类型小计」；只加能解析成数字的） */
export interface GridTypeTotal {
  studentId: string;
  /** 考核类型名（'' = 未指定类型） */
  type: string;
  sum: number | null;
  count: number;
}

/**
 * 学生 × 学科 的**加权均分（百分制）与等级** —— 「按学科分列/分行」两种视图用。
 *
 * 与总评**同一套算法**（`Σ(归一化得分 × 列权重 × 类型权重) / Σ权重`），只是把范围限定在一个学科内；
 * 等级用该生实际使用的等级体系（与 `summary.level` 同源），所以两边不会打架。
 * `subject` 为空串 = 未指定学科。
 */
export interface GridSubjectSummary {
  studentId: string;
  subject: string;
  weighted: number | null;
  count: number;
  level: string;
}

export interface MarkbookGrid {
  cls: string;
  columns: GridColumn[];
  students: GridStudent[];
  cells: GridCell[];
  summary: GridSummary[];
  /** 每项（列）的全班统计（竖排视图用） */
  columnStats: GridColumnStat[];
  /** 学生 × 考核类型 的原始分合计（各视图的「小计」） */
  typeTotals: GridTypeTotal[];
  /** 学生 × 学科 的加权均分与等级（学科视图用） */
  subjectSummaries: GridSubjectSummary[];
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
   * 成绩等级候选（「学生成绩目标」页选「目标等级序号」用）。
   *
   * 🔴 为什么必须有这个端点（2026-09-20 实测）：那个字段原来是**自由数字输入**，
   * 而「目标等级序号」必须**恰好等于某个等级的序号**才有意义 ——
   * 达标判定是 `实际等级序号 ≤ 目标等级序号`，序号不在等级体系里 ⇒ 永远判不出达标；
   * 等级名也反查不出来（成绩册于是显示成一个光秃秃的序号）。
   *
   * 生产实测踩的就是这个：本校「致极等第体系-2026」的序号是 **10 / 15 / 20 / 25 / 27 / 30 /
   * 35 / 40 / 50 / 60**（A 最好 = 10，**没有序号 1**），而两条目标记录都填了 `1`
   * ⇒ 显示不出等级名，而且对任何成绩都判「未达标」（含全 A 的学生）。
   *
   * 所以候选项只能来自**成绩等级表**（真业务配置，与网格取等级名用的是同一份数据）。
   * 值给序号（后端按数字存），label 带上显示值，例如 `A（序号 10）`。
   * ⚠️ 按序号去重：多个等级体系可能有相同序号（各自的 A/B/C），此时 label 里附体系名，
   *    取排序后的第一个；生产目前只有一个体系，不受影响。
   */
  async listLevelOptions(): Promise<{ items: { value: string; label: string }[] }> {
    try {
      const cfg = await this.configsOf('');
      const scaleName = new Map(cfg.scaleList.map((s) => [s.id, s.name]));
      const multi = new Set(cfg.levelList.map((l) => l.scaleId)).size > 1;
      // 拼选项的规则抽成纯函数（levelOptionItems）以便单测：值必须等于真实等级序号，
      // 否则那条目标永远判不出达标（见函数注释）
      return { items: levelOptionItems(cfg.levelList, (id) => scaleName.get(id) ?? '', multi) };
    } catch {
      // 表没建 / 读失败 → 空候选（页面据此退回数字输入，不至于建不了目标）
      return { items: [] };
    }
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
       * 已停用的**考核类型组** id 集合（2026-09-20）。
       *
       * 组的「状态 = 停用」⇒ 该组下所有类型**不许再选**：这是「考核类型组」存在的意义
       * ——换学期时整组停用，而不是逐个停用 7 个类型（逐个必然漏关）。
       *
       * ⚠️ 只影响**候选**，不影响已存量的计算：历史成绩册列照常按权重与颜色算，
       * 停用是「不许再选」，不是「历史作废」（否则一停用就把期末总评改了）。
       *
       * 读失败时**不做过滤**（`enabledGroups` 为 null）：宁可多给一个候选，
       * 也不能因为一张配置表读不到就让老师建不了列（空下拉比多一个选项糟得多）。
       */
      let stoppedGroups: Set<string> | null = null;
      try {
        const groupRows = await this.readAll(TABLES.examTypeGroup.tableId);
        stoppedGroups = new Set(
          groupRows.filter((g) => String(g.f['状态'] ?? '启用') === '停用').map((g) => g.id),
        );
      } catch {
        stoppedGroups = null;
      }
      /** 该类型所属组里有没有被停用的（类型本身没组 ⇒ 不过滤，宽容处理） */
      const inStoppedGroup = (f: Record<string, any>): boolean => {
        if (!stoppedGroups || !stoppedGroups.size) return false;
        const ids = this.linkIds(f['所属考核类型组']);
        return ids.some((id) => stoppedGroups!.has(id));
      };

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
        // 整组停用的类型不进候选（上面 stoppedGroups 的注释：停用 = 不许再选）
        .filter((r) => !inStoppedGroup(r.f))
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
      year: String(f['学年'] ?? '').trim(),
      term: String(f['学期'] ?? '').trim(),
      unassigned: isUnassignedTerm({ year: String(f['学年'] ?? ''), term: String(f['学期'] ?? '') }),
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
  /**
   * 班级成绩册网格。
   *
   * `year` / `term` = 页面上的「学年 / 学期」筛选（读字典）；不传 = 不限（老行为）。
   * 🔴 过滤规则见纯函数 `columnInTerm`：**未归属的历史列在任何筛选下都保留** ——
   *    否则一加筛选老数据就"消失"，而且期末结转会跟着少算（静默、且难查）。
   */
  async getGrid(cls: string, year = '', term = ''): Promise<MarkbookGrid> {
    const c = normClass(cls);
    const empty: MarkbookGrid = {
      cls: c,
      columns: [],
      students: [],
      cells: [],
      summary: [],
      columnStats: [],
      typeTotals: [],
      subjectSummaries: [],
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

    const sel = { year, term };
    const columns = allColumns
      .filter((x) => normClass(x.f['班级']) === c && String(x.f['状态'] ?? '启用') !== '停用')
      .map((x) => this.columnOf(x.id, x.f, typeIdx))
      // 学年/学期筛选（未归属的列由 columnInTerm 兜底留下）
      .filter((col) => columnInTerm(col, sel))
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
    //
    // 🔴 「目标等级」名可能**根本没有写过**（2026-09-20 实测）：「学生成绩目标」页的表单
    // 只有「目标分 + 目标等级序号」两个值，`目标等级` 是一个**没有录入入口**的字段 ⇒
    // 生产上 2 条目标记录里 `目标等级` 都不存在（只有 序号=1 / 目标分=95|99）。
    // 而成绩册网格原来**只认这个名字**（前端 `sum.targetLevel ? … : 未设置`）⇒
    // 老师明明设了目标，网格却显示「未设置」（而且「达标」其实算得出来，等于白算）。
    // 所以这里把「等级名」降级为可推导：有名字用名字，没名字就按序号在学生实际用的等级体系里反查。
    const targets = new Map<string, { level: string; order: number | null; score: number | null }>();
    for (const t of targetRows) {
      if (normClass(t.f['班级']) !== c) continue;
      const sid = this.linkIds(t.f['学生'])[0] ?? '';
      if (!sid) continue;
      const order = Number(t.f['目标等级序号']);
      const score = Number(t.f['目标分']);
      targets.set(sid, {
        level: String(t.f['目标等级'] ?? ''),
        order: Number.isFinite(order) && t.f['目标等级序号'] !== '' ? order : null,
        score: Number.isFinite(score) && t.f['目标分'] !== '' && t.f['目标分'] != null ? score : null,
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
    /**
     * 展示用的两组中间结果（2026-09-20 四种视图共用）：
     *  - `bySubject`：学生 × 学科 → 归一化得分与权重（算学科加权均分）
     *  - `byType`：学生 × 考核类型 → **原始分**（算类型小计）
     * 两者都只收「能解析成数字」的格子（`modelOf` 已把等级制/免考挡在外面），
     * 与总评「留空 ≠ 0」同一条原则。
     */
    const bySubject = new Map<string, Map<string, { score: number; weight: number }[]>>();
    const byType = new Map<string, Map<string, (number | null)[]>>();
    const subjectSummaries: GridSubjectSummary[] = [];
    const typeTotals: GridTypeTotal[] = [];
    const summary: GridSummary[] = students.map((s) => {
      const items: { score: number; weight: number }[] = [];
      const subjBucket = new Map<string, { score: number; weight: number }[]>();
      const typeBucket = new Map<string, (number | null)[]>();
      for (const col of columns) {
        const cell = cellMap.get(`${col.id}__${s.id}`);
        if (!cell || cell.score == null) continue;
        const w = effectiveWeight(col.weight, tw.get(col.type) ?? 1);
        items.push({
          score: normScore(cell.score, col.fullMark),
          // 两层权重：列权重 × 类型权重
          weight: w,
        });
        const sj = col.subject || '';
        const sb = subjBucket.get(sj) ?? [];
        sb.push({ score: normScore(cell.score, col.fullMark), weight: w });
        subjBucket.set(sj, sb);
        const tk = col.type || '';
        const tb = typeBucket.get(tk) ?? [];
        tb.push(cell.score);
        typeBucket.set(tk, tb);
      }
      bySubject.set(s.id, subjBucket);
      byType.set(s.id, typeBucket);
      const agg = weightedTotal(items);
      // 该生用哪套等级：优先列上指定的体系，否则默认体系
      const scaleIds = new Set(columns.map((x) => x.scaleId).filter(Boolean));
      const useScale = scaleIds.size === 1 ? [...scaleIds][0] : scaleIds.size > 1 ? '' : cfg.defaultScaleId;
      const levels = useScale ? cfg.levelList.filter((l) => l.scaleId === useScale) : cfg.levelList;
      const lv = pickLevel(levels, agg.total);
      const tgt = targets.get(s.id) ?? { level: '', order: null, score: null };
      // 目标等级名：记录上有就用；没有就按序号在**该生实际用的那套等级体系**里反查
      // （用同一个 levels，才不会出现「网格显示的等级来自 A 体系、目标名来自 B 体系」）
      const tgtLabel = targetLabelOf(tgt.level, tgt.order, levels);
      /**
       * 目标序号是否**真的存在于**该生的等级体系里。
       *
       * 🔴 生产实测（2026-09-20）：本校等级体系的序号是 10 / 15 / 20 / 25 / 27 / 30 / 35 / 40 / 50 / 60
       * （A 最好 = 10，**没有 1**），而两条目标记录都填了 `1` ⇒ 判定 `实际序号 ≤ 1` 对任何成绩都是假，
       * **永远「未达标」**（哪怕全 A），而且等级名也反查不出来。
       * 这种「数据非法但一切正常返回」的情况必须显式标出来，否则老师只会觉得系统算错了。
       */
      const tgtOrderKnown =
        tgt.order == null || levels.some((x) => Number(x.order) === Number(tgt.order));

      // 展示用聚合（口径与总评同源：同一个 levels、同一个 weightedTotal）
      for (const [subject, arr] of subjBucket) {
        const aggS = weightedTotal(arr);
        const lvS = pickLevel(levels, aggS.total);
        subjectSummaries.push({
          studentId: s.id,
          subject,
          weighted: aggS.total,
          count: aggS.count,
          level: lvS ? lvS.label : '',
        });
      }
      for (const [type, arr] of typeBucket) {
        const { sum, count } = sumOfScores(arr);
        typeTotals.push({ studentId: s.id, type, sum, count });
      }
      return {
        studentId: s.id,
        total: agg.total,
        level: lv ? lv.label : '',
        levelOrder: lv ? lv.order : null,
        concern: lv ? lv.concern : false,
        targetLevel: tgtLabel,
        targetOrder: tgt.order,
        targetOrderKnown: tgtOrderKnown,
        targetScore: tgt.score,
        attained: tgt.order == null || !lv ? null : lv.order <= tgt.order,
        filled: agg.count,
        weightSum: agg.weightSum,
      };
    });

    /**
     * 每项（列）的全班统计 —— 「竖排」视图行尾的均分/最高/最低。
     * 只统计能解析成数字的格子（见 `statsOfScores`），所以等级制的列会得到 count=0、均分显示「—」。
     */
    const columnStats: GridColumnStat[] = columns.map((col) => ({
      columnId: col.id,
      ...statsOfScores(students.map((st) => cellMap.get(`${col.id}__${st.id}`)?.score ?? null)),
    }));

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
      columnStats,
      typeTotals,
      subjectSummaries,
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
    /** 学年 / 学期（读字典；空 = 未归属） */
    year?: string;
    term?: string;
    /** 多科目一次性建列（勾 N 个 = 建 N 列）；只在新建时用 */
    subjects?: string[];
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
  }): Promise<{ id: string; ids: string[]; created: number }> {
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
      // 编辑：只动传进来的字段（未传的不覆盖，见 buildColumnFields 的注释）
      await sql.update(TABLES.markbookColumn.tableId, payload.id, fields);
      return { id: payload.id, ids: [payload.id], created: 0 };
    }

    /**
     * 新建：`subjects`（多科目）时**展开成 N 列**，每列一个科目。
     *
     * 🔴 为什么不是「一列挂多个科目」：期末总评的幂等键是「批次 + 学生 + 科目」，
     * 一列挂两个科目 ⇒ 结转时拆不出科目、权重也没法按科目区分（而且不报错）。
     * 展开规则（去重、≥2 才加 `名 · 科目` 后缀、排序连号保证相邻）全在
     * `subjectColumnDrafts` 纯函数里，有单测。
     *
     * 串行 create：同一张表并发写容易出现读-改-写互相覆盖。
     */
    if (Array.isArray(payload.subjects) && payload.subjects.length) {
      const drafts = subjectColumnDrafts({
        name: payload.name,
        subjects: payload.subjects,
        sort: payload.sort,
      });
      const ids: string[] = [];
      for (const d of drafts) {
        const f = buildColumnFields({ ...payload, name: d.name, subject: d.subject, sort: d.sort });
        ids.push(String(await sql.create(TABLES.markbookColumn.tableId, f)));
      }
      return { id: ids[0] ?? '', ids, created: ids.length };
    }

    const id = await sql.create(TABLES.markbookColumn.tableId, fields);
    return { id: String(id), ids: [String(id)], created: 1 };
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
