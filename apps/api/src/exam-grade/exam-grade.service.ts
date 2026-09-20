import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { TABLES } from '@acms/contracts';
import { BaseClient, toText } from '@acms/base-adapter';
import { getSqlStore, BASE_CLIENT } from '../base.provider.js';
import { MarkbookService } from '../markbook/markbook.service.js';
import { effectiveWeight, type LevelDef } from '../markbook/markbook.logic.js';
import {
  ABSENT_MODES,
  DEFAULT_ANOMALY_THRESHOLDS,
  EXCUSED_MODES,
  ROUND_MODES,
  computeGpa,
  computeTermGrade,
  detectAnomalies,
  pickMode,
  rankTermGrades,
  termGradeKey,
  type AbsentMode,
  type AnomalyHit,
  type AnomalyThresholds,
  type CellStatus,
  type ExcusedMode,
  type RoundMode,
  type TermGradeItem,
} from './exam-grade.logic.js';

/**
 * 考试与成绩 —— 建表 / 结转 / 评语 / 成绩单 / 异常审查。
 *
 * 定位（与成绩册的分工）：
 *   成绩册（MarkbookService）= **过程录入**：一次考核一列，二维网格，两层权重，等级快照
 *   本服务                  = **结果产出**：把成绩册「结转」成期末总评快照 → 成绩单 → PDF
 *
 * 计算一律复用 `exam-grade.logic.ts` 的纯函数（那个文件又复用 markbook.logic 的
 * safeWeight / normScore / weightedTotal / pickLevel / isAttained）。**本文件不自己算口径**。
 *
 * ⚠️ 必须登记字段元数据（`ensureTable` 的第三个参数）：
 *    `SqlStore.normalize()` 靠它做读取还原 —— 没有元数据时日期读出毫秒时间戳。
 *    markbook 早期传了空数组、自己手工转；新表统一走元数据，不重复这个坑。
 *
 * ⚠️ 通用 CRUD（`GenericCrudModule.registerAll`）只生成路由、**不建表**。
 *    建表只在这里，由 `ExamGradeModule.onModuleInit` 调用。
 *
 * 读取侧一律「全表拉 + 内存过滤」：ACMS 单校量级（学生 82、列几十、条目几千）完全撑得住，
 * 与 markbook.service 保持一致。
 *
 * 字段 type 取值（与飞书 Base 对齐，取自生产 `acms_fields` 实测）：
 *    1 文本 / 2 数字 / 3 单选 / 4 多选 / 5 日期 / 7 复选框 / 11 人员 / 18 关联
 */

const T = { TEXT: 1, NUMBER: 2, SELECT: 3, DATE: 5, USER: 11, LINK: 18 } as const;

/** 存量考核类型回填用的默认组名（页面上可改名 / 停用，不写死） */
const DEFAULT_EXAM_TYPE_GROUP = '默认分组';
type FieldDef = { name: string; type: number; property?: unknown };
const sel = (...names: string[]): FieldDef['property'] => ({ options: names.map((name) => ({ name })) });

/** 科目筛选里表示「未填科目」的那一组（成绩册列的「科目」为空） */
export const SUBJECT_NONE = '__none__';

/** 成绩口径设置的配置键（存在通用系统配置表里，与登录页配置同一套机制） */
const EXAM_SETTINGS_KEY = 'exam_grade_settings';

/**
 * 全局成绩口径。定位：**批次上的同名字段优先，这里只是缺省值**。
 * 这样不用改批次表的历史数据，也能让新批次默认带上统一口径。
 */
export interface ExamGradeSettings {
  /** 总评舍入方式（batch.舍入口径 为空时用它） */
  roundMode: RoundMode;
  /** 免考处理（batch.免考处理 为空时用它） */
  excusedMode: ExcusedMode;
  /** 缺考处理（batch.缺考处理 为空时用它） */
  absentMode: AbsentMode;
  /** GPA 显示小数位（0–3） */
  gpaDecimals: number;
  /** 异常审查：离群高倍（≥ 班级均值 × 该值判离群高） */
  highFactor: number;
  /** 异常审查：离群低倍 */
  lowFactor: number;
  /** 异常审查：突变分差 */
  swingScore: number;
}

export const DEFAULT_EXAM_SETTINGS: ExamGradeSettings = {
  roundMode: '保留1位小数',
  excusedMode: '不计入分母',
  absentMode: '计0分',
  gpaDecimals: 2,
  highFactor: DEFAULT_ANOMALY_THRESHOLDS.highFactor,
  lowFactor: DEFAULT_ANOMALY_THRESHOLDS.lowFactor,
  swingScore: DEFAULT_ANOMALY_THRESHOLDS.swingScore,
};

/** 评语长度上限（成绩单是打印件，太长会排版崩；前端也按这个数提示） */
export const COMMENT_MAX = 200;

export interface TermGradeRow {
  studentId: string;
  studentName: string;
  cls: string;
  subject: string;
  total: number | null;
  level: string;
  levelOrder: number | null;
  concern: boolean;
  attained: string;
  count: number;
  weightSum: number;
  excusedCount: number;
  absentCount: number;
  weightedGpa: number | null;
  unweightedGpa: number | null;
  rank: number | null;
  rankTotal: number;
  status: '草稿' | '已确认' | '未结转' | '已发布';
  source: '自动结转' | '手工调整';
  comment: string;
  commentStatus: string;
  teacher: string;
  detail: string;
  /** 已存在的期末总评记录 id（空 = 还没结转） */
  recordId: string;
  /** 相对已有记录的变化 */
  action: '新建' | '更新' | '无变化' | '跳过（已确认）';
  oldTotal: number | null;
}

export interface TermGradePreview {
  batchId: string;
  batchName: string;
  batchStatus: string;
  cls: string;
  subject: string;
  subjects: { value: string; label: string; columns: number }[];
  columns: { id: string; name: string; type: string; subject: string; weight: number; fullMark: number }[];
  rows: TermGradeRow[];
  summary: { create: number; update: number; unchanged: number; skipped: number; total: number };
  /** GPA 前置条件：等级表一个绩点都没配时为 false，前端要明说「未配置绩点」 */
  gpaConfigured: boolean;
  /** 为什么没有可结转的列（前端直接展示，别让人猜） */
  reason?: string;
}

export interface AnomalyRow extends AnomalyHit {
  columnName: string;
  columnType: string;
  studentId: string;
  studentName: string;
  score: number | null;
  fullMark: number;
  classAvg: number | null;
}

/** 成绩单数据结构（**屏幕预览与 PDF 共用**） */
export interface ReportCardData {
  batchId: string;
  batchName: string;
  batchStatus: string;
  year: string;
  term: string;
  studentId: string;
  studentName: string;
  studentNo: string;
  cls: string;
  grade: string;
  subjects: {
    subject: string;
    total: number | null;
    level: string;
    rank: number | null;
    rankTotal: number;
    attained: string;
    comment: string;
    teacher: string;
    status: string;
  }[];
  gpa: { weighted: number | null; unweighted: number | null };
  rank: number | null;
  rankTotal: number;
  attainedCount: number;
  summaryComment: string;
  summaryStatus: string;
  confirmedAt: string;
}

@Injectable()
export class ExamGradeService implements OnModuleInit {
  private readonly logger = new Logger('ExamGrade');

