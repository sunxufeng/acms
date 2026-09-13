/**
 * 课程规划 / 学习成果 / 课时教案 —— 通用 CRUD 元数据（Planner 口径，参照 Gibbon v31 移植）。
 *
 * 三块资源（menu key 见 contracts/module-permissions.ts）：
 *   curriculum        课程规划：单元 → 单元环节 → 单元开课 → 部署环节 → 单元挂成果
 *   learningOutcomes  学习成果：成果库（全校 / 学习领域）
 *   lessonPlan        课时教案：课时教案 → 课时挂成果 → 作业提交 / 作业完成追踪
 *
 * ⚠️ path 必须落在对应 module 的已注册前缀下，否则 moduleByPath 会回退到别的资源
 *    （鉴权静默走错权限点）：
 *     - `curriculum/*`        → key=curriculum
 *     - `learning-outcomes/*` → key=learningOutcomes
 *     - `lesson-plans/*`      → key=lessonPlan
 *
 * ⚠️ link 字段不要写进 readonly：buildWriteFields 会先把 readonly 字段丢掉，
 *    写在 readonly 里等于这个关联字段永远存不进去。
 */
import { TABLES, modulePermission } from '@acms/contracts';
import type { RecordMeta } from '../shared/generic-crud.module.js';
import { computeLate } from './curriculum.logic.js';

const CUR_READ = modulePermission('curriculum', 'read');
const CUR_WRITE = modulePermission('curriculum', 'update');
const LESSON_READ = modulePermission('lessonPlan', 'read');
const LESSON_WRITE = modulePermission('lessonPlan', 'update');
const OUTCOME_READ = modulePermission('learningOutcomes', 'read');
const OUTCOME_WRITE = modulePermission('learningOutcomes', 'update');

/**
 * 各状态字段的取值（前端 columns 的 options 是同一份值的副本，前端无法 import 后端）。
 * 这里以注释形式留档，改值时两边要一起改：
 *   单元状态     草稿 / 已发布 / 已归档
 *   环节状态     启用 / 停用（**停用不参与部署与覆盖率统计**，见 curriculum.service.ts）
 *   开课状态     未开始 / 进行中 / 已完成 / 已取消
 *   部署状态     未开始 / 进行中 / 已完成 / 已跳过
 *   成果状态     启用 / 停用
 *   教案状态     草稿 / 已发布 / 已归档
 *   提交状态     待批改 / 已批改 / 已退回
 *   适用范围     全校 / 学习领域
 */
