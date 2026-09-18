/**
 * 学生全生命周期域（M1 招生与学生）的 7 张飞书表的元数据。
 * 字段名严格对应飞书实际字段（通过 listFields 核对）。
 *  - numbers:    数值字段（写入时强转 number）
 *  - dateFields: 日期字段（写入时字符串→毫秒时间戳，读取时→本地日期字符串）
 *  - readonly:   不可写字段（人员/附件/多选/勾选），避免飞书类型校验失败
 *  - statusField/ defaultStatus: 状态展示与新建默认
 */
import { TABLES, USER_TABLE } from '@acms/contracts';
// 「学生记录」三合一（2026-09-18）：类型字段名与「类型值 → 模块 key」映射都取自契约，
// 与前端 / 权限判定共用同一份，避免两边各写一套枚举导致漂移。
import { STUDENT_RECORD_TYPE_FIELD, STUDENT_RECORD_TYPE_TO_MODULE } from '@acms/contracts';
import { scheduleStateOf } from '../ai-route/schedule-state.js';
import type { RecordMeta } from './generic-crud.module.js';
import { getSqlStore } from '../base.provider.js';
// 会议纪要的「可见范围」判据（纯函数模块，只被本文件的 rowScope / defaults 调用）
import {
  MEETING_SCOPE_BYPASS_ROLES,
  meetingDefaults,
  meetingRowScope,
} from '../meeting-minutes/meeting-visibility.js';

const PERM_R = 'student:read';
const PERM_W = 'student:write';

/**
 * 「学生记录」的类型域配置：类型字段 → 类型值到模块 key 的映射。
 *
 * 用户能看/能写哪些**类型**，由各类型模块的 `module:<key>:<read|write>` 权限决定；
 * 一个角色的配置都不用改（合并前它们就持有各自的模块权限）。
 */
const STUDENT_RECORD_TYPE_SCOPE: NonNullable<RecordMeta['typeScope']> = {
  field: STUDENT_RECORD_TYPE_FIELD,
  typeModules: STUDENT_RECORD_TYPE_TO_MODULE,
  // 缺省类型 = 主表（日常跟进表）的原义。用于给「未打类型的历史记录」兜底 ——
  // 没有它，任何漏打类型的记录会对所有人静默消失。
  defaultType: '日常跟进',
};

/**
 * 「学生记录」四个入口共用的表定义（表 = 日常跟进表，三合一后的唯一物理表）。
 *
 * 字段取三个模块的**并集**：
 *   - readonly 新增「关联学生编号 / 关联监护人」两个关联字段（来自家校沟通）
 *   - linkFields 使详情页能把它们解析成可读名
 *   - 「家长 / 家长反馈态度 / 家长反馈 / 观察类型」四个专有字段**不在 readonly 里**
 *     （它们是可写的业务字段），由前端按「记录类型」动态显隐
 */
