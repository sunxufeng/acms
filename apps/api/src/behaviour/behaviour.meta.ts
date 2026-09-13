/**
 * 行为记录（Behaviour）——通用 CRUD 元数据（参照 GibbonEdu/core v31 的 Behaviour 移植）。
 *
 * 四张表的关系：
 *   行为记录 behaviourRecord  一个学生一条；多学生同一次事件用「批次号」关联
 *   行为跟进 behaviourFollowUp 对某条行为的后续处理流水（可多条）
 *   学生告警 studentAlert      **由行为记录重算出来的派生结果**（不是手填），可删可重建
 *   通知信件 behaviourLetter   按告警等级生成的家长通知（正文由服务端模板生成）
 *
 * ⚠️ path 必须落在 `behaviour` 模块的已注册前缀下（contracts/module-permissions.ts 的
 *    `{ key:'behaviour', path:'/behaviour' }`），否则 moduleByPath 会回退到别的资源、
 *    鉴权静默走错权限点：
 *      behaviour/records     行为记录（**自定义控制器承载**，见 behaviour.controller.ts）
 *      behaviour/follow-ups  跟进流水
 *      behaviour/alerts      学生告警
 *      behaviour/letters     通知信件
 *
 * ⚠️ link 字段**不要**写进 readonly：buildWriteFields 会先剥掉 readonly 字段，
 *    写在 readonly 里等于这个关联字段永远存不进去。
 *    但「派生结果」类字段（告警的统计值、信件的正文）**必须**写 readonly ——
 *    它们只能由重算/生成接口写入，不能让通用更新接口覆盖。
 */
import { TABLES } from '@acms/contracts';
import { modulePermission } from '@acms/contracts';
import type { RecordMeta } from '../shared/generic-crud.module.js';
import { hasLinkId } from './behaviour.logic.js';

const READ = modulePermission('behaviour', 'read');
const WRITE = modulePermission('behaviour', 'update');

/** 各状态字段取值（前端 columns 的 options 是同一份值的副本，改值时两边一起改）
 *   行为记录 状态   草稿 / 已发布 / 已归档
 *   行为类型        正向 / 负向
 *   跟进状态        待跟进 / 进行中 / 已完成
 *   跟进方式        谈话 / 电话 / 家访 / 书面 / 其它
 *   告警等级        轻度 / 中度 / 严重
 *   告警状态        未处理 / 处理中 / 已解除
 *   信件类型        提醒 / 警告 / 严重警告
 *   信件状态        草稿 / 已发送 / 已确认
 */

/**
 * 行为记录表：**不走 GenericCrudModule.registerAll**。
 *
 * 原因：新建/修改/删除都必须触发该学生的告警重算（见 BehaviourRecordService），
 * 而通用 CRUD 生成的 service 没有任何写入钩子。这里只导出 meta，
 * 由 behaviour.module.ts 的自定义控制器承载同一套 REST 形状
 * （GET / | GET /:id | POST / | PUT /:id | DELETE /:id | POST /:id/transition）。
 */
export const BEHAVIOUR_RECORD_META: RecordMeta = {
  path: 'behaviour/records',
  tableId: TABLES.behaviourRecord.tableId,
  readPerm: READ,
  writePerm: WRITE,
  numbers: ['分值'],
  dateFields: ['发生日期', '发生时间'],
  linkFields: [{ field: '学生', table: TABLES.studentProfile.tableId, nameField: '学生姓名' }],
  statusField: '状态',
  defaultStatus: '草稿',
  // 「学生姓名」是冗余列：关联字段在列表里要靠跨表解析（每页 N 次请求），
  // 冗余存一份既能让列表直接可读，也让搜索/按班级汇总不必再回连学生档案。
  searchFields: ['学生姓名', '描述', '行为分类', '地点', '批次号'],
  sortField: '发生日期',
  // 时间区间筛选（前端 rangeFilters 传 发生日期_from/_to → listDeep 内存过滤）
  rangeField: '发生日期',
};

