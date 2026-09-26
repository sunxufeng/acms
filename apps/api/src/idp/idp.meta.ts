/**
 * IDP 管理两张表的元数据。
 *  - idp-plans：IDP 方案（父表，纳入学生 360 聚合，关联学生按姓名匹配）
 *  - idp-communications：IDP 沟通记录（子表，必须挂在某个 IDP 方案下，不进 360 聚合）
 * 字段严格对应飞书实际字段（recreate_idp_tables.mjs 建表）。
 */
import { TABLES, modulePermission } from '@acms/contracts';
import type { RecordMeta } from '../shared/generic-crud.module.js';

const PERM_R = 'student:read';
const PERM_W = 'student:write';

/**
 * IDP 重构（2026-09-26）的新两张表权限：**复用「IDP 配置」那个模块权限点**
 * （由原 `idpPlans` 改名而来，`module:idpPlans:*`）。
 *
 * 生产实测（2026-09-26）持有情况：`module:idpPlans:read/update` = 系统管理员 + 院级管理；
 * `module:idpPlans:enter` 另有 student / parent（他们本来也能看到原「IDP管理」菜单，不是本次变化）。
 * ⇒ 「IDP 配置」页只有管理员/院级能用，与设计口径一致，**一个角色配置都不用改**。
 */
const IDP_R = modulePermission('idpPlans', 'read');
const IDP_W = modulePermission('idpPlans', 'update');

export const IDP_PLAN_META: RecordMeta = {
  path: 'idp-plans',
  tableId: TABLES.idpPlan.tableId,
  readPerm: PERM_R,
  writePerm: PERM_W,
  dateFields: ['学生确认时间', '导师确认时间', '制定日期'],
  // 注意：原始文档（附件）必须可写，不能放入 readonly
  readonly: [],
  studentMatch: { field: '关联学生', by: 'name' },
  studentScoped: true,
  statusField: '状态',
  defaultStatus: '草稿',
  searchField: '关联学生',
  sortField: '制定日期',
};

/**
 * ⚠️ 2026-09-21：**界面入口已收起** —— IDP 沟通并入「学生记录」
 * （记录类型 = IDP沟通，内容与日常跟进完全相同）。
 *
 * 收起的只是**入口**，这张表与这个 meta 都保留：
 *   · 表当时 **0 行** ⇒ 收起入口没有丢数据；
 *   · 保留接口的代价是「理论上仍可调 API 写入」，但界面上已无任何入口
 *     （IDP管理页的行级按钮、方案详情页内嵌列表、`/idp-plans/[id]/communications/**`
 *     三个路由都已改掉或改为重定向），实际不会有人用到；
 *   · 将来若要挪回方案下（按方案归档），恢复成本是"把前端入口与页面改回来"，
 *     不需要动这里的注册。
 *
 * 🔴 别在别处新增引用：那会重新造出「同一件事两处都能记、而学生全景 / 搜索 / AI 各读一处」。
 */
export const IDP_COMM_META: RecordMeta = {
  path: 'idp-communications',
  tableId: TABLES.idpCommunication.tableId,
  readPerm: PERM_R,
  writePerm: PERM_W,
  dateFields: ['沟通日期'],
  readonly: [],
  /**
   * 沟通记录不直接关联学生，挂在 IDP 方案下 —— 按「可见方案」间接过滤。
   * 不这样做的话，班主任在 IDP 沟通记录列表里仍能看到别的班学生的沟通内容。
   */
  studentVia: {
    linkField: '关联IDP方案',
    linkTable: TABLES.idpPlan.tableId,
    innerMatchField: '关联学生',
    innerMatchBy: 'name',
  },
  searchField: '关联IDP方案',
  sortField: '沟通日期',
};

// ─────────────────────────────────────────────────────────────
// 2026-09-26 重构：IDP配置（批次）+ IDP学生（明细）
// ─────────────────────────────────────────────────────────────

/**
 * `IDP配置` —— 一行 = 一个「学年 × 学期」批次。
 *
 * 字段：配置名称 / 学年（关联 `学年表`）/ 学期（字典）/ 状态 / 学生范围（留痕）/ 说明 /
 *       创建人 / 创建时间（ms 时间戳）。
 *
 * 🔴 「创建时间」用 **number（ms）** 而不是日期字段：日期字段（type=5）读出来会**丢时分秒**
 *    （套件记过这个坑），而这里要按时间倒序排批次，只到天会并列。
 */
export const IDP_CONFIG_META: RecordMeta = {
  path: 'idp-configs',
  tableId: TABLES.idpConfig.tableId,
  readPerm: IDP_R,
  writePerm: IDP_W,
  numbers: ['创建时间'],
  linkFields: [{ field: '学年', table: TABLES.academicYear.tableId, nameField: '学年名称' }],
  statusField: '状态',
  defaultStatus: '进行中',
  searchField: '配置名称',
  sortField: '创建时间',
};

/**
 * `IDP学生` —— 一行 = 配置 × 学生。
 *
 * 字段：所属配置 / 学生（关联 `学生档案`）/ 学生姓名 / 班级 / 当前年级 /
 *       IDP老师（**存用户表的 open_id 文本**，与「招生负责老师」同一形态）/
 *       状态 / 备注 / 沟通次数 / 最近沟通时间 / 最近沟通摘要。
 *
 * 🔴 「学生姓名 / 班级 / 当前年级」是**冗余快照**：明细列表要显示它们，
 *    实时 join 学生表（82 行）不是问题，但**跨表 join 在 SqlStore 里做不到**
 *    （关联字段存的是 id 数组，不能用等值 filter —— 套件老坑），只能全量读+内存 join。
 *    留快照让列表在只读这一张表时也能显示（且学生改名后仍能看到当时的名字）。
 *    快照由 `pullStudents()` 写入，学生改班级/年级后重拉即刷新（幂等，只补不覆盖老师）。
 */
export const IDP_STUDENT_META: RecordMeta = {
  path: 'idp-students',
  tableId: TABLES.idpStudent.tableId,
  readPerm: IDP_R,
  writePerm: IDP_W,
  numbers: ['沟通次数', '最近沟通时间'],
  linkFields: [
    { field: '所属配置', table: TABLES.idpConfig.tableId, nameField: '配置名称' },
    { field: '学生', table: TABLES.studentProfile.tableId, nameField: '学生姓名' },
  ],
  searchField: '学生姓名',
  sortField: '学生姓名',
};

/** 供 `GenericCrudModule.registerAll` 注册的两张新表元数据 */
export const IDP_METAS: RecordMeta[] = [IDP_CONFIG_META, IDP_STUDENT_META];