const STUDENT_RECORD_BASE: Omit<RecordMeta, 'path'> = {
  tableId: TABLES.dailyFollowup.tableId,
  studentMatch: { field: '关联学生', by: 'name' },
  studentScoped: true,
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
  typeScope: STUDENT_RECORD_TYPE_SCOPE,
};

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
    studentScoped: true,
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
    studentScoped: true,
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
    studentScoped: true,
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
  // ── 学生记录（2026-09-18）：日常跟进 / 家校沟通 / 学生观察 三表合一 ────────────
  //
  // 合并依据（都在本文件里看得到）：三者的 numbers / dateFields / readonly / statusField /
  // defaultStatus / searchField / sortField 逐字相同，dict.data.ts 共用同一批字典，
  // homepage.ts 的笔记转出字段映射也完全一致 —— 它们本来就是「同一张表的三个视图」。
  //
  // 合并后：**表 = 沿用「日常跟进表」** + 一个「记录类型」单选字段区分三类记录；
  //         **权限 = 各自模块的权限点原样保留**（角色配置一个字都不用改），
  //         由 typeScope 逐类型过滤（读见 generic-crud.rowScopeFor，写见 resolveWriteType）。
  //
  // ⚠️ 四个 path 指向**同一张表**是有意的，不是重复登记：
  //   student-records        主入口（前端页面用它）
  //   daily-followups        兼容入口（旧 URL / 书签 / 外部集成不失效）
  //   home-school-comms      兼容入口，create 时 defaults 打「家校沟通」
  //   student-observations   兼容入口，create 时 defaults 打「学生观察」
  //   四个入口共用同一份 typeScope，所以谁都不会绕过类型权限；返回内容也一律按
  //   「用户有权持有的类型」过滤，不会出现「用家校沟通的权限看到日常跟进的记录」。
  {
    path: 'student-records',
    defaults: { [STUDENT_RECORD_TYPE_FIELD]: '日常跟进' },
    ...STUDENT_RECORD_BASE,
  },
  {
    path: 'daily-followups',
    defaults: { [STUDENT_RECORD_TYPE_FIELD]: '日常跟进' },
    ...STUDENT_RECORD_BASE,
  },
  {
    path: 'home-school-comms',
    defaults: { [STUDENT_RECORD_TYPE_FIELD]: '家校沟通' },
    ...STUDENT_RECORD_BASE,
  },
  {
    path: 'student-observations',
    defaults: { [STUDENT_RECORD_TYPE_FIELD]: '学生观察' },
    ...STUDENT_RECORD_BASE,
  },
  {
    path: 'stage-evaluations',
    tableId: TABLES.stageEvaluation.tableId,
    studentMatch: { field: '关联学生编号', by: 'id' },
    studentScoped: true,
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
    /**
     * 🔴 行级可见范围（2026-09-17 新增）。
     *
     * 四条分支（公开 / 部门内可见 / 指定用户可见 / 仅自己可见）全部在
     * `meeting-visibility.ts` 的 `meetingRowScope()` 里，这里只做接线 ——
     * 判据写两处必然漂移。
     *
     * 覆盖范围：list / listDeep / detail / exportCsv / 内存深筛都走 `rowScopeFor()`；
     * `update` / `archive` / `transition` 会先调 `detail()`，因此自动受保护。
     */
    rowScope: (user, ctx) => meetingRowScope(user, ctx),
    /** 系统管理员 + 院级管理（= 需求里的「公司最高领导人」）豁免，看全部 */
    rowScopeBypassRoles: [...MEETING_SCOPE_BYPASS_ROLES],
    /**
     * 「创建人ID」是判据用的**冗余字段**（存 openId）。
     *
     * 为什么必须冗余：rowScope 的条件只能落在 jsonb 上（`data->>'X'`），
     * **物理列 `created_by` 不参与过滤** —— 若判据直接读物理列，SQL 路径不产生条件（等于不限制），
     * 只有内存路径生效，结果就是「列表看到全部、详情却 404」的越权。
     *
     * 为什么可以用冗余：创建人一旦建立就**不会再变**，所以只有 `create` 需要写它，
     * 而引擎恰好只在 create 提供 `defaults` 钩子（update 没有）—— 刚好避开这个限制。
     *
     * 登记在 readonly 里：写入侧会被剔除（防止有人改创建人来「认领」别人的纪要），
     * 读取侧不受影响（`toFlatRecord` 对 readonly 与普通字段同样处理）。
     */
    defaults: (fields, user, ctx) => meetingDefaults(fields, user, ctx),
    readonly: ['创建人ID'],
    /**
     * 多值字段：不登记的话数组会被当**字符串**写入（关联字段的经典坑）。
     * 「可见用户 / 可见部门」服务于权限判据；参会 / 缺席 / 列席是业务字段（多选人员，存姓名数组）。
     */
    multi: ['可见用户', '可见部门', '参会人员', '缺席人员', '列席人员'],
    /**
     * 关联字段：读取时会额外注入 `<字段>__link`（原始 id 数组）供前端回显多选，
     * 并把展示值解析成可读名（用户 → 姓名、部门 → 部门名）。
     * ⚠️ 部门表的 recordId 就是 open_department_id（建表时 `createWithId(open_department_id)`），
     *    所以「可见部门」的 link 值直接就是判据用的那个 id，不需要再转换。
     *
     * 🔴 参会 / 缺席 / 列席**不要**登记在这里：它们存的是**姓名**（与单选的「主持人」同口径），
     *    不需要解析成可读名。而 `toFlatRecord` 里 linkFields 分支**优先于** multi 分支，
     *    一旦登记进去，读出来就变成「张三、李四」这种拼接字符串而不是数组，
     *    前端回显与后续比较全都要跟着做字符串拆分（实测踩过一次）。只登记 multi 即可。
     */
    linkFields: [
      { field: '可见用户', table: USER_TABLE.tableId, nameField: '姓名' },
      { field: '可见部门', table: TABLES.departments.tableId, nameField: 'name' },
    ],
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
    // 去重报表的统计卡下钻（`?dedup=strong|likely|all|mergeable`）。
    // 「是否重复」由 reports/contact-dedup 当场算出，不是本表的字段 —— 只有这张表
    // 对应那个报表，所以只在这里打开（别的表开了会静默失效）。
    dedupParams: true,
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

/**
 * ── AI 路由（从 acapi 多租户网关移植，2026-09-12）────────────────────
 * 六张自建 SQL 表，启动期由 AiRouteModule 幂等建表。
 * 通用 CRUD 只覆盖「管理面」；真正的转发在 ai-gateway.controller（/v1/*，独立路径）。
 *
 * ⚠️ 两张表故意全字段只读：
 *  - ai-api-keys：密钥只能经专用接口代发/吊销。记录 id **就是密钥的 SHA-256 哈希**
 *    （靠主键保证唯一 + 校验 O(1)），走通用 CRUD 的新增会生成随机 id，破坏这个不变量。
 *  - ai-usage / ai-op-logs：由网关与日志服务写入，页面只读。
 */
export const AI_ROUTE_METAS: RecordMeta[] = [
  {
    path: 'ai-route-groups',
    tableId: TABLES.aiRouteGroup.tableId,
    // readPerm/writePerm 只是「模块资源未命中」时的回退值；这里直接写模块权限点，
    // 两条路径判定完全一致，不会出现「回退时偷偷放行」
    readPerm: 'module:aiRouteGroups:read',
    writePerm: 'module:aiRouteGroups:update',
    // 三级限额（日/周/月，USD）：对齐 sub2api，0 或空表示该档不限
    numbers: [
      '价格倍率', 'RPM上限', '并发上限',
      '日限额USD', '周限额USD', '月配额USD',
      '今日已用USD', '本周已用USD', '本月已用USD',
      '高峰倍率', '最低毛利率', '安全缓冲', '默认有效期天数', '显示排序',
    ],
    multi: ['可用模型'],
    statusField: '状态',
    defaultStatus: '启用',
    searchField: '名称',
    sortField: '显示排序',
  },
  {
    path: 'ai-upstreams',
    tableId: TABLES.aiUpstream.tableId,
    readPerm: 'module:aiUpstreams:read',
    writePerm: 'module:aiUpstreams:update',
    numbers: [
      '权重', '优先级', '连续失败次数',
      '并发上限', '负载因子', '账号成本倍率', '当前并发',
      // 账号级额度（日 / 月两级，0 或空 = 该档不限）
      '日额度USD', '月额度USD', '今日已用USD', '本月已用USD',
      // 今日统计（网关累加，按「统计日」跨天归零）
      '今日调用数', '今日Token',
    ],
    // 一个上游账号可以同时服务多个分组（对齐 sub2api 的 account_groups 多对多）：
    // 比如公司的 Claude 企业 key 同时给「招生组」「教学组」用。
    //
    // 模型限制拆成两个**独立**字段（不像 sub2api 那样二选一）：
    //  - 模型白名单 = 准入闸门，配了就只有命中（支持 `xxx*` 尾部通配）的逻辑模型能走这个账号
    //  - 模型映射   = 改名表，「请求模型 → 上游实际模型」，支持 `gpt-4o-* => gpt-4o` 这类通配
    // 两者可同时生效：先过白名单，再按映射改上游模型名。
    multi: [
      '可用模型', '所属分组', '模型白名单', '模型映射',
      // 临时不可调度规则：每条形如 `错误码|关键词|时长分钟|描述`，命中即摘除
      '临时不可调度规则',
    ],
    // 上游厂商密钥：AES-256-GCM 加密落库，读取一律回显掩码；
    // 要看明文走专用接口（会记操作日志），列表/导出/详情都拿不到明文。
    secretFields: ['凭证'],
    linkFields: [
      { field: '所属分组', table: TABLES.aiRouteGroup.tableId, nameField: '名称' },
      { field: '代理', table: TABLES.aiProxy.tableId, nameField: '名称' },
    ],
    // 调度状态机（对齐 sub2api）：限流/过载/临时不可调度都是「到期自动恢复」，
    // 不需要人工解锁 —— 网关收到 429/529/401 时写入，判断时只要看有没有到期。
    dateFields: [
      '最后检查时间', '限流解除时间', '过载解除时间', '临时不可调度解除时间',
      '过期时间', '最近使用时间',
    ],
    // 由系统写入（网关累加 / 每分钟刷新），表单里不出现
    readonly: [
      '当前并发', '今日已用USD', '本月已用USD', '统计日', '用量月份',
      '今日调用数', '今日Token', '最近使用时间',
      '调度状态', '最后失败信息', '连续失败次数',
      '限流解除时间', '过载解除时间', '临时不可调度解除时间',
    ],
    statusField: '状态',
    defaultStatus: '启用',
    // 新建即给系统字段一个初始值：否则「调度状态」要等下一次每分钟刷新才有值，
    // 期间列表显示空白、按状态筛选也筛不到这条新记录。
    defaults: (f) => {
      // 注意 可调度 / 过期自动暂停 / 账号成本倍率 自己也是默认值，要先合并出「最终形态」
      // 再据此推导「调度状态」—— 否则用户显式停调时，调度状态会被写成「可调度」。
      const base = {
        可调度: f['可调度'] ?? '是',
        过期自动暂停: f['过期自动暂停'] ?? '是',
        账号成本倍率: f['账号成本倍率'] ?? 1,
        健康状态: '正常',
      };
      return { ...base, 调度状态: scheduleStateOf({ ...f, ...base }) };
    },
    searchFields: ['名称', 'BaseURL', '备注'],
    sortField: '更新时间',
    /**
     * 「所属分组」是多值字段（jsonb 里是数组），等值筛选必然筛空 —— 走内存过滤。
     * 前端传 `所属分组__has=<分组 record id>`，由 listDeep 的成员包含逻辑处理。
     */
    deepParams: ['所属分组'],
  },
  {
    path: 'ai-model-routes',
    tableId: TABLES.aiModelRoute.tableId,
    readPerm: 'module:aiModelRoutes:read',
    writePerm: 'module:aiModelRoutes:update',
    numbers: ['优先级', '权重'],
    // 逻辑模型 → 某上游账号上的实际模型名；同一组合的唯一性在 service 层校验
    linkFields: [{ field: '上游账号', table: TABLES.aiUpstream.tableId, nameField: '名称' }],
    statusField: '状态',
    defaultStatus: '启用',
    searchFields: ['逻辑模型', '上游模型'],
    sortField: '更新时间',
  },
  {
    path: 'ai-api-keys',
    tableId: TABLES.aiApiKey.tableId,
    readPerm: 'module:aiApiKeys:read',
    writePerm: 'module:aiApiKeys:update',
    // 新建只能走 /ai-api-keys/mint（记录 id 必须是哈希，通用新增会生成随机 id）；
    // 已有的密钥允许改「名称 / 额度 / IP 白名单 / 有效期 / 状态」，其余是生成结果或系统累加值，只读。
    readonly: ['密钥前缀', '所属用户', '所属分组', '已用额度USD', '本月已用USD', '最后使用时间'],
    numbers: ['配额USD', '已用额度USD', '本月已用USD'],
    multi: ['IP白名单'],
    linkFields: [
      { field: '所属用户', table: USER_TABLE.tableId, nameField: '姓名' },
      { field: '所属分组', table: TABLES.aiRouteGroup.tableId, nameField: '名称' },
    ],
    dateFields: ['过期时间', '最后使用时间'],
    statusField: '状态',
    searchFields: ['名称', '密钥前缀'],
    sortField: '更新时间',
  },
  {
    path: 'ai-usage',
    tableId: TABLES.aiUsage.tableId,
    readPerm: 'module:aiUsage:read',
    writePerm: 'module:aiUsage:update',
    readonly: [
      '密钥名称', '所属用户', '所属分组', '上游账号', '上游账号ID', '上游请求ID',
      '逻辑模型', '上游模型',
      '输入Token', '输出Token', '总Token', '成本USD', '耗时ms', '状态', '错误信息', '客户端IP', '接口', '调用时间',
    ],
    numbers: ['输入Token', '输出Token', '总Token', '成本USD', '耗时ms'],
    dateFields: ['调用时间'],
    // 「调用时间」是网关写入的业务时间，必须优先于审计落库时间
    auditOverride: ['调用时间'],
    statusField: '状态',
    searchFields: ['逻辑模型', '上游模型', '密钥名称'],
    sortField: '调用时间',
    rangeField: '调用时间',
  },
  {
    path: 'ai-op-logs',
    tableId: TABLES.aiOpLog.tableId,
    readPerm: 'module:aiOpLogs:read',
    writePerm: 'module:aiOpLogs:update',
    readonly: ['操作人', '动作', '对象类型', '对象名称', '详情', '客户端IP', '操作时间'],
    dateFields: ['操作时间'],
    auditOverride: ['操作时间'],
    searchField: '对象名称',
    sortField: '操作时间',
    rangeField: '操作时间',
  },
];

/** AI 上游代理：国内直连不了境外 API 时用；记录 id 自增，密码走 secretFields 加密 */
AI_ROUTE_METAS.push({
  path: 'ai-proxies',
  tableId: TABLES.aiProxy.tableId,
  readPerm: 'module:aiProxies:read',
  writePerm: 'module:aiProxies:update',
  numbers: ['端口', '到期提醒天数'],
  secretFields: ['密码'],
  linkFields: [{ field: '备用代理', table: TABLES.aiProxy.tableId, nameField: '名称' }],
  dateFields: ['到期时间'],
  statusField: '状态',
  defaultStatus: '启用',
  searchField: '名称',
  sortField: '更新时间',
});

/**
 * ── 教学域配置（参照 GibbonEdu/core v31 移植，2026-09-13）─────────────
 *
 * 这一组是「可配置的口径」而不是硬编码枚举 —— 考勤结果、成绩等级体系、
 * 考核类型权重全都落到表里，将来改口径不用改代码：
 *   · 以前「出勤/迟到/早退/事假/病假/缺勤/校内活动」是写死在前端 columns.tsx 的，
 *     现在改成考勤码表，还能用「可预填 / 计入统计」两个开关控制口径。
 *   · 成绩等级体系（A-F / 优秀良好 / 百分制）以前也是写死的，现在可配，
 *     并靠「序号越小越好」支持达标判定（与 Gibbon 一致）。
 *
 * 需要专用逻辑的部分（加权汇总、二维录入、告警重算、单元部署）不在通用 CRUD 里，
 * 见 markbook / behaviour / curriculum 三个模块。
 */
export const TEACHING_CONFIG_METAS: RecordMeta[] = [
  {
    path: 'attendance-codes',
    tableId: TABLES.attendanceCode.tableId,
    readPerm: 'module:attendanceCodes:read',
    writePerm: 'module:attendanceCodes:update',
    // 方向（在校/不在校）是统计主判定轴；语义范围（在校/在校-迟到/离校/离校-提前）
    // 决定出勤率口径与显示颜色。⚠️ 简写一旦被历史记录引用过就不要再改。
    numbers: ['排序'],
    statusField: '状态',
    defaultStatus: '启用',
    searchField: '名称',
    sortField: '排序',
  },
  {
    path: 'grade-scales',
    tableId: TABLES.gradeScale.tableId,
    // 等级体系与类型权重都算成绩册的配置，共用 markbook 权限点
    readPerm: 'module:markbook:read',
    writePerm: 'module:markbook:update',
    // 「达标线」存等级序号（越小越好，1 为最好）—— 注意达标判定是「序号 ≤ 达标线」，
    // 与直觉的「分数 ≥ 及格线」相反，前端提示里要写清楚。
    numbers: ['排序'],
    statusField: '状态',
    defaultStatus: '启用',
    searchField: '名称',
    sortField: '排序',
  },
  {
    path: 'grade-scale-levels',
    tableId: TABLES.gradeScaleLevel.tableId,
    readPerm: 'module:markbook:read',
    writePerm: 'module:markbook:update',
    numbers: ['序号'],
    linkFields: [{ field: '所属体系', table: TABLES.gradeScale.tableId, nameField: '名称' }],
    searchField: '显示值',
    sortField: '序号',
  },
  {
    path: 'markbook-weights',
    tableId: TABLES.markbookWeight.tableId,
    readPerm: 'module:markbook:read',
    writePerm: 'module:markbook:update',
    // 第二层权重：与成绩册列上的「列权重」相乘。
    // ⚠️ 汇总口径是「分母 = 实际参与项的权重和」（自归一化），
    // 不要要求各类型权重合计 100 —— 那样会在只录了部分考核时算错。
    numbers: ['权重'],
    linkFields: [{ field: '教学班', table: TABLES.teachingClass.tableId, nameField: '教学班名称' }],
    searchField: '类型',
    sortField: '更新时间',
  },
  {
    path: 'exam-comments',
    tableId: TABLES.examComment.tableId,
    readPerm: 'module:examComments:read',
    writePerm: 'module:examComments:update',
    /**
     * 常用评语库（2026-09-16）：各科老师写评语时一键套用。
     * 「科目」留空 = 通用（任何科目都能套）；填了就只在该科目的评语页出现。
     * 建表由 `ExamGradeService.ensureTables()` 负责（配置表归使用它的模块）。
     */
    numbers: ['排序'],
    statusField: '状态',
    defaultStatus: '启用',
    searchFields: ['评语内容', '科目', '标签'],
    sortField: '排序',
  },
];