  constructor(
    private readonly markbook: MarkbookService,
    /**
     * 口径设置（2026-09-16 Phase 2）存在**通用系统配置表**里（键 = exam_grade_settings），
     * 与登录页配置同一套机制 —— 不为此新建一张表。
     */
    @Inject(BASE_CLIENT) private readonly base: BaseClient,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.ensureTables();
  }

  // ────────────────────────────────────────────────────────────
  // 建表
  // ────────────────────────────────────────────────────────────

  /** 幂等建表（4 张：考核类型 / 成绩批次 / 期末总评 / 成绩单） */
  async ensureTables(): Promise<void> {
    const sql = getSqlStore();
    if (!sql) {
      this.logger.warn('[exam-grade] 未配置 DATABASE_URL，跳过建表（考试与成绩不可用）');
      return;
    }

    // ── 0. 考核类型组表（2026-09-20 新增）─────────────────────────────
    // 考核类型的容器：整组开关（换学期时一个开关搞定，不用逐个停用 7 个类型）。
    // 与「成绩等级体系 → 成绩等级」同一套两级结构，页面也是左组右类型。
    await sql.ensureTable(TABLES.examTypeGroup.tableId, '考核类型组表', [
      { name: '组名称', type: T.TEXT },
      { name: '状态', type: T.SELECT, property: sel('启用', '停用') },
      { name: '排序', type: T.NUMBER, property: { formatter: '0' } },
      { name: '说明', type: T.TEXT },
    ]);

    // ── 1. 考核类型表 ─────────────────────────────────────────────
    await sql.ensureTable(TABLES.examType.tableId, '考核类型表', [
      { name: '类型名称', type: T.TEXT },
      { name: '英文名', type: T.TEXT },
      { name: '颜色', type: T.TEXT },
      { name: '缺省权重', type: T.NUMBER, property: { formatter: '0.##' } },
      { name: '计入总评', type: T.SELECT, property: sel('是', '否') },
      { name: '排序', type: T.NUMBER, property: { formatter: '0' } },
      { name: '状态', type: T.SELECT, property: sel('启用', '停用') },
      { name: '说明', type: T.TEXT },
      // 所属考核类型组（2026-09-20）：类型必须挂在某个组下 ——
      // 没有组就无处开关，页面右侧也筛不到它（看起来像「类型丢了」）
      { name: '所属考核类型组', type: T.LINK },
    ]);

    // 存量类型迁进一个默认组：此前 7 条类型没有组字段，
    // 不迁的话它们在「按组筛选」的页面里会**一条都看不到**（像是被删了）。
    await this.backfillExamTypeGroup();

    // ── 2. 成绩批次表 ─────────────────────────────────────────────
    await sql.ensureTable(TABLES.gradeBatch.tableId, '成绩批次表', [
      { name: '批次名称', type: T.TEXT },
      { name: '学年', type: T.TEXT },
      { name: '学期', type: T.SELECT, property: sel('第一学期', '第二学期', '全学年') },
      { name: '起日期', type: T.DATE, property: { date_formatter: 'yyyy/MM/dd' } },
      { name: '止日期', type: T.DATE, property: { date_formatter: 'yyyy/MM/dd' } },
      { name: '等级体系', type: T.LINK },
      { name: '舍入口径', type: T.SELECT, property: sel(...ROUND_MODES) },
      { name: '免考处理', type: T.SELECT, property: sel(...EXCUSED_MODES) },
      { name: '缺考处理', type: T.SELECT, property: sel(...ABSENT_MODES) },
      { name: '状态', type: T.SELECT, property: sel('草稿', '已发布') },
      { name: '异常阈值高倍', type: T.NUMBER, property: { formatter: '0.0' } },
      { name: '异常阈值低倍', type: T.NUMBER, property: { formatter: '0.0' } },
      { name: '异常突变分差', type: T.NUMBER, property: { formatter: '0' } },
      { name: '备注', type: T.TEXT },
    ]);

    // ── 3. 期末总评表 ─────────────────────────────────────────────
    await sql.ensureTable(TABLES.termGrade.tableId, '期末总评表', [
      { name: '批次', type: T.LINK },
      { name: '学生', type: T.LINK },
      { name: '学生姓名', type: T.TEXT },
      { name: '学号', type: T.TEXT },
      { name: '年级', type: T.TEXT },
      { name: '班级', type: T.TEXT },
      // 科目：成绩册列上的科目文本快照（与「班级」同一套口径），便于筛选与导出
      { name: '科目', type: T.TEXT },
      { name: '总评', type: T.NUMBER, property: { formatter: '0.##' } },
      { name: '等级', type: T.TEXT },
      { name: '等级序号', type: T.NUMBER },
      { name: '是否达标', type: T.SELECT, property: sel('达标', '未达标', '未设目标') },
      { name: '参与项数', type: T.NUMBER },
      { name: '权重和', type: T.NUMBER },
      { name: '含免考数', type: T.NUMBER },
      { name: '含缺考数', type: T.NUMBER },
      { name: '加权GPA', type: T.NUMBER, property: { formatter: '0.00' } },
      { name: '不加权GPA', type: T.NUMBER, property: { formatter: '0.00' } },
      { name: '班级排名', type: T.NUMBER },
      { name: '排名总人数', type: T.NUMBER },
      // 逐项计算明细（JSON 字符串）：点「查看明细」直接读、不重算，
      // 口径改了以后老记录仍然自洽
      { name: '计算明细', type: T.TEXT },
      { name: '状态', type: T.SELECT, property: sel('草稿', '已确认') },
      { name: '来源', type: T.SELECT, property: sel('自动结转', '手工调整') },
      { name: '手工调整分', type: T.NUMBER, property: { formatter: '0.##' } },
      { name: '教师评语', type: T.TEXT },
      { name: '评语状态', type: T.SELECT, property: sel('未写', '已写', '已定稿') },
      { name: '任课教师', type: T.USER },
      { name: '确认人', type: T.TEXT },
      { name: '确认时间', type: T.DATE, property: { date_formatter: 'yyyy/MM/dd HH:mm' } },
      { name: '结转人', type: T.TEXT },
      { name: '结转时间', type: T.DATE, property: { date_formatter: 'yyyy/MM/dd HH:mm' } },
      { name: '调整原因', type: T.TEXT },
    ]);

    // ── 4. 成绩单表 ───────────────────────────────────────────────
    await sql.ensureTable(TABLES.reportCard.tableId, '成绩单表', [
      { name: '批次', type: T.LINK },
      { name: '学生', type: T.LINK },
      { name: '学生姓名', type: T.TEXT },
      { name: '年级', type: T.TEXT },
      { name: '班级', type: T.TEXT },
      { name: '班主任总评语', type: T.TEXT },
      { name: '评语状态', type: T.SELECT, property: sel('未写', '已写', '已定稿') },
      { name: '生成时间', type: T.DATE, property: { date_formatter: 'yyyy/MM/dd HH:mm' } },
      { name: '生成人', type: T.TEXT },
      { name: '导出次数', type: T.NUMBER, property: { formatter: '0' } },
      { name: '备注', type: T.TEXT },
    ]);

    // ── 5. 常用评语库表（2026-09-16 Phase 2）──────────────────────
    // 配置表归「使用它的模块」负责建（通用 CRUD 只生成路由、不建表）
    await sql.ensureTable(TABLES.examComment.tableId, '常用评语库表', [
      { name: '评语内容', type: T.TEXT },
      // 科目留空 = 通用（任何科目都能套）；填了就只在该科目的评语页出现
      { name: '科目', type: T.TEXT },
      { name: '标签', type: T.SELECT, property: sel('鼓励', '进步', '提醒', '待改进', '通用') },
      { name: '排序', type: T.NUMBER, property: { formatter: '0' } },
      { name: '状态', type: T.SELECT, property: sel('启用', '停用') },
      { name: '使用次数', type: T.NUMBER, property: { formatter: '0' } },
      { name: '备注', type: T.TEXT },
    ]);

    this.logger.log('[exam-grade] 已就绪 5 张表（考核类型 / 成绩批次 / 期末总评 / 成绩单 / 常用评语库）');
  }

