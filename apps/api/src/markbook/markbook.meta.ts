import { TABLES } from '@acms/contracts';
import type { RecordMeta } from '../shared/generic-crud.module.js';

/**
 * 成绩册（Markbook）—— 参照 GibbonEdu/core v31 移植，2026-09-13。
 *
 * 数据模型（两张主体 + 三张配置，配置表在 TEACHING_CONFIG_METAS 里）：
 *   成绩等级体系 gradeScale ─┬─ 成绩等级 gradeScaleLevel（序号越小越好）
 *                            └─ 被「列」引用
 *   成绩类型权重 markbookWeight（教学班 × 类型 → 权重）
 *   成绩册列 markbookColumn（一列 = 一次考核；含列权重 / 满分 / 班级）
 *   成绩册条目 markbookEntry（一列 × 一个学生；含写入时的等级快照）
 *   成绩个人目标 markbookTarget（学生 × 班级 → 目标等级）
 *
 * 「班级」维度说明（ACMS 与 Gibbon 的差异）：
 *   Gibbon 的成绩册按 course enrolment 取学生名单；ACMS 的「教学班」目前没有成员关系，
 *   而学生档案自带「当前班级」（82 名学生都有值），所以这里**用学生档案的「当前班级」
 *   与列的「班级」对齐**来取名单 —— 立刻可用，不依赖先建教学班与成员关系。
 *
 * ⚠️ 条目上的「等级 / 等级序号 / 是否达标 / 是否关注」是**写入时的快照**（等级改名不篡改历史），
 *    由 MarkbookService 计算写入，在 RecordMeta 里声明为 readonly —— 不要让前端填。
 *    录入与重算统一走 `POST /markbook/entries/save`、`POST /markbook/recalc`。
 */
export const MARKBOOK_METAS: RecordMeta[] = [
  {
    path: 'markbook-columns',
    tableId: TABLES.markbookColumn.tableId,
    readPerm: 'module:markbook:read',
    writePerm: 'module:markbook:update',
    numbers: ['列权重', '满分', '排序'],
    dateFields: ['考核日期'],
    linkFields: [{ field: '等级体系', table: TABLES.gradeScale.tableId, nameField: '名称' }],
    // 三个开关：状态控制列是否参与汇总；学生/家长可见性是两个正交开关（成绩的可见性
    // 比行为的更敏感，单独一列一格控制），「完成闸门」= 达到该日期前不对家长开放
    statusField: '状态',
    defaultStatus: '启用',
    searchFields: ['列名称', '班级', '考核类型', '描述', '科目'],
    sortField: '更新时间',
  },
  {
    path: 'markbook-entries',
    tableId: TABLES.markbookEntry.tableId,
    readPerm: 'module:markbook:read',
    writePerm: 'module:markbook:update',
    numbers: ['得分', '等级序号'],
    linkFields: [
      { field: '成绩册列', table: TABLES.markbookColumn.tableId, nameField: '列名称' },
      { field: '学生', table: TABLES.studentProfile.tableId, nameField: '学生姓名' },
    ],
    // 快照字段：服务端写入，前端只读（见文件头注释）
    readonly: ['等级', '等级序号', '是否达标', '是否关注'],
    // 「单元格状态」= 正常 / 免考 / 缺考（2026-09-16 新增，见 markbook.service.saveEntries）。
    // 三态直接决定期末总评的分母，不能省。
    searchFields: ['学生姓名', '班级', '评语', '单元格状态'],
    // 学生档案行级数据范围（与成绩册列表同一口径）
    studentMatch: { field: '学生', by: 'id' },
    studentScoped: true,
    sortField: '更新时间',
  },
  {
    path: 'markbook-targets',
    tableId: TABLES.markbookTarget.tableId,
    // 2026-09-20：本表有了独立页面与独立权限点（`module:markbookTargets:*`）；
    // 迁移（v4）已让原本持有 module:markbook:* 的角色继承，零行为变化。
    readPerm: 'module:markbookTargets:read',
    writePerm: 'module:markbookTargets:update',
    numbers: ['目标等级序号', '目标分'],
    linkFields: [{ field: '学生', table: TABLES.studentProfile.tableId, nameField: '学生姓名' }],
    searchFields: ['学生姓名', '班级', '备注'],
    // 目标也是「按学生」的数据：沿用成绩册同一套学生档案数据范围，
    // 老师不该在目标页看到授权范围之外的学生（与成绩册条目同口径）。
    studentMatch: { field: '学生', by: 'id' },
    studentScoped: true,
    sortField: '更新时间',
  },
];
