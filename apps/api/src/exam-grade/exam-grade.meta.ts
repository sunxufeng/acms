import { TABLES } from '@acms/contracts';
import type { RecordMeta } from '../shared/generic-crud.module.js';

/**
 * 考试与成绩 —— 通用 CRUD 承载的四张表（参照 RosarioSIS v13 Grades 模块，2026-09-16）。
 *
 * 定位：成绩册（Markbook）负责「过程录入」，本模块负责「结果产出」。
 *   考核类型 ──┐
 *              ├──► 成绩册列（引用：颜色 / 缺省权重 / 是否计入总评）
 *   成绩批次 ──┐
 *              ├──► 期末总评（学生 × 批次 × 科目，结转写入的快照）
 *   学生 ──────┴──► 成绩单（学生 × 批次，班主任总评语 + PDF 生成记录）
 *
 * ⚠️ 建表不在这里 —— 通用 CRUD 只生成路由、**不建表**。
 *    四张表的 `ensureTable` 在 `exam-grade.service.ts` 的 `ensureTables()` 里，
 *    由 `ExamGradeModule.onModuleInit` 调用。漏了的话接口会全线 500。
 *
 * ⚠️ 快照字段（等级 / 等级序号 / 是否达标 / 排名 / GPA / 参与项 / 计算明细 / 确认人 / 确认时间）
 *    一律声明为 readonly，由 `ExamGradeService` 在结转时写入 —— 不要让前端填。
 */
export const EXAM_GRADE_METAS: RecordMeta[] = [
  {
    path: 'exam-types',
    tableId: TABLES.examType.tableId,
    readPerm: 'module:examGrades:read',
    writePerm: 'module:examGrades:update',
    numbers: ['缺省权重', '排序'],
    statusField: '状态',
    defaultStatus: '启用',
    searchFields: ['类型名称', '英文名', '说明'],
    sortField: '排序',
    defaults: { 缺省权重: 1, 计入总评: '是', 排序: 0, 状态: '启用' },
  },
  {
    path: 'exam-batches',
    tableId: TABLES.gradeBatch.tableId,
    readPerm: 'module:examGrades:read',
    writePerm: 'module:examGrades:update',
    numbers: [],
    dateFields: ['起日期', '止日期'],
    linkFields: [{ field: '等级体系', table: TABLES.gradeScale.tableId, nameField: '名称' }],
    statusField: '状态',
    defaultStatus: '草稿',
    searchFields: ['批次名称', '学年', '学期', '备注'],
    sortField: '更新时间',
    defaults: { 舍入口径: '保留1位小数', 免考处理: '不计入分母', 缺考处理: '计0分', 状态: '草稿' },
  },
  {
    path: 'exam-term-grades',
    tableId: TABLES.termGrade.tableId,
    readPerm: 'module:examGrades:read',
    writePerm: 'module:examGrades:update',
    numbers: [
      '总评',
      '等级序号',
      '参与项数',
      '权重和',
      '含免考数',
      '含缺考数',
      '加权GPA',
      '不加权GPA',
      '班级排名',
      '排名总人数',
      '手工调整分',
    ],
    dateFields: ['确认时间'],
    // 服务端写入的快照 —— 前端只读（见文件头注释）
    readonly: [
      '等级',
      '等级序号',
      '是否达标',
      '参与项数',
      '权重和',
      '含免考数',
      '含缺考数',
      '加权GPA',
      '不加权GPA',
      '班级排名',
      '排名总人数',
      '计算明细',
      '确认人',
      '确认时间',
      '学生姓名',
      '学号',
      '年级',
      '班级',
      '科目',
    ],
    linkFields: [
      { field: '批次', table: TABLES.gradeBatch.tableId, nameField: '批次名称' },
      { field: '学生', table: TABLES.studentProfile.tableId, nameField: '学生姓名' },
    ],
    // 行级学生数据范围：关联字段是 link、存 record id
    studentMatch: { field: '学生', by: 'id' },
    studentScoped: true,
    statusField: '状态',
    defaultStatus: '草稿',
    searchFields: ['学生姓名', '学号', '科目', '教师评语'],
    sortField: '班级排名',
  },
  {
    path: 'exam-report-cards',
    tableId: TABLES.reportCard.tableId,
    readPerm: 'module:examGrades:read',
    writePerm: 'module:examGrades:update',
    numbers: ['导出次数'],
    dateFields: ['生成时间'],
    readonly: ['学生姓名', '年级', '班级', '生成时间', '生成人', '导出次数'],
    linkFields: [
      { field: '批次', table: TABLES.gradeBatch.tableId, nameField: '批次名称' },
      { field: '学生', table: TABLES.studentProfile.tableId, nameField: '学生姓名' },
    ],
    studentMatch: { field: '学生', by: 'id' },
    studentScoped: true,
    statusField: '评语状态',
    defaultStatus: '未写',
    searchFields: ['学生姓名', '年级', '班级', '班主任总评语'],
    sortField: '更新时间',
  },
];