/**
 * 由 `GenericCrudModule.registerAll(BEHAVIOUR_METAS)` 注册（标准五端点）。
 * ⚠️ 行为记录不在其中（见上）；告警与信件在列，但前端 `hideCreate` + 派生字段 readonly。
 */
export const BEHAVIOUR_METAS: RecordMeta[] = [
  // ── 跟进流水 ──────────────────────────────────────────────────────
  {
    path: 'behaviour/follow-ups',
    tableId: TABLES.behaviourFollowUp.tableId,
    readPerm: READ,
    writePerm: WRITE,
    dateFields: ['跟进日期'],
    linkFields: [
      // 展示名取行为记录的「学生姓名」冗余列，跟进列表直接看得出是谁的行为
      { field: '行为记录', table: TABLES.behaviourRecord.tableId, nameField: '学生姓名' },
    ],
    statusField: '状态',
    defaultStatus: '待跟进',
    searchFields: ['跟进人', '跟进内容', '结果', '下一步'],
    sortField: '跟进日期',
    rangeField: '跟进日期',
  },

  // ── 学生告警（派生结果）──────────────────────────────────────────
  {
    path: 'behaviour/alerts',
    tableId: TABLES.studentAlert.tableId,
    readPerm: READ,
    writePerm: WRITE,
    numbers: ['关联行为条数', '关联分值合计'],
    dateFields: ['首次触发时间', '最近触发时间'],
    // 统计结果由 POST /behaviour/recalc-alerts 写入（记录 id 固定为 `<studentId>__<窗口>`），
    // 通用更新接口只能改「处理状态 / 处理人 / 处理说明 / 是否已通知家长」这四个字段。
    readonly: [
      '学生', '学生姓名', '班级',
      '告警等级', '告警窗口', '触发原因',
      '关联行为条数', '关联分值合计',
      '首次触发时间', '最近触发时间',
    ],
    linkFields: [{ field: '学生', table: TABLES.studentProfile.tableId, nameField: '学生姓名' }],
    statusField: '状态',
    defaultStatus: '未处理',
    searchFields: ['学生姓名', '班级', '触发原因', '告警窗口'],
    sortField: '最近触发时间',
    /**
     * 专用读取：`GET /behaviour/alerts?studentId=<学生 record id>`（供学生全景/门户用）。
     * 关联字段在 jsonb 里存的是 `["rec_x"]`，等值筛选必然筛空，所以走内存过滤；
     * 这里把它登记成 deepParams，主分支才不会拿它当字段名做等值匹配。
     */
    deepParams: ['studentId'],
    deepFilter: (row, query) => {
      const sid = String(query['studentId'] ?? '').trim();
      if (!sid) return undefined;
      // resolveLinks 之后：展示值是姓名、原始 id 留在 `<字段>__link` 数组里
      return hasLinkId(row['学生__link'], sid) || hasLinkId(row['学生'], sid);
    },
  },

  // ── 家长通知信件 ──────────────────────────────────────────────────
  {
    path: 'behaviour/letters',
    tableId: TABLES.behaviourLetter.tableId,
    readPerm: READ,
    writePerm: WRITE,
    numbers: ['创建时计数'],
    dateFields: ['生成时间', '发送时间'],
    // 信件由 POST /behaviour/letters/generate 生成（幂等：同一告警同一档不重复生成）：
    // 学生/类型/正文/计数/生成时间都是生成结果，通用更新只能改「收件家长 / 状态 / 发送时间」。
    readonly: [
      '学生', '学生姓名', '告警', '信件类型',
      '信件正文', '创建时计数', '生成时间',
    ],
    linkFields: [
      { field: '学生', table: TABLES.studentProfile.tableId, nameField: '学生姓名' },
      // 告警的展示名取「告警等级」（触发原因太长，塞进列表列会撑爆）；
      // 记录 id 是 `<studentId>__<窗口>`，稳定可解析。
      { field: '告警', table: TABLES.studentAlert.tableId, nameField: '告警等级' },
    ],
    statusField: '状态',
    defaultStatus: '草稿',
    searchFields: ['学生姓名', '收件家长', '信件类型', '信件正文'],
    sortField: '生成时间',
    rangeField: '生成时间',
  },
];
