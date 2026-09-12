/**
 * 学生全生命周期域（M1 招生与学生）的 7 张飞书表的元数据。
 * 字段名严格对应飞书实际字段（通过 listFields 核对）。
 *  - numbers:    数值字段（写入时强转 number）
 *  - dateFields: 日期字段（写入时字符串→毫秒时间戳，读取时→本地日期字符串）
 *  - readonly:   不可写字段（人员/附件/多选/勾选），避免飞书类型校验失败
 *  - statusField/ defaultStatus: 状态展示与新建默认
 */
import { TABLES } from '@acms/contracts';
import type { RecordMeta } from './generic-crud.module.js';
import { getSqlStore } from '../base.provider.js';

const PERM_R = 'student:read';
const PERM_W = 'student:write';

/**
 * 按「跟进人」反查其跟进过的联系人 id 集合（卫瓴跟进记录表）。
 *
 * 跟进人不是联系人表上的字段（联系人只有「归属人」），所以报表里点某个跟进人
 * 想看他跟进过的线索，只能先从跟进记录表算出 id 集合再回连。
 * 结果缓存 10 分钟 —— 跟进记录是异步同步的，实时性要求不高，但要避免每次翻页都扫全表。
 */
const followerCache = new Map<string, { at: number; ids: Set<string> }>();
const FOLLOWER_TTL_MS = 10 * 60 * 1000;

async function contactIdsOfFollower(name: string): Promise<Set<string>> {
  const hit = followerCache.get(name);
  if (hit && Date.now() - hit.at < FOLLOWER_TTL_MS) return hit.ids;
  const ids = new Set<string>();
  const sql = getSqlStore();
  if (sql) {
    let token: string | undefined;
    for (let p = 0; p < 40; p += 1) {
      const res = await sql.search(TABLES.weilingProgress.tableId, {
        pageSize: 500,
        ...(token ? { pageToken: token } : {}),
      });
      for (const r of res.items ?? []) {
        const rec = r as { recordId?: string; fields?: Record<string, unknown> };
        const f = ((rec.fields ?? r) ?? {}) as Record<string, unknown>;
        const who = String(f['跟进人'] ?? '');
        if (!who) continue;
        // 卫瓴员工名形如「致极学院-曹老师｜Dainel」，报表传的是完整名，用包含关系兜底
        if (who !== name && !who.includes(name) && !name.includes(who)) continue;
        const cid = String(f['关联联系人ID'] ?? '');
        if (cid) ids.add(cid);
      }
      if (!res.hasMore || !res.pageToken) break;
      token = res.pageToken;
    }
  }
  followerCache.set(name, { at: Date.now(), ids });
  return ids;
}