  // ────────────────────────────────────────────────────────────
  // 通用读取
  // ────────────────────────────────────────────────────────────

  /**
   * 全表读取（分页拉完）。
   *
   * 与 markbook.service 一样走「全表拉 + 内存过滤」——ACMS 单校量级（条目几千）撑得住，
   * 换来的是不用手写 jsonb SQL。这里多一个分页循环：`search` 单次有上限，
   * 期末总评会逐年累积（学生 × 批次 × 科目），不能只拉一页就当全量。
   */
  private async readAll(tableId: string): Promise<{ id: string; f: Record<string, any> }[]> {
    const sql = getSqlStore();
    if (!sql) return [];
    const out: { id: string; f: Record<string, any> }[] = [];
    const PAGE = 1000;
    let token: string | undefined;
    for (let i = 0; i < 50; i++) {
      const res = (await sql.search(tableId, { pageSize: PAGE, pageToken: token })) as unknown as {
        items?: unknown[];
        pageToken?: string | null;
      };
      const items = res?.items ?? [];
      for (const r of items) {
        const x = r as unknown as { recordId?: string; id?: string; fields?: Record<string, any> };
        out.push({ id: String(x.recordId ?? x.id ?? ''), f: (x.fields || {}) as Record<string, any> });
      }
      token = res?.pageToken ?? undefined;
      // 没有下一页游标，或这一页没满 → 拉完了
      if (!token || items.length < PAGE) break;
    }
    return out;
  }

  /**
   * 存量考核类型迁进一个默认组（2026-09-20 新增，幂等）。
   *
   * 为什么必须有这一步：「考核类型」原本没有「所属考核类型组」字段，
   * 而页面右侧是按组筛的 —— 不迁的话，那 7 条已有类型在页面上**一条都看不到**
   * （像是被删了，实际还在、成绩册也还在用）。
   *
   * 幂等：只在「确实存在无组的类型」时才动；默认组按名称找，没有才建。
   * 不删任何数据、不改既有字段（只补一个空的关联字段）。
   */
  private async backfillExamTypeGroup(): Promise<void> {
    try {
      const sql = getSqlStore();
      if (!sql) return;
      const types = await this.readAll(TABLES.examType.tableId);
      const orphan = types.filter((t) => !this.linkIds(t.f['所属考核类型组']).length);
      if (!orphan.length) return;

      const groups = await this.readAll(TABLES.examTypeGroup.tableId);
      let gid = groups.find((g) => String(g.f['组名称'] ?? '').trim() === DEFAULT_EXAM_TYPE_GROUP)?.id ?? '';
      if (!gid) {
        gid = await sql.create(TABLES.examTypeGroup.tableId, {
          组名称: DEFAULT_EXAM_TYPE_GROUP,
          状态: '启用',
          排序: 1,
          说明: '系统自动创建：历史考核类型默认归入此组（可改名 / 停用）',
        });
      }
      // LINK 字段在 jsonb 里存 id 数组（与通用 CRUD 写入口径一致，见 generic-crud 的 linkFields 归一）
      for (const t of orphan) await sql.update(TABLES.examType.tableId, t.id, { 所属考核类型组: [gid] });
      this.logger.log(`[exam-grade] 考核类型组回填：${orphan.length} 条无组类型 → ${DEFAULT_EXAM_TYPE_GROUP}`);
    } catch (e) {
      // 回填失败**不阻塞启动**：只是老类型在页面里可能筛不到，接口与计算不受影响
      this.logger.warn(`[exam-grade] 考核类型组回填失败（不影响功能）：${String(e)}`);
    }
  }