export const CURRICULUM_METAS: RecordMeta[] = [
  // ── 课程规划 · 单元母版 ──────────────────────────────────────────
  {
    path: 'curriculum/units',
    tableId: TABLES.curriculumUnit.tableId,
    readPerm: CUR_READ,
    writePerm: CUR_WRITE,
    numbers: ['预计课时', '排序'],
    readonly: [],
    statusField: '单元状态',
    defaultStatus: '草稿',
    searchFields: ['单元名称', '单元描述', '学年'],
    // 学年刻意不做关联：全站没有「学年」列表接口（学年表只在迁移脚本里用），
    // 做成 link 会写进一个取不到记录的假 id，列表里只能显示那串 id。
    // 这里存文本（如 2026-2027），口径与课程方案的「适用学年」一致。
    linkFields: [
      { field: '课程方案', table: TABLES.coursePlan.tableId, nameField: '课程方案名称' },
    ],
  },

  // ── 课程规划 · 单元环节 ──────────────────────────────────────────
  {
    path: 'curriculum/unit-blocks',
    tableId: TABLES.curriculumUnitBlock.tableId,
    readPerm: CUR_READ,
    writePerm: CUR_WRITE,
    numbers: ['课时数', '排序'],
    searchFields: ['环节名称', '环节描述'],
    // 停用的环节不参与部署、也不计入覆盖率的环节总数（见 curriculum.service.ts）
    statusField: '环节状态',
    defaultStatus: '启用',
    linkFields: [
      { field: '所属单元', table: TABLES.curriculumUnit.tableId, nameField: '单元名称' },
    ],
  },

  // ── 课程规划 · 单元开课（单元 × 教学班）──────────────────────────
  {
    path: 'curriculum/unit-classes',
    tableId: TABLES.curriculumUnitClass.tableId,
    readPerm: CUR_READ,
    writePerm: CUR_WRITE,
    dateFields: ['开始日期', '结束日期'],
    // 结束日期必须晚于开始日期，由通用层校验（写库前抛 VALIDATION）
    timeRange: { startField: '开始日期', endField: '结束日期' },
    searchFields: ['开课名称', '备注'],
    statusField: '开课状态',
    defaultStatus: '未开始',
    // 「开课名称」是自由文本，同时充当 unitClassBlock.所属开课 的展示名（关联解析拿它当 nameField）
    linkFields: [
      { field: '单元', table: TABLES.curriculumUnit.tableId, nameField: '单元名称' },
      { field: '教学班', table: TABLES.teachingClass.tableId, nameField: '教学班名称' },
    ],
  },

  // ── 课程规划 · 部署环节（环节落到具体课次）──────────────────────
  {
    path: 'curriculum/unit-class-blocks',
    tableId: TABLES.unitClassBlock.tableId,
    readPerm: CUR_READ,
    writePerm: CUR_WRITE,
    dateFields: ['授课日期'],
    searchFields: ['备注'],
    statusField: '部署状态',
    defaultStatus: '未开始',
    linkFields: [
      { field: '所属开课', table: TABLES.curriculumUnitClass.tableId, nameField: '开课名称' },
      { field: '环节', table: TABLES.curriculumUnitBlock.tableId, nameField: '环节名称' },
      { field: '课次', table: TABLES.session.tableId, nameField: '课次名称' },
      { field: '单元', table: TABLES.curriculumUnit.tableId, nameField: '单元名称' },
    ],
  },

  // ── 课程规划 · 单元挂成果 ────────────────────────────────────────
  {
    path: 'curriculum/unit-outcomes',
    tableId: TABLES.unitOutcome.tableId,
    readPerm: CUR_READ,
    writePerm: CUR_WRITE,
    numbers: ['排序'],
    searchFields: ['成果改写'],
    linkFields: [
      { field: '所属单元', table: TABLES.curriculumUnit.tableId, nameField: '单元名称' },
      { field: '学习成果', table: TABLES.learningOutcome.tableId, nameField: '成果名称' },
    ],
  },

  // ── 学习成果库 ──────────────────────────────────────────────────
  {
    path: 'learning-outcomes/outcomes',
    tableId: TABLES.learningOutcome.tableId,
    readPerm: OUTCOME_READ,
    writePerm: OUTCOME_WRITE,
    numbers: ['排序'],
    searchFields: ['成果名称', '成果简称', '成果描述'],
    statusField: '成果状态',
    defaultStatus: '启用',
    linkFields: [
      { field: '所属部门', table: TABLES.departments.tableId, nameField: 'name' },
    ],
  },

  // ── 课时教案 ────────────────────────────────────────────────────
  {
    path: 'lesson-plans/lessons',
    tableId: TABLES.lessonEntry.tableId,
    readPerm: LESSON_READ,
    writePerm: LESSON_WRITE,
    dateFields: ['备课日期'],
    searchFields: ['课题', '教学目标', '教学内容'],
    statusField: '教案状态',
    defaultStatus: '草稿',
    linkFields: [
      { field: '课次', table: TABLES.session.tableId, nameField: '课次名称' },
      { field: '教学班', table: TABLES.teachingClass.tableId, nameField: '教学班名称' },
      { field: '所属单元', table: TABLES.curriculumUnit.tableId, nameField: '单元名称' },
    ],
  },

  // ── 课时挂成果 ──────────────────────────────────────────────────
  {
    path: 'lesson-plans/lesson-outcomes',
    tableId: TABLES.lessonOutcome.tableId,
    readPerm: LESSON_READ,
    writePerm: LESSON_WRITE,
    searchFields: ['成果改写'],
    linkFields: [
      { field: '课时教案', table: TABLES.lessonEntry.tableId, nameField: '课题' },
      { field: '学习成果', table: TABLES.learningOutcome.tableId, nameField: '成果名称' },
    ],
  },

  // ── 作业提交（迟交由服务端核算，见 curriculum.service.ts）────────
  {
    path: 'lesson-plans/homework-submissions',
    tableId: TABLES.homeworkSubmission.tableId,
    readPerm: LESSON_READ,
    writePerm: LESSON_WRITE,
    numbers: ['版本号', '迟交分钟数'],
    dateFields: ['截止时间', '提交时间'],
    // 「是否迟交 / 迟交分钟数」是服务端按截止时间与提交时间二次核算的结果，
    // 登记为 readonly 让前端不渲染输入框、也防止被直接写入覆盖。
    readonly: ['是否迟交', '迟交分钟数'],
    searchFields: ['作业名称', '提交内容'],
    statusField: '提交状态',
    defaultStatus: '待批改',
    // 新建即核算迟交：defaults 在 writeFields 之后套用，此时 截止时间/提交时间 已转成毫秒戳，
    // 正好拿来做比较；两个时间缺一时 computeLate 返回 null，不写这两个字段。
    // （后续修改时间字段需重算时走 POST /lesson-plans/homework-submissions/recompute-late）
    defaults: (fields) => {
      const late = computeLate(fields['提交时间'], fields['截止时间']);
      return late ? { 是否迟交: late.是否迟交, 迟交分钟数: late.迟交分钟数 } : {};
    },
    linkFields: [
      { field: '教学班', table: TABLES.teachingClass.tableId, nameField: '教学班名称' },
      { field: '课次', table: TABLES.session.tableId, nameField: '课次名称' },
      { field: '学生', table: TABLES.studentProfile.tableId, nameField: '学生姓名' },
    ],
  },

  // ── 作业完成追踪 ────────────────────────────────────────────────
  {
    path: 'lesson-plans/homework-tracker',
    tableId: TABLES.homeworkTracker.tableId,
    readPerm: LESSON_READ,
    writePerm: LESSON_WRITE,
    dateFields: ['完成时间'],
    searchFields: ['作业名称', '备注'],
    linkFields: [
      { field: '教学班', table: TABLES.teachingClass.tableId, nameField: '教学班名称' },
      { field: '课次', table: TABLES.session.tableId, nameField: '课次名称' },
      { field: '学生', table: TABLES.studentProfile.tableId, nameField: '学生姓名' },
    ],
  },
];