export const LIFECYCLE_METAS: RecordMeta[] = [
  {
    path: 'source-followups',
    tableId: TABLES.sourceFollowup.tableId,
    readPerm: PERM_R,
    writePerm: PERM_W,
    dateFields: ['活动参与日期', '跟进时间', '下次跟进日期'],
    readonly: ['跟进负责人', '跟进附件', '关联学生编号'],
    studentMatch: { field: '关联学生', by: 'name' },
    linkFields: [
      { field: '关联学生编号', table: TABLES.studentProfile.tableId, nameField: '学生姓名' },
      // 招生阶段人还没入学，跟进对象是卫瓴线索（联系人）：前端提交 contact_id，
      // 读取时由 generic-crud 解析成「联系人姓名」返回，列表/详情/导出都直接可读。
      { field: '关联联系人', table: TABLES.weilingContact.tableId, nameField: '联系人姓名' },
    ],
    statusField: '跟进状态',
    defaultStatus: '未跟进',
    // 跟进对象改为卫瓴联系人后，「关联学生」常常为空，只按它搜索会搜不到东西；
    // 补上沟通主题作为检索入口（「关联联系人」是 link 字段，存的是 id，不适合模糊匹配）
    searchFields: ['关联学生', '沟通主题'],
    sortField: '跟进时间',
  },
  {
    path: 'student-attendances',
    tableId: TABLES.attendance.tableId,
    studentMatch: { field: '关联学生编号', by: 'id' },
    readPerm: PERM_R,
    writePerm: PERM_W,
    dateFields: ['考勤日期', '到校时间', '离校时间'],
    readonly: ['班主任', '记录人', '佐证附件', '学年', '班级'],
    linkFields: [
      { field: '关联学生编号', table: TABLES.studentProfile.tableId, nameField: '学生姓名' },
      { field: '学年', table: TABLES.academicYear.tableId, nameField: '学年名称' },
      { field: '班级', table: TABLES.classLink.tableId, nameField: '班级名称' },
    ],
    statusField: '考勤状态',
    defaultStatus: '正常',
    searchField: '关联学生编号',
    sortField: '考勤日期',
  },
  {
    path: 'grades',
    tableId: TABLES.academicGrade.tableId,
    studentMatch: { field: '关联学生编号', by: 'id' },
    readPerm: PERM_R,
    writePerm: PERM_W,
    numbers: ['成绩', '满分'],
    dateFields: ['考核日期'],
    readonly: ['任课教师', '成绩附件', '学年', '课程'],
    linkFields: [
      { field: '关联学生编号', table: TABLES.studentProfile.tableId, nameField: '学生姓名' },
      { field: '学年', table: TABLES.academicYear.tableId, nameField: '学年名称' },
      { field: '课程', table: TABLES.courseLink.tableId, nameField: '学科课程名称' },
    ],
    statusField: '成绩状态',
    defaultStatus: '草稿',
    searchField: '关联学生编号',
    sortField: '考核日期',
  },
  {
    path: 'practice-activities',
    tableId: TABLES.practiceActivity.tableId,
    studentMatch: { field: '关联学生编号', by: 'id' },
    readPerm: PERM_R,
    writePerm: PERM_W,
    numbers: ['服务或参与时长'],
    dateFields: ['活动开始日期', '活动结束日期'],
    readonly: ['活动负责人', '活动证明', '关联授权'],
    linkFields: [
      { field: '关联学生编号', table: TABLES.studentProfile.tableId, nameField: '学生姓名' },
      { field: '关联授权', table: TABLES.authorization.tableId, nameField: '授权事项' },
    ],
    statusField: '安全确认状态',
    defaultStatus: '待确认',
    searchField: '活动名称',
    sortField: '活动开始日期',
  },
  {
    path: 'home-school-comms',
    tableId: TABLES.homeSchoolComm.tableId,
    studentMatch: { field: '关联学生', by: 'name' },
    readPerm: PERM_R,
    writePerm: PERM_W,
    numbers: ['沟通时长(分钟)'],
    dateFields: ['沟通时间', '跟进截止日期', '闭环日期'],
    readonly: ['待办负责人', '沟通附件', '关联学生编号', '关联监护人'],
    linkFields: [
      { field: '关联学生编号', table: TABLES.studentProfile.tableId, nameField: '学生姓名' },
      { field: '关联监护人', table: TABLES.guardian.tableId, nameField: '监护人姓名' },
    ],
    statusField: '闭环状态',
    defaultStatus: '无需跟进',
    searchField: '关联学生',
    sortField: '沟通时间',
  },
  {
    path: 'daily-followups',
    tableId: TABLES.dailyFollowup.tableId,
    studentMatch: { field: '关联学生', by: 'name' },
    readPerm: PERM_R,
    writePerm: PERM_W,
    numbers: ['沟通时长(分钟)'],
    dateFields: ['沟通时间', '跟进截止日期', '闭环日期'],
    readonly: ['待办负责人', '沟通附件'],
    statusField: '闭环状态',
    defaultStatus: '无需跟进',
    searchField: '关联学生',
    sortField: '沟通时间',
  },
  // 学生观察（2026-09-06 新增）：字段结构照搬日常跟进，新增「观察类型」单选字段。
  // 界面统一把「沟通X」显示为「观察X」，但飞书字段名保持「沟通X」，以便复用字典同步逻辑。
  {
    path: 'student-observations',
    tableId: TABLES.studentObservation.tableId,
    studentMatch: { field: '关联学生', by: 'name' },
    readPerm: PERM_R,
    writePerm: PERM_W,
    numbers: ['沟通时长(分钟)'],
    dateFields: ['沟通时间', '跟进截止日期', '闭环日期'],
    readonly: ['待办负责人', '沟通附件'],
    statusField: '闭环状态',
    defaultStatus: '无需跟进',
    searchField: '关联学生',
    sortField: '沟通时间',
  },
  {
    path: 'stage-evaluations',
    tableId: TABLES.stageEvaluation.tableId,
    studentMatch: { field: '关联学生编号', by: 'id' },
    readPerm: PERM_R,
    writePerm: PERM_W,
    dateFields: ['评价日期', '复核日期'],
    readonly: ['班主任', '是否通过', '评价人', '评价附件', '学年'],
    linkFields: [
      { field: '关联学生编号', table: TABLES.studentProfile.tableId, nameField: '学生姓名' },
      { field: '学年', table: TABLES.academicYear.tableId, nameField: '学年名称' },
    ],
    statusField: '评价完整度',
    defaultStatus: '待提交',
    searchField: '关联学生编号',
    sortField: '评价日期',
  },
  {
    path: 'alumni-followups',
    tableId: TABLES.alumniFollowup.tableId,
    studentMatch: { field: '关联学生编号', by: 'id' },
    readPerm: PERM_R,
    writePerm: PERM_W,
    dateFields: ['跟进时间', '下次跟进日期'],
    readonly: ['跟进负责人', '校友参与意愿', '跟进附件'],
    linkFields: [{ field: '关联学生编号', table: TABLES.studentProfile.tableId, nameField: '学生姓名' }],
    statusField: '跟进状态',
    defaultStatus: '待跟进',
    searchField: '关联学生编号',
    sortField: '跟进时间',
  },
  // 会议纪要（2026-09-11 新增）：组织管理域，按部门维度记录会议。
  // 与日常跟进同构（明细/总结/待办/敏感级别），但主体从「学生」换成「部门」。
  {
    path: 'meeting-minutes',
    tableId: TABLES.meetingMinutes.tableId,
    readPerm: 'department:read',
    writePerm: 'department:write',
    dateFields: ['会议时间', '开始时间', '结束时间'],
    // 时间范围筛选（前端 rangeFilters 传 from/to → listDeep 内存过滤）作用于「会议时间」
    rangeField: '会议时间',
    // 业务校验：结束时间必须晚于开始时间（create/update 时由 generic-crud 统一校验）
    timeRange: { startField: '开始时间', endField: '结束时间' },
    statusField: '状态',
    defaultStatus: '草稿',
    searchField: '会议议题',
    searchFields: ['会议议题', '部门', '会议地点', '主持人'],
    sortField: '会议时间',
  },
  // ── 开放平台（2026-09-11 新增）：外接系统应用凭证 ──
  {
    path: 'open-platform',
    tableId: TABLES.openPlatformApp.tableId,
    readPerm: 'openplatform:read',
    writePerm: 'openplatform:write',
    // ⚠️ 凭证字段：写入加密、读取掩码（前端原样回传掩码 = 不修改）
    secretFields: ['App Secret'],
    statusField: '状态',
    defaultStatus: '启用',
    searchFields: ['应用名称', '系统来源', 'App ID'],
    sortField: '更新时间',
  },
  // ── 卫瓴联系人（2026-09-11 新增）：上游同步过来的只读副本 ──
  {
    path: 'weiling-contacts',
    tableId: TABLES.weilingContact.tableId,
    readPerm: 'weiling:read',
    writePerm: 'weiling:write',
    numbers: ['互动分'],
    // 日期字段存的是毫秒时间戳（上游原始值），读取侧由前端格式化
    searchFields: ['联系人姓名', '手机号', '企业名', '备注'],
    // 创建时间范围筛选（前端 rangeFilters 传 from/to）
    // ⚠️ 卫瓴的「创建时间」是线索进入时间，不能被落库时间覆盖，否则按创建时间筛选
    // 会变成「按同步时间筛选」（所有记录挤在同步那天）。
    auditOverride: ['创建时间'],
    rangeField: '创建时间',
    sortField: '创建时间',
    // 报表「按跟进人排行」下钻：follower=跟进人姓名 → 反查其跟进过的联系人
    deepParams: ['follower'],
    deepFilter: async (row, query) => {
      const who = String(query['follower'] ?? '').trim();
      if (!who) return undefined;
      const ids = await contactIdsOfFollower(who);
      return ids.has(String(row['id'] ?? ''));
    },
  },
];