  private linkIds(v: unknown): string[] {
    if (v == null || v === '') return [];
    if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean);
    return [String(v)];
  }

  /** 考核类型索引：名称 → 颜色 / 缺省权重 / 是否计入总评 */
  private async examTypeIndex(): Promise<Map<string, { color: string; weight: number | null; counted: boolean }>> {
    const out = new Map<string, { color: string; weight: number | null; counted: boolean }>();
    for (const r of await this.readAll(TABLES.examType.tableId)) {
      const name = String(r.f['类型名称'] ?? '').trim();
      if (!name) continue;
      const w = Number(r.f['缺省权重']);
      out.set(name, {
        color: String(r.f['颜色'] ?? '').trim(),
        weight: Number.isFinite(w) && w > 0 ? w : null,
        counted: String(r.f['计入总评'] ?? '是') !== '否',
      });
    }
    return out;
  }

  /** 等级 id → 绩点 / 是否计入 GPA（GPA 的唯一数据来源；没配就是没配，不猜） */
  private async levelPoints(): Promise<Map<string, { points: number | null; counted: boolean }>> {
    const out = new Map<string, { points: number | null; counted: boolean }>();
    for (const r of await this.readAll(TABLES.gradeScaleLevel.tableId)) {
      const raw = r.f['绩点'];
      const n = Number(raw);
      out.set(r.id, {
        points: raw === '' || raw == null || !Number.isFinite(n) ? null : n,
        counted: String(r.f['是否计入GPA'] ?? '是') !== '否',
      });
    }
    return out;
  }

  private async batchOf(batchId: string): Promise<{ id: string; f: Record<string, any> } | null> {
    const all = await this.readAll(TABLES.gradeBatch.tableId);
    return all.find((x) => x.id === batchId) ?? null;
  }

  /** 批次列表（给下拉用） */
  async listBatches(): Promise<
    { id: string; name: string; status: string; year: string; term: string; from: string; to: string }[]
  > {
    const all = await this.readAll(TABLES.gradeBatch.tableId);
    return all
      .map((x) => ({
        id: x.id,
        name: String(x.f['批次名称'] ?? '未命名批次'),
        status: String(x.f['状态'] ?? '草稿'),
        year: String(x.f['学年'] ?? ''),
        term: String(x.f['学期'] ?? ''),
        from: String(x.f['起日期'] ?? '').slice(0, 10),
        to: String(x.f['止日期'] ?? '').slice(0, 10),
      }))
      .sort((a, b) => b.name.localeCompare(a.name, 'zh-CN'));
  }

  /**
   * 可用科目。
   *
   * 🔴 取自该班成绩册列上「科目」的**实际去重值** —— **不读字典**。
   *    ACMS 的字典与实际数据常年不符（校区、年级都踩过），
   *    读字典会出现「选了筛出 0 条」。
   */
  async subjectOptions(cls: string): Promise<{ value: string; label: string; columns: number }[]> {
    const grid = await this.markbook.getGrid(cls);
    const m = new Map<string, number>();
    for (const c of grid.columns) {
      if (c.status === '停用') continue;
      const s = c.subject || SUBJECT_NONE;
      m.set(s, (m.get(s) ?? 0) + 1);
    }
    return [...m.entries()]
      .map(([value, columns]) => ({ value, label: value === SUBJECT_NONE ? '未填科目' : value, columns }))
      .sort((a, b) =>
        a.value === SUBJECT_NONE ? 1 : b.value === SUBJECT_NONE ? -1 : a.label.localeCompare(b.label, 'zh-CN'),
      );
  }

  // ────────────────────────────────────────────────────────────
  // 结转
  // ────────────────────────────────────────────────────────────

  /**
   * 结转的**唯一计算入口**。`preview` 与 `roll` 都走它 ——
   * 两套口径必然漂移（预览说涨 1.8、实际写进去涨 2.1），所以只允许有一份。
   */
  private async compute(batchId: string, cls: string, subjectFilter: string): Promise<TermGradePreview> {
    const batch = await this.batchOf(batchId);
    const empty: TermGradePreview = {
      batchId,
      batchName: batch ? String(batch.f['批次名称'] ?? '') : '',
      batchStatus: batch ? String(batch.f['状态'] ?? '草稿') : '',
      cls,
      subject: subjectFilter,
      subjects: [],
      columns: [],
      rows: [],
      summary: { create: 0, update: 0, unchanged: 0, skipped: 0, total: 0 },
      gpaConfigured: false,
    };
    if (!batch) return { ...empty, reason: '批次不存在' };
    if (!cls) return { ...empty, reason: '请先选择年级 / 班级' };

    const [grid, typeIdx, points, existing, subjects] = await Promise.all([
      this.markbook.getGrid(cls),
      this.examTypeIndex(),
      this.levelPoints(),
      this.readAll(TABLES.termGrade.tableId),
      this.subjectOptions(cls),
    ]);
    if (!grid.students.length) return { ...empty, subjects, reason: '该分组下暂无在读学生' };

    // 批次的日期区间：列的「考核日期」落在区间内才参与
    const from = String(batch.f['起日期'] ?? '').slice(0, 10);
    const to = String(batch.f['止日期'] ?? '').slice(0, 10);
    const inRange = (d: string): boolean => {
      const day = d.slice(0, 10);
      // 列没填日期 → 不因区间被排除（否则老数据全被漏掉）
      if (!day) return true;
      if (from && day < from) return false;
      if (to && day > to) return false;
      return true;
    };

    // 参与结转的列：启用 + 日期在区间内 + 类型「计入总评」+ 科目匹配
    const usable = grid.columns.filter((c) => {
      if (c.status === '停用') return false;
      if (!inRange(c.date)) return false;
      if (typeIdx.size && typeIdx.get(c.type)?.counted === false) return false;
      const s = c.subject || SUBJECT_NONE;
      if (subjectFilter && s !== subjectFilter) return false;
      return true;
    });

    if (!usable.length) {
      return {
        ...empty,
        subjects,
        reason:
          '该批次范围内没有可结转的考核列。检查三件事：列的「考核日期」是否落在批次区间内、' +
          '列的考核类型是否被设为「计入总评 = 否」、以及科目筛选是否把列都排除了。',
      };
    }

    const columnsDto = usable.map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      subject: c.subject,
      weight: effectiveWeight(c.weight, typeIdx.get(c.type)?.weight ?? 1),
      fullMark: c.fullMark,
    }));

    // 等级体系：批次指定了就用它，否则用成绩册里这批列共同的那套
    const batchScaleId = this.linkIds(batch.f['等级体系'])[0] ?? '';
    const scaleIds = new Set(usable.map((c) => c.scaleId).filter(Boolean));
    const useScale = batchScaleId || (scaleIds.size === 1 ? [...scaleIds][0] : '');
    const levels: LevelDef[] = useScale ? grid.levels.filter((l) => l.scaleId === useScale) : grid.levels;

    /**
     * 口径优先级：**批次字段 → 全局设置 → 代码缺省**（2026-09-16 Phase 2）。
     * 批次上留空即继承「成绩口径设置」页里配的全局值 —— 这样历史批次不用改数据，
     * 新建批次也能天然带上一套统一口径。
     */
    const settings = await this.getSettings();
    // 用 `pickMode` 归一：批次上存的档位若不是合法枚举（例如有人把字典里那个选项的文案改了），
    // 会造成 `excusedMode === '不计入分母'` 判假 ⇒ 免考反而被算进分母，且不报错。
    // 归一后未知值回落全局设置，至少不会算反。
    const excused = pickMode(batch.f['免考处理'], EXCUSED_MODES) || settings.excusedMode;
    const absent = pickMode(batch.f['缺考处理'], ABSENT_MODES) || settings.absentMode;
    const round = pickMode(batch.f['舍入口径'], ROUND_MODES) || settings.roundMode;

    const tw = new Map(grid.typeWeights.map((x) => [x.type, x.weight]));
    const cellMap = new Map(grid.cells.map((c) => [`${c.columnId}__${c.studentId}`, c]));

    // 学生 → 科目行
    const perStudent = new Map<string, TermGradeRow[]>();
    let gpaConfigured = false;

    for (const stu of grid.students) {
      // 先按科目把「项」分桶（科目 = 列上的科目，没填的归 SUBJECT_NONE）
      const buckets = new Map<string, TermGradeItem[]>();
      for (const col of usable) {
        const key = col.subject || SUBJECT_NONE;
        const cell = cellMap.get(`${col.id}__${stu.id}`);
        const item: TermGradeItem = {
          columnId: col.id,
          columnName: col.name,
          typeName: col.type,
          subject: col.subject,
          fullMark: col.fullMark,
          weight: effectiveWeight(col.weight, tw.get(col.type) ?? typeIdx.get(col.type)?.weight ?? 1),
          // 没条目 = 未录入（score null + 状态正常 ⇒ computeTermGrade 会跳过）
          score: cell && cell.score != null ? cell.score : null,
          status: (cell?.status as CellStatus) || '正常',
        };
        const arr = buckets.get(key);
        if (arr) arr.push(item);
        else buckets.set(key, [item]);
      }

      const rows: TermGradeRow[] = [];
      const targetOrder = grid.summary.find((x) => x.studentId === stu.id)?.targetOrder ?? null;
      for (const [key, items] of buckets) {
        const r = computeTermGrade(items, { levels, targetOrder, round, excused, absent });
        rows.push({
          studentId: stu.id,
          studentName: stu.name,
          cls,
          subject: key,
          total: r.total,
          level: r.level,
          levelOrder: r.levelOrder,
          concern: r.concern,
          attained: r.attained || '未设目标',
          count: r.count,
          weightSum: r.weightSum,
          excusedCount: r.excusedCount,
          absentCount: r.absentCount,
          weightedGpa: null,
          unweightedGpa: null,
          rank: null,
          rankTotal: 0,
          status: '未结转',
          source: '自动结转',
          comment: '',
          commentStatus: '未写',
          teacher: '',
          detail: JSON.stringify(r.details),
          recordId: '',
          action: '新建',
          oldTotal: null,
        });
      }
      perStudent.set(stu.id, rows);
    }

    // 排名：同批次 + 同科目 + 同班级内，竞赛排名法（只排有总评的）
    const allRowsFlat = [...perStudent.values()].flat();
    for (const subject of new Set(allRowsFlat.map((r) => r.subject))) {
      const group = allRowsFlat.filter((r) => r.subject === subject && r.total != null);
      const { ranks, total } = rankTermGrades(group.map((r) => ({ id: r.studentId, total: r.total })));
      for (const r of group) {
        r.rank = ranks.get(r.studentId) ?? null;
        r.rankTotal = total;
      }
    }

    // GPA：按科目算到学生级，再回填到该生每条科目行。
    // 一个绩点都没配时 hasAnyPoints=false → 前端明说「未配置绩点」，不显示 0.00。
    for (const rows of perStudent.values()) {
      const g = computeGpa(
        rows.map((r) => ({
          points: pointsByOrder(levels, r.levelOrder, points),
          weight: r.weightSum || 1,
          counted: true,
        })),
      );
      if (g.hasAnyPoints) gpaConfigured = true;
      for (const r of rows) {
        r.weightedGpa = g.weighted;
        r.unweightedGpa = g.unweighted;
      }
    }

    // 与已有记录比对，给出 action
    const idx = new Map(
      existing.map((e) => [
        termGradeKey(
          String(this.linkIds(e.f['批次'])[0] ?? ''),
          String(this.linkIds(e.f['学生'])[0] ?? ''),
          String(e.f['科目'] ?? ''),
        ),
        e,
      ]),
    );
    for (const r of allRowsFlat) {
      const storedSubject = r.subject === SUBJECT_NONE ? '' : r.subject;
      const hit = idx.get(termGradeKey(batchId, r.studentId, storedSubject));
      if (hit) {
        r.recordId = hit.id;
        const oldRaw = hit.f['总评'];
        r.oldTotal = oldRaw === '' || oldRaw == null ? null : Number(oldRaw);
        r.status = (String(hit.f['状态'] ?? '草稿') as TermGradeRow['status']) || '草稿';
        r.source = (String(hit.f['来源'] ?? '自动结转') as TermGradeRow['source']) || '自动结转';
        r.comment = String(hit.f['教师评语'] ?? '');
        r.commentStatus = String(hit.f['评语状态'] ?? '未写');
        r.teacher = String(hit.f['任课教师'] ?? '');
        if (r.status === '已确认') r.action = '跳过（已确认）';
        else if (r.oldTotal == null || r.total == null || Math.abs(r.oldTotal - r.total) > 0.001) r.action = '更新';
        else r.action = '无变化';
      } else {
        r.action = r.total == null ? '无变化' : '新建';
      }
    }

    allRowsFlat.sort(
      (a, b) =>
        a.subject.localeCompare(b.subject, 'zh-CN') ||
        (a.rank ?? 999) - (b.rank ?? 999) ||
        a.studentName.localeCompare(b.studentName, 'zh-CN'),
    );

    return {
      batchId,
      batchName: String(batch.f['批次名称'] ?? ''),
      batchStatus: String(batch.f['状态'] ?? '草稿'),
      cls,
      subject: subjectFilter,
      subjects,
      columns: columnsDto,
      rows: allRowsFlat,
      summary: {
        create: allRowsFlat.filter((r) => r.action === '新建').length,
        update: allRowsFlat.filter((r) => r.action === '更新').length,
        unchanged: allRowsFlat.filter((r) => r.action === '无变化').length,
        skipped: allRowsFlat.filter((r) => r.action === '跳过（已确认）').length,
        total: allRowsFlat.length,
      },
      gpaConfigured,
    };
  }

  /** 结转预览（**不落库**） */
  // ────────────────────────────────────────────────────────────
  // 成绩口径设置（Phase 2）
  // ────────────────────────────────────────────────────────────

  /**
   * 读全局成绩口径（存在系统配置表，键 = exam_grade_settings）。
   *
   * 定位：**批次上的同名字段优先，这里只是缺省值与全局开关**。
   * 这样既不用改批次表的历史数据，也能让「以后新建的批次」默认带上一套统一口径。
   */
  async getSettings(): Promise<ExamGradeSettings> {
    try {
      const res = await this.base.search(TABLES.systemConfig.tableId, {
        pageSize: 1,
        filter: { conjunction: 'and', conditions: [{ field: '配置键', value: [EXAM_SETTINGS_KEY] }] },
      });
      const raw = toText(res.items[0]?.fields?.['配置值']);
      if (!raw) return DEFAULT_EXAM_SETTINGS;
      const parsed = JSON.parse(raw) as Partial<ExamGradeSettings>;
      const merged = { ...DEFAULT_EXAM_SETTINGS, ...parsed };
      /**
       * 读取侧也归一（2026-09-20）：写入侧本来就有校验，但**手工改库 / 旧版本写进去的脏值**
       * 会在读取时原样带出，然后静默算反口径（例如免考被算进分母）。
       * 合法的照原样返回，所以现有配置不受影响。
       */
      return {
        ...merged,
        roundMode: pickMode(merged.roundMode, ROUND_MODES) || DEFAULT_EXAM_SETTINGS.roundMode,
        excusedMode: pickMode(merged.excusedMode, EXCUSED_MODES) || DEFAULT_EXAM_SETTINGS.excusedMode,
        absentMode: pickMode(merged.absentMode, ABSENT_MODES) || DEFAULT_EXAM_SETTINGS.absentMode,
      };
    } catch {
      // 读不到（表不可用 / JSON 坏了）就用默认值，绝不让设置页 500
      return DEFAULT_EXAM_SETTINGS;
    }
  }

  /** 保存全局成绩口径。非法枚举值一律回落到默认值（不报错，避免前端一个脏值卡死整页） */
  async saveSettings(dto: Partial<ExamGradeSettings>): Promise<ExamGradeSettings> {
    const cur = await this.getSettings();
    // 归一用共用的 `pickMode`（不合法 → 回落 fallback），别再写一份局部实现
    const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
      (pickMode(v, allowed) as T) || fallback;
    const numOr = (v: unknown, fallback: number): number => {
      const n = Number(v);
      return Number.isFinite(n) ? n : fallback;
    };
    const next: ExamGradeSettings = {
      roundMode: pick(dto.roundMode ?? cur.roundMode, ROUND_MODES, DEFAULT_EXAM_SETTINGS.roundMode),
      excusedMode: pick(dto.excusedMode ?? cur.excusedMode, EXCUSED_MODES, DEFAULT_EXAM_SETTINGS.excusedMode),
      absentMode: pick(dto.absentMode ?? cur.absentMode, ABSENT_MODES, DEFAULT_EXAM_SETTINGS.absentMode),
      gpaDecimals: Math.min(3, Math.max(0, Math.round(numOr(dto.gpaDecimals ?? cur.gpaDecimals, 2)))),
      highFactor: numOr(dto.highFactor ?? cur.highFactor, DEFAULT_EXAM_SETTINGS.highFactor),
      lowFactor: numOr(dto.lowFactor ?? cur.lowFactor, DEFAULT_EXAM_SETTINGS.lowFactor),
      swingScore: numOr(dto.swingScore ?? cur.swingScore, DEFAULT_EXAM_SETTINGS.swingScore),
    };

    const value = JSON.stringify(next);
    const res = await this.base.search(TABLES.systemConfig.tableId, {
      pageSize: 1,
      filter: { conjunction: 'and', conditions: [{ field: '配置键', value: [EXAM_SETTINGS_KEY] }] },
    });
    const hit = res.items[0] as { recordId?: string; id?: string } | undefined;
    if (hit) {
      await this.base.update(TABLES.systemConfig.tableId, String(hit.recordId ?? hit.id ?? ''), {
        配置值: value,
        状态: '启用',
      } as Record<string, unknown>);
    } else {
      await this.base.create(TABLES.systemConfig.tableId, {
        配置键: EXAM_SETTINGS_KEY,
        配置值: value,
        分组: '教学配置',
        说明: '成绩口径（舍入 / 免考 / 缺考 / 异常阈值 / GPA 小数位）',
        状态: '启用',
      } as Record<string, unknown>);
    }
    return next;
  }

  async preview(batchId: string, cls: string, subject = ''): Promise<TermGradePreview> {
    return this.compute(batchId, cls, subject);
  }

  /**
   * 一键结转（幂等 upsert）。
   *
   * 三条纪律：
   *   1. **已确认的不覆盖**（预览里已标出，这里再挡一次）
   *   2. **可重入**：幂等键 = 批次 + 学生 + 科目（`termGradeKey`），断网重跑不会产生重复记录
   *   3. 总评为 null 的不写（该生该科目一次考核都没有 → 不生成空壳记录）
   *   4. **不洗掉老师的评语**：已有记录只更新计算字段，评语/状态/来源原样保留
   */
  async roll(
    batchId: string,
    cls: string,
    subject: string,
    actor: string,
  ): Promise<{ saved: number; skipped: number }> {
    const sql = getSqlStore();
    if (!sql) throw new Error('未配置数据库');
    const p = await this.compute(batchId, cls, subject);
    const now = Date.now();
    const upserts: { id: string; fields: Record<string, unknown> }[] = [];
    let skipped = 0;

    for (const r of p.rows) {
      if (r.action === '跳过（已确认）' || r.action === '无变化' || r.total == null) {
        skipped++;
        continue;
      }
      const fields: Record<string, unknown> = {
        批次: batchId,
        学生: r.studentId,
        学生姓名: r.studentName,
        班级: r.cls,
        科目: r.subject === SUBJECT_NONE ? '' : r.subject,
        总评: r.total,
        等级: r.level,
        等级序号: r.levelOrder ?? '',
        是否达标: r.attained,
        参与项数: r.count,
        权重和: r.weightSum,
        含免考数: r.excusedCount,
        含缺考数: r.absentCount,
        加权GPA: r.weightedGpa ?? '',
        不加权GPA: r.unweightedGpa ?? '',
        班级排名: r.rank ?? '',
        排名总人数: r.rankTotal,
        计算明细: r.detail,
        结转人: actor,
        结转时间: now,
      };
      // 只有新记录才写默认值 —— 已有记录保留老师的评语与状态
      if (!r.recordId) {
        fields['状态'] = '草稿';
        fields['来源'] = '自动结转';
        fields['教师评语'] = '';
        fields['评语状态'] = '未写';
        fields['任课教师'] = '';
      }
      upserts.push({ id: r.recordId || `${batchId}__${r.studentId}__${r.subject}`, fields });
    }

    if (upserts.length) await sql.bulkInsert(TABLES.termGrade.tableId, upserts);
    return { saved: upserts.length, skipped };
  }

  /** 确认一条（锁定总评与评语） */
  async confirm(id: string, actor: string): Promise<{ ok: true }> {
    const sql = getSqlStore();
    if (!sql) throw new Error('未配置数据库');
    await sql.update(TABLES.termGrade.tableId, id, {
      状态: '已确认',
      确认人: actor,
      确认时间: Date.now(),
    });
    return { ok: true };
  }

  /** 撤销确认（需 approve 权限，controller 侧判） */
  async undo(id: string): Promise<{ ok: true }> {
    const sql = getSqlStore();
    if (!sql) throw new Error('未配置数据库');
    await sql.update(TABLES.termGrade.tableId, id, { 状态: '草稿', 确认人: '', 确认时间: '' });
    return { ok: true };
  }

  /** 批量确认（只动草稿） */
  async confirmAll(batchId: string, cls: string, subject: string, actor: string): Promise<{ confirmed: number }> {
    const sql = getSqlStore();
    if (!sql) throw new Error('未配置数据库');
    const p = await this.compute(batchId, cls, subject);
    const now = Date.now();
    let n = 0;
    for (const r of p.rows) {
      if (!r.recordId || r.status === '已确认' || r.total == null) continue;
      await sql.update(TABLES.termGrade.tableId, r.recordId, {
        状态: '已确认',
        确认人: actor,
        确认时间: now,
      });
      n++;
    }
    return { confirmed: n };
  }

  /**
   * 手工调分。
   * 把原自动值记进 `手工调整分`，便于追溯与「还原自动值」。
   */
  async adjust(id: string, total: number, reason: string): Promise<{ ok: true }> {
    const sql = getSqlStore();
    if (!sql) throw new Error('未配置数据库');
    const row = (await this.readAll(TABLES.termGrade.tableId)).find((x) => x.id === id);
    if (!row) throw new Error('记录不存在');
    if (String(row.f['状态'] ?? '') === '已确认') throw new Error('已确认的记录不能改分，请先撤销确认');
    if (!Number.isFinite(total) || total < 0 || total > 100) throw new Error('总评必须在 0–100 之间');
    const auto = Number(row.f['总评']);
    await sql.update(TABLES.termGrade.tableId, id, {
      总评: total,
      来源: '手工调整',
      手工调整分: Number.isFinite(auto) ? auto : '',
      调整原因: String(reason ?? '').slice(0, 200),
    });
    return { ok: true };
  }

  /** 还原自动值（把 `手工调整分` 写回总评） */
  async restore(id: string): Promise<{ ok: true }> {
    const sql = getSqlStore();
    if (!sql) throw new Error('未配置数据库');
    const row = (await this.readAll(TABLES.termGrade.tableId)).find((x) => x.id === id);
    if (!row) throw new Error('记录不存在');
    if (String(row.f['状态'] ?? '') === '已确认') throw new Error('已确认的记录不能改分，请先撤销确认');
    const auto = row.f['手工调整分'];
    if (auto === '' || auto == null) throw new Error('这条记录没有手工调整过');
    await sql.update(TABLES.termGrade.tableId, id, { 总评: Number(auto), 来源: '自动结转', 手工调整分: '', 调整原因: '' });
    return { ok: true };
  }

  // ────────────────────────────────────────────────────────────
  // 评语
  // ────────────────────────────────────────────────────────────

  /**
   * 批量保存评语（各科老师的主战场）。
   *
   * 入参是「记录 id → 评语」的数组：前端「失焦即存」每次只传当前那一条，
   * 但接口按批量设计，将来做「一键套用」不用改协议。
   *
   * ⚠️ 已确认的评语会被拒绝（`locked` 计数返回给前端提示）——
   *    与总评同一把锁：要改先撤销确认。
   */
  async saveComments(
    rows: { id: string; comment: string; status?: string }[],
  ): Promise<{ saved: number; locked: number }> {
    const sql = getSqlStore();
    if (!sql) throw new Error('未配置数据库');
    const byId = new Map((await this.readAll(TABLES.termGrade.tableId)).map((x) => [x.id, x]));
    let saved = 0;
    let locked = 0;
    for (const r of rows) {
      const cur = byId.get(r.id);
      if (!cur) continue;
      if (String(cur.f['状态'] ?? '') === '已确认') {
        locked++;
        continue;
      }
      const text = String(r.comment ?? '').slice(0, COMMENT_MAX);
      await sql.update(TABLES.termGrade.tableId, r.id, {
        教师评语: text,
        评语状态: r.status ?? (text ? '已写' : '未写'),
      });
      saved++;
    }
    return { saved, locked };
  }

  /** 期末总评列表（评语页 / 成绩单页用；可按批次 + 班级 + 科目 + 只看未写筛） */
  async listTermGrades(opts: {
    batchId: string;
    cls?: string;
    subject?: string;
    onlyMissingComment?: boolean;
  }): Promise<{
    rows: {
      id: string;
      studentId: string;
      studentName: string;
      cls: string;
      subject: string;
      total: number | null;
      level: string;
      rank: number | null;
      rankTotal: number;
      status: string;
      comment: string;
      commentStatus: string;
      excusedCount: number;
      absentCount: number;
    }[];
  }> {
    const all = await this.readAll(TABLES.termGrade.tableId);
    const wantSubject = opts.subject === SUBJECT_NONE ? '' : (opts.subject ?? '');
    const rows = all
      .filter((x) => String(this.linkIds(x.f['批次'])[0] ?? '') === opts.batchId)
      .filter((x) => !opts.cls || String(x.f['班级'] ?? '') === opts.cls)
      .filter((x) => !opts.subject || String(x.f['科目'] ?? '') === wantSubject)
      .map((x) => ({
        id: x.id,
        studentId: String(this.linkIds(x.f['学生'])[0] ?? ''),
        studentName: String(x.f['学生姓名'] ?? ''),
        cls: String(x.f['班级'] ?? ''),
        subject: String(x.f['科目'] ?? ''),
        total: x.f['总评'] === '' || x.f['总评'] == null ? null : Number(x.f['总评']),
        level: String(x.f['等级'] ?? ''),
        rank: x.f['班级排名'] === '' || x.f['班级排名'] == null ? null : Number(x.f['班级排名']),
        rankTotal: Number(x.f['排名总人数'] ?? 0) || 0,
        status: String(x.f['状态'] ?? '草稿'),
        comment: String(x.f['教师评语'] ?? ''),
        commentStatus: String(x.f['评语状态'] ?? '未写'),
        excusedCount: Number(x.f['含免考数'] ?? 0) || 0,
        absentCount: Number(x.f['含缺考数'] ?? 0) || 0,
      }))
      .filter((r) => !opts.onlyMissingComment || !r.comment.trim());
    rows.sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999) || a.studentName.localeCompare(b.studentName, 'zh-CN'));
    return { rows };
  }

  /** 班主任总评语（学生 × 批次，存在成绩单表） */
  async saveSummaryComment(
    batchId: string,
    studentId: string,
    comment: string,
    meta: { studentName: string; cls: string },
  ): Promise<{ ok: true }> {
    const sql = getSqlStore();
    if (!sql) throw new Error('未配置数据库');
    const hit = (await this.readAll(TABLES.reportCard.tableId)).find(
      (x) =>
        String(this.linkIds(x.f['批次'])[0] ?? '') === batchId &&
        String(this.linkIds(x.f['学生'])[0] ?? '') === studentId,
    );
    const text = String(comment ?? '').slice(0, 600);
    const fields = {
      批次: batchId,
      学生: studentId,
      学生姓名: meta.studentName,
      班级: meta.cls,
      班主任总评语: text,
      评语状态: text ? '已写' : '未写',
    };
    if (hit) await sql.update(TABLES.reportCard.tableId, hit.id, fields);
    else await sql.create(TABLES.reportCard.tableId, fields);
    return { ok: true };
  }

  // ────────────────────────────────────────────────────────────
  // 异常成绩审查
  // ────────────────────────────────────────────────────────────

  /**
   * 扫描异常成绩。
   *
   * ⚠️ **只提示，绝不自动改分** —— 成绩是给家长看的正式数据，
   *    误改的代价远大于漏改。复核动作由人来做。
   */
  async anomalies(
    batchId: string,
    cls: string,
  ): Promise<{ rows: AnomalyRow[]; thresholds: AnomalyThresholds; scanned: number }> {
    const batch = await this.batchOf(batchId);
    const settings = await this.getSettings();
    // 阈值同样三级回落：批次字段 → 全局设置 → 代码缺省
    const th: AnomalyThresholds = {
      highFactor: num(batch?.f['异常阈值高倍']) ?? settings.highFactor,
      lowFactor: num(batch?.f['异常阈值低倍']) ?? settings.lowFactor,
      swingScore: num(batch?.f['异常突变分差']) ?? settings.swingScore,
    };

    const [grid, typeIdx] = await Promise.all([this.markbook.getGrid(cls), this.examTypeIndex()]);
    const from = String(batch?.f['起日期'] ?? '').slice(0, 10);
    const to = String(batch?.f['止日期'] ?? '').slice(0, 10);
    const inRange = (d: string): boolean => {
      const day = d.slice(0, 10);
      if (!day) return true;
      if (from && day < from) return false;
      if (to && day > to) return false;
      return true;
    };
    const cols = grid.columns.filter(
      (c) => c.status !== '停用' && inRange(c.date) && typeIdx.get(c.type)?.counted !== false,
    );
    const cellMap = new Map(grid.cells.map((c) => [`${c.columnId}__${c.studentId}`, c]));
    const pctOf = (score: number, full: number): number => Math.round((score / (full || 100)) * 10000) / 100;

    const rows: AnomalyRow[] = [];
    let scanned = 0;

    for (const col of cols) {
      const pcts: number[] = [];
      for (const s of grid.students) {
        const cell = cellMap.get(`${col.id}__${s.id}`);
        if (!cell || cell.score == null) continue;
        pcts.push(pctOf(cell.score, col.fullMark));
      }
      // 样本 < 2 不算均值（一个人没法说「离群」）
      const classAvg = pcts.length >= 2 ? Math.round((pcts.reduce((a, b) => a + b, 0) / pcts.length) * 100) / 100 : null;

      for (const s of grid.students) {
        const cell = cellMap.get(`${col.id}__${s.id}`);
        if (!cell) continue;
        scanned++;
        // 本人该类型历史均值（同类型其它列）
        const same: number[] = [];
        for (const c2 of grid.columns) {
          if (c2.id === col.id || c2.type !== col.type) continue;
          const e2 = cellMap.get(`${c2.id}__${s.id}`);
          if (!e2 || e2.score == null) continue;
          same.push(pctOf(e2.score, c2.fullMark));
        }
        const historyAvg = same.length
          ? Math.round((same.reduce((a, b) => a + b, 0) / same.length) * 100) / 100
          : null;

        const hits = detectAnomalies(
          {
            entryId: `${col.id}__${s.id}`,
            columnId: col.id,
            columnName: col.name,
            studentId: s.id,
            studentName: s.name,
            score: cell.score,
            fullMark: col.fullMark,
            status: (cell.status as CellStatus) || '正常',
            classAvg,
            historyAvg,
          },
          th,
        );
        for (const h of hits) {
          rows.push({
            ...h,
            columnName: col.name,
            columnType: col.type,
            studentId: s.id,
            studentName: s.name,
            score: cell.score,
            fullMark: col.fullMark,
            classAvg,
          });
        }
      }
    }

    const order: Record<string, number> = {
      'R1 超满分': 0,
      'R2 零分': 1,
      'R3 离群高': 2,
      'R4 离群低': 3,
      'R5 突变': 4,
    };
    rows.sort(
      (a, b) =>
        (order[a.rule] ?? 9) - (order[b.rule] ?? 9) || a.columnName.localeCompare(b.columnName, 'zh-CN'),
    );
    return { rows, thresholds: th, scanned };
  }

  // ────────────────────────────────────────────────────────────
  // 成绩单数据组装（屏幕预览与 PDF 共用这一份）
  // ────────────────────────────────────────────────────────────

  /**
   * 组装一个学生在一个批次下的成绩单。
   *
   * ⚠️ 这是唯一的数据来源：屏幕预览与 PDF 都调它。
   *    以前吃过「两份口径必然漂移」的亏（网格显示 A、条目快照却是 B），
   *    所以屏幕与 PDF 只允许在**排版层**分两份，数据绝不分两份。
   */
  async buildReportCard(studentId: string, batchId: string): Promise<ReportCardData | null> {
    const batch = await this.batchOf(batchId);
    if (!batch) return null;
    const [all, cards] = await Promise.all([
      this.readAll(TABLES.termGrade.tableId),
      this.readAll(TABLES.reportCard.tableId),
    ]);
    const mine = all.filter(
      (x) =>
        String(this.linkIds(x.f['批次'])[0] ?? '') === batchId &&
        String(this.linkIds(x.f['学生'])[0] ?? '') === studentId,
    );
    if (!mine.length) return null;

    const first = mine[0];
    if (!first) return null;
    const card = cards.find(
      (x) =>
        String(this.linkIds(x.f['批次'])[0] ?? '') === batchId &&
        String(this.linkIds(x.f['学生'])[0] ?? '') === studentId,
    );

    const subjects = mine
      .map((x) => {
        const t = x.f['总评'];
        const rk = x.f['班级排名'];
        return {
          subject: String(x.f['科目'] ?? '') || '未分科目',
          total: t === '' || t == null ? null : Number(t),
          level: String(x.f['等级'] ?? ''),
          rank: rk === '' || rk == null ? null : Number(rk),
          rankTotal: Number(x.f['排名总人数'] ?? 0) || 0,
          attained: String(x.f['是否达标'] ?? ''),
          comment: String(x.f['教师评语'] ?? ''),
          teacher: String(x.f['任课教师'] ?? ''),
          status: String(x.f['状态'] ?? '草稿'),
        };
      })
      .sort((a, b) => a.subject.localeCompare(b.subject, 'zh-CN'));

    const gpHit = mine.find((x) => x.f['加权GPA'] !== '' && x.f['加权GPA'] != null);
    const confirmed = mine.map((x) => x.f['确认时间']).find((t) => t !== '' && t != null);

    return {
      batchId,
      batchName: String(batch.f['批次名称'] ?? ''),
      batchStatus: String(batch.f['状态'] ?? '草稿'),
      year: String(batch.f['学年'] ?? ''),
      term: String(batch.f['学期'] ?? ''),
      studentId,
      studentName: String(first.f['学生姓名'] ?? ''),
      studentNo: String(first.f['学号'] ?? ''),
      cls: String(first.f['班级'] ?? ''),
      grade: String(first.f['年级'] ?? ''),
      subjects,
      gpa: {
        weighted: gpHit && gpHit.f['加权GPA'] !== '' && gpHit.f['加权GPA'] != null ? Number(gpHit.f['加权GPA']) : null,
        unweighted:
          gpHit && gpHit.f['不加权GPA'] !== '' && gpHit.f['不加权GPA'] != null ? Number(gpHit.f['不加权GPA']) : null,
      },
      rank: subjects.find((s) => s.rank != null)?.rank ?? null,
      rankTotal: subjects.find((s) => s.rankTotal)?.rankTotal ?? 0,
      attainedCount: subjects.filter((s) => s.attained === '达标').length,
      summaryComment: card ? String(card.f['班主任总评语'] ?? '') : '',
      summaryStatus: card ? String(card.f['评语状态'] ?? '未写') : '未写',
      confirmedAt: confirmed == null ? '' : String(confirmed),
    };
  }

  /** 记一次导出（生成时间 / 生成人 / 次数 +1），供成绩单表留痕 */
  async markExported(batchId: string, studentId: string, actor: string, meta: { studentName: string; cls: string }): Promise<void> {
    const sql = getSqlStore();
    if (!sql) return;
    const hit = (await this.readAll(TABLES.reportCard.tableId)).find(
      (x) =>
        String(this.linkIds(x.f['批次'])[0] ?? '') === batchId &&
        String(this.linkIds(x.f['学生'])[0] ?? '') === studentId,
    );
    const n = hit ? Number(hit.f['导出次数'] ?? 0) || 0 : 0;
    const fields = {
      批次: batchId,
      学生: studentId,
      学生姓名: hit ? String(hit.f['学生姓名'] ?? meta.studentName) : meta.studentName,
      班级: hit ? String(hit.f['班级'] ?? meta.cls) : meta.cls,
      生成时间: Date.now(),
      生成人: actor,
      导出次数: n + 1,
    };
    if (hit) await sql.update(TABLES.reportCard.tableId, hit.id, fields);
    else await sql.create(TABLES.reportCard.tableId, { ...fields, 评语状态: '未写' });
  }

  /**
   * 整班成绩单数据（Phase 2 的「整班导出 ZIP」用）。
   *
   * 只组装数据、**不渲染 PDF** —— 渲染在 controller（那里才 import pdf.ts），
   * 避免 service ↔ pdf 互相 import 造成阅读上的环。
   *
   * 按「学生」去重：一个班 × 一个批次下，一个学生会有多条期末总评（每个科目一条），
   * 但成绩单是「学生 × 批次」一份 —— 不去重会导出 N 份重复的表。
   */
  async classReportCards(
    batchId: string,
    cls: string,
    subject = '',
  ): Promise<{
    students: { studentId: string; studentName: string; cls: string }[];
    data: ReportCardData[];
    skipped: number;
  }> {
    const { rows } = await this.listTermGrades({ batchId, cls, subject });
    const uniq = new Map<string, { studentId: string; studentName: string; cls: string }>();
    for (const r of rows) {
      if (!r.studentId) continue;
      if (!uniq.has(r.studentId)) {
        uniq.set(r.studentId, { studentId: r.studentId, studentName: r.studentName, cls: r.cls });
      }
    }
    const students = [...uniq.values()].sort((a, b) => a.studentName.localeCompare(b.studentName, 'zh-CN'));

    const data: ReportCardData[] = [];
    let skipped = 0;
    for (const s of students) {
      const card = await this.buildReportCard(s.studentId, batchId);
      if (card) data.push(card);
      else skipped += 1;
    }
    return { students, data, skipped };
  }
}

/** 按等级序号从绩点表取值；未配绩点或标了「不计入GPA」都返回 null */
function pointsByOrder(
  levels: LevelDef[],
  order: number | null,
  points: Map<string, { points: number | null; counted: boolean }>,
): number | null {
  if (order == null) return null;
  const lv = levels.find((l) => l.order === order);
  if (!lv) return null;
  const p = points.get(lv.id);
  if (!p || !p.counted) return null;
  return p.points;
}

function num(v: unknown): number | null {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