/** 系统配置表（M6 运营工作台补充）：key-value 配置，仅管理员可写 */
export const CONFIG_METAS: RecordMeta[] = [
  {
    path: 'settings',
    tableId: TABLES.systemConfig.tableId,
    readPerm: 'config:read',
    writePerm: 'config:write',
    statusField: '状态',
    defaultStatus: '启用',
    searchField: '配置键',
    searchFields: ['配置键', '配置值'],
    sortField: '分组',
  },
  {
    path: 'attendance-zones',
    tableId: TABLES.attendanceZone.tableId,
    readPerm: 'config:read',
    writePerm: 'config:write',
    numbers: ['围栏中心(纬度)', '围栏中心(经度)', '围栏半径(米)'],
    statusField: '状态',
    defaultStatus: '启用',
    searchField: '校区',
    sortField: '校区',
  },
  {
    // 微信登录用户（家长/学生通过微信小程序、家长 H5 登录的绑定记录，后台可管理）
    path: 'wechat-bindings',
    tableId: TABLES.wechatBinding.tableId,
    readPerm: 'config:read',
    writePerm: 'config:write',
    dateFields: ['绑定时间', '最近登录'],
    readonly: ['绑定时间', '最近登录'],
    statusField: '状态',
    defaultStatus: '已绑定',
    searchField: '标识',
    searchFields: ['标识', '姓名', '学号'],
    sortField: '最近登录',
  },
];

/** 审计日志表（独立模块 audit:write 权限不存在 → 仅经 AuditService 内部直写，API 只读） */
export const AUDIT_METAS: RecordMeta[] = [
  {
    path: 'audit-logs',
    tableId: TABLES.auditLog.tableId,
    readPerm: 'admin:audit',
    writePerm: 'audit:write',
    readonly: ['操作时间', '操作人', '操作类型', '业务模块', '记录标识', '摘要', '详情'],
    searchField: '业务模块',
    sortField: '操作时间',
    rangeField: '操作时间',
  },
];
