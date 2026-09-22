/** 模块目录不依赖 role/homepage，避免权限枚举与导航配置形成循环依赖。 */
export const MODULE_ACTION_LABELS = {
  enter: '进入菜单',
  read: '查看',
  create: '新增',
  update: '编辑',
  delete: '删除/归档',
  import: '导入',
  export: '导出',
  refresh: '刷新',
  transition: '状态流转',
} as const;

export type ModuleAction = keyof typeof MODULE_ACTION_LABELS;
export type ModulePermission = `module:${string}:${ModuleAction}`;
/**
 * 角色权限矩阵版本。改动「权限点目录」时必须 +1，否则存量角色不会走迁移、新权限点永远是空的。
 *
 * v3（2026-09-19）：新增**报表级**权限点（见 `REPORT_MODULE_KEYS`）——
 *   报表管理原先只有一个 `module:reports:read`，于是「能看到学生结构概览」的人
 *   必然也「能看到成绩排名、考勤、活跃时段」，角色里无法区分。
 *   迁移依据是 **`module:reports:read`**（不是裸 `report:read`）：生产实测 12 个角色
 *   都持有前者，而裸权限只剩 5 个角色还留着 —— 用裸权限做依据，
 *   Phase2~8 会在升级后**静默失去所有报表**。
 *
 * v4（2026-09-20）：新增「成绩批次」「成绩等级体系」两个模块（原先是"有接口没页面"）。
 *   🔴 迁移依据必须选**接口此刻真正在判的那个权限点**（`module:examGrades:*` /
 *      `module:markbook:*`）—— 注册模块资源后 `moduleByPath('/exam-batches')` 会命中新 key，
 *      鉴权**自动从 meta 的旧点切到新点**。若迁移不给原持有者补上，升级瞬间：
 *      ①「考试与成绩」页的批次下拉 403；②成绩册的等级体系读取失败。
 *      而这两个点恰恰是「本来就该能配的人」持有的，所以继承它们 = 零行为变化。
 *
 * v5（2026-09-21）：新增**会议室助手**（组织管理下，只读查飞书会议室可用度）。
 *   可见性口径是峰哥定的「**全员可见**」（会议室是公共资源），所以必须抬版本：
 *   继承源选 `module:meetingMinutes:read`（同属组织管理的「会议纪要」）——
 *   生产实测 10 个教职工角色（系统管理员 / 院级管理 / Phase1~8）都持有它，
 *   抬版本后一次性继承，**零手工配置**；学生 / 家长角色不持有 ⇒ 不会拿到（符合预期）。
 *   ⚠️ 「同步飞书会议室」是写动作，`legacyWrite: null` ⇒ 不继承给任何角色，
 *      只有系统管理员（`healLockedRoles()` 用代码全量权限自愈）持有。
 */
export const ROLE_PERMISSION_VERSION = 5;

/**
 * 资源「从哪个版本开始存在」。
 *
 * 🔴 每次抬 `ROLE_PERMISSION_VERSION` 且**新增了资源**时，必须在这里登记。
 *    迁移只给存量角色补「本版本引入的资源」的权限（见 `resourceKeysIntroducedAfter`），
 *    未登记的一律按 0 算（= 老资源，不进任何增量）。
 *
 * 为什么不做「全量重算」：2026-09-21 抬 v5 之前做过一次影响面核算，发现全量重算会
 *   ① 把**刻意只给两个角色**的报表点（`reportUsage`，见文件头 v3/v4 的说明）按
 *      `legacyRead = module:reports:read` 发给 12 个角色 —— **连 student / parent 都会拿到**；
 *   ② 给 6 个角色补上 AI 路由各模块的 `enter`（菜单可见性被意外放大，进得去但可能点不动）。
 *   而这两件事都不是本次交付的本意。改成增量之后，迁移的语义也变成准确的一句话：
 *   **「给存量角色补上新功能的权限」**，不碰其余任何权限。
 */
export const MODULE_RESOURCE_INTRODUCED_VERSION: Record<string, number> = {
  meetingRooms: 5,
};

/** 取 `(fromVersion, toVersion]` 区间里引入的资源 key（迁移用） */
export function resourceKeysIntroducedAfter(
  fromVersion: number,
  toVersion: number = ROLE_PERMISSION_VERSION,
): string[] {
  return Object.entries(MODULE_RESOURCE_INTRODUCED_VERSION)
    .filter(([, v]) => v > fromVersion && v <= toVersion)
    .map(([k]) => k);
}

/**
 * 报表 key → 模块 key（报表页内每张报表一个权限点）。
 *
 * 为什么单独列出来：报表不在侧边栏（侧边栏只有「报表管理」一个入口），
 * 但**用户要按报表授权**，所以每个报表在权限矩阵里占一行。
 * 前端拿它算「这张卡我能不能看」，后端拿它挡接口 —— 单一真源，不各写一份。
 *
 * ⚠️ 这**不是**导航菜单：`MODULE_RESOURCES` 里的这些条目只用于权限矩阵与鉴权，
 *    不参与 `AppShell` 的菜单渲染（菜单来自 `homepage` 配置）。
 */
export const REPORT_MODULE_KEYS = {
  overview: 'reportOverview',
  gradeFlow: 'reportGradeFlow',
  trend: 'reportTrend',
  completeness: 'reportCompleteness',
  weiling: 'reportWeiling',
  dedup: 'reportDedup',
  notes: 'reportNotes',
  activity: 'reportActivity',
  attendance: 'reportAttendance',
  examDist: 'reportExamDist',
  examGpa: 'reportExamGpa',
  // 2026-09-21 新增：跨模块的「谁在用、用了多少」汇总（学生记录 / 招生跟进 / 我的笔记 /
  // 审计日志 / 会议纪要）。**不抬 `ROLE_PERMISSION_VERSION`** —— 峰哥定的可见性是
  // 「只给系统管理员 + 院级管理，其他角色要手动勾」。若抬版本走 legacyRead 继承，
  // 会把这张卡自动发给所有持有 `module:reports:read` 的 12 个角色，与这个口径相反。
  // 系统管理员不受影响：`healLockedRoles()` 用代码里的全量权限覆盖锁定角色，自动获得。
  usage: 'reportUsage',
} as const;

export type ReportKey = keyof typeof REPORT_MODULE_KEYS;

/** 报表展示名（权限矩阵里的行名 / 报表页卡片名共用同一份，避免两处措辞漂移） */
export const REPORT_LABELS: Record<ReportKey, string> = {
  overview: '学生结构概览',
  gradeFlow: '年级升级流向',
  trend: '入学趋势',
  completeness: '档案完整度',
  weiling: '招生分析',
  dedup: '联系人去重',
  notes: '笔记统计',
  activity: '活跃时段',
  attendance: '考勤分析',
  examDist: '考试成绩分布',
  examGpa: 'GPA 与班级排名',
  usage: '使用统计',
};

export interface ModuleResource {
  /** 稳定标识：沿用 DEFAULT_NAV_MENU_CONFIG 的 key，而非接口路径。 */
  key: string;
  label: string;
  /** 主 API 路径；没有独立 API 的页面使用前端路径。 */
  path: string;
  aliases?: readonly string[];
  /** 旧服务实际校验的权限；null 表示无此操作/无可自动继承的旧权限。 */
  legacyRead: string | null;
  legacyWrite: string | null;
  /** 旧菜单权限，仅用于一次性迁移 enter，不用于运行时鉴权。 */
  menuPermission: string | null;
  actions: readonly ModuleAction[];
  /** 与旧导航一致：限制菜单入口，不替代服务端操作鉴权。 */
  adminOnly?: boolean;
  /** 特殊动作迁移条件：数组中的旧权限必须全部满足，空数组不继承。 */
  legacyActions?: Partial<Record<ModuleAction, readonly string[]>>;
  /** 是否由通用 CRUD（GenericCrudModule.registerAll）承载，具备标准 /import 批量导入端点。
   *  仅用于前端 CrudPage 自动接线导入按钮，不影响鉴权（鉴权走 module:<key>:<action>）。 */
  genericCrud?: boolean;
  /**
   * **没有自己的菜单**、但要作为某个菜单的「子行」出现在权限矩阵里时，填该菜单对应的模块 key。
   *
   * 存在的理由（2026-09-19 修）：权限矩阵的行是「**菜单 → 模块**」按菜单 key 匹配生成的，
   * 而报表页内每张报表（`reportOverview` 等）**不在侧边栏**（侧边栏只有「报表管理」一个入口）。
   * 只把权限点登记进 `MODULE_RESOURCES` 是**不够的** —— 矩阵里根本生不出那一行，
   * 于是「报表按角色授权」上线后管理员**找不到勾选的地方**，功能等于不可用。
   * 填了本字段，矩阵会在该父菜单行下面渲染成缩进的子行。
   */
  subOf?: string;
}

const READ = ['enter', 'read', 'refresh'] as const;
const CRUD = ['enter', 'read', 'create', 'update', 'delete', 'refresh'] as const;
const RECORD = [...CRUD, 'export'] as const;
const FLOW = [...RECORD, 'transition'] as const;
/** 通用 CRUD 承载的可写记录模块：在 RECORD 基础上开放批量导入（module:<key>:import）。 */
const RECORD_IMPORT = [...RECORD, 'import'] as const;

/**
 * 手工核对 homepage 菜单、API controller/service、lifecycle/idp 元数据及前端表单。
 * import 只登记现有 MarkdownField 导入，不意味着具备批量记录导入接口。
 * export 的别名使用 TABLES 的真实键，不能从菜单 key 或页面文案猜测。
 * refresh 专指重新读取 UI 数据；同步、执行等写操作属于 update/transition。
 * 第三层按钮/区块目录可独立扩展；本次不生成按钮权限。
 */
export const MODULE_RESOURCES: readonly ModuleResource[] = [
  { key: 'dashboard', label: '概览', path: '/dashboard', aliases: ['/'], legacyRead: 'student:read', legacyWrite: null, menuPermission: 'dashboard:read', actions: READ },
  { key: 'students', label: '学生档案', path: '/students', aliases: ['/export/studentProfile'], legacyRead: 'student:read', legacyWrite: 'student:write', menuPermission: 'student:read', actions: RECORD, legacyActions: { delete: ['student:archive'] } },
  { key: 'courses', label: '课程方案', path: '/course-plans', aliases: ['/courses', '/export/coursePlan'], legacyRead: 'course:read', legacyWrite: 'course:write', menuPermission: 'course:read', actions: FLOW },
  { key: 'teaching', label: '教学班级', path: '/teaching-classes', aliases: ['/enrollments', '/export/teachingClass', '/export/enrollment'], legacyRead: 'course:read', legacyWrite: 'course:write', menuPermission: 'teaching:read', actions: FLOW },
  { key: 'schedule', label: '排课课次', path: '/sessions', aliases: ['/schedule', '/export/session'], legacyRead: 'schedule:read', legacyWrite: 'schedule:write', menuPermission: 'schedule:read', actions: FLOW },
  { key: 'portal', label: '学生门户', path: '/portal', legacyRead: 'student:read', legacyWrite: 'attendance:write', menuPermission: 'portal:read', actions: [...READ, 'create'] },
  { key: 'student360', label: '学生全景', path: '/student-360', legacyRead: 'student:read', legacyWrite: null, menuPermission: 'student360:read', actions: READ },
  // lifecycle.meta.ts / idp.meta.ts 的真实 CRUD 权限均为 student:read/write。
  { key: 'sourceFollowups', label: '招生跟进', path: '/source-followups', aliases: ['/source-followups-ai', '/export/sourceFollowup'], legacyRead: 'student:read', legacyWrite: 'student:write', menuPermission: 'followup:read', actions: RECORD_IMPORT, genericCrud: true },
  { key: 'studentAttendances', label: '学生考勤', path: '/student-attendances', aliases: ['/export/attendance'], legacyRead: 'student:read', legacyWrite: 'student:write', menuPermission: 'studentattendance:read', actions: RECORD_IMPORT, genericCrud: true },
  { key: 'grades', label: '学业成绩', path: '/grades', aliases: ['/export/academicGrade'], legacyRead: 'student:read', legacyWrite: 'student:write', menuPermission: 'grade:read', actions: RECORD_IMPORT, genericCrud: true },
  { key: 'practiceActivities', label: '实践活动', path: '/practice-activities', aliases: ['/export/practiceActivity'], legacyRead: 'student:read', legacyWrite: 'student:write', menuPermission: 'activity:read', actions: RECORD_IMPORT, genericCrud: true },
  { key: 'homeSchoolComms', label: '家校沟通', path: '/home-school-comms', aliases: ['/home-school-comms-ai', '/export/homeSchoolComm'], legacyRead: 'student:read', legacyWrite: 'student:write', menuPermission: 'communication:read', actions: RECORD_IMPORT, genericCrud: true },
  { key: 'dailyFollowups', label: '日常跟进', path: '/daily-followups', aliases: ['/daily-followups-ai', '/export/dailyFollowup'], legacyRead: 'student:read', legacyWrite: 'student:write', menuPermission: 'dailyfollowup:read', actions: RECORD_IMPORT, genericCrud: true },
  { key: 'studentObservations', label: '学生观察', path: '/student-observations', aliases: ['/student-observations-ai', '/export/studentObservation'], legacyRead: 'student:read', legacyWrite: 'student:write', menuPermission: 'observation:read', actions: RECORD_IMPORT, genericCrud: true },
  // 学生记录（2026-09-18）：日常跟进 / 家校沟通 / 学生观察 三合一后的主入口。
  //
  // 🔴 判定特殊，两条都靠 `anyStudentRecordPerm`（contracts/student-records.ts）：
  //    - 接口：meta.typeScope 存在时，读权限按「任一类型模块的 read」判定；
  //    - 菜单：AppShell.canSeeItem 对 key=studentRecords 走同一判据。
  //    原因：这三个模块合并前各有权限点，角色配置里存的也是那三个；若主入口只认
  //    `module:studentRecords:read`，合并后**没有角色能进入**（生产实测 24 人的主力角色
  //    Phase1 只有 module:studentObservations:*），等于把功能藏起来。
  //    所以本资源登记的目的只是「让权限矩阵里看得见这个菜单」，不承担运行时判据。
  //    能看到哪些**类型**仍由各模块权限逐类型过滤，范围不放大。
  // legacyRead/Write 为 null：没有可继承的历史权限点（继承会变成「有 student:read 就能进」，
  // 而 student/parent 角色正是只有 student:read，那会把学生记录暴露给家长账号）。
  { key: 'studentRecords', label: '学生记录', path: '/student-records', legacyRead: null, legacyWrite: null, menuPermission: null, actions: RECORD_IMPORT, genericCrud: true },
  { key: 'meetingMinutes', label: '会议纪要', path: '/meeting-minutes', aliases: ['/export/meetingMinute'], legacyRead: 'department:read', legacyWrite: 'department:write', menuPermission: 'meeting:read', actions: RECORD_IMPORT, genericCrud: true },
  // 会议室助手（组织管理，2026-09-21 新增）：只读查飞书会议室的可用度（不接预订）。
  // 可见性「全员可见」（峰哥定）⇒ legacyRead/menuPermission 指向 `module:meetingMinutes:read`
  // （同属组织管理，10 个教职工角色持有），抬 v5 后自动继承；`legacyWrite: null` ⇒ 同步只给管理员。
  // 见文件头 v5 的说明。
  { key: 'meetingRooms', label: '会议室助手', path: '/meeting-rooms', legacyRead: 'module:meetingMinutes:read', legacyWrite: null, menuPermission: 'module:meetingMinutes:read', actions: [...READ, 'update'], genericCrud: false },
  { key: 'idpPlans', label: 'IDP管理', path: '/idp-plans', aliases: ['/idp-communications', '/export/idpPlan', '/export/idpCommunication'], legacyRead: 'student:read', legacyWrite: 'student:write', menuPermission: 'idp:read', actions: RECORD },
  { key: 'stageEvaluations', label: '阶段评价', path: '/stage-evaluations', aliases: ['/export/stageEvaluation'], legacyRead: 'student:read', legacyWrite: 'student:write', menuPermission: 'evaluation:read', actions: RECORD_IMPORT, genericCrud: true },
  { key: 'alumniFollowups', label: '校友跟进', path: '/alumni-followups', aliases: ['/export/alumniFollowup'], legacyRead: 'student:read', legacyWrite: 'student:write', menuPermission: 'alumni:read', actions: RECORD_IMPORT, genericCrud: true },
  { key: 'openPlatformApps', label: '开放平台', path: '/open-platform', legacyRead: 'openplatform:read', legacyWrite: 'openplatform:write', menuPermission: 'openplatform:read', actions: RECORD, genericCrud: true },
  // 🔴 `update` 必须声明（2026-09-21 修）：卫瓴联系人**记录**本身是只读的
  //  （不提供 create/update/delete 三个动作的写记录语义），但「同步 / 重算 / 重匹配」
  //  这类**维护动作**（weiling.controller 的 sync / sync-progress / sync-lost / match /
  //  recount-follows）判的正是 `module:weilingContacts:update`。
  //  原先 `actions: READ` 不含 update ⇒ 矩阵里**没有这一格可勾** ⇒ 这个权限点
  //  连 `PERMISSIONS` 目录都不在 ⇒ **谁都不持有（系统管理员也不持有）** ⇒
  //  联系人管理页的四个同步按钮点了必然 403（报 FORBIDDEN:module:weilingContacts:update）。
  //  声明之后：系统管理员由代码目录自愈获得，其他角色按需在矩阵里勾。
  { key: 'weilingContacts', label: '联系人管理', path: '/weiling-contacts', legacyRead: 'weiling:read', legacyWrite: 'weiling:write', menuPermission: 'weiling:read', actions: [...READ, 'update'], genericCrud: true },
  { key: 'reports', label: '报表管理', path: '/reports', legacyRead: 'report:read', legacyWrite: null, menuPermission: 'report:read', actions: READ },
  // ── 报表级权限（v3，2026-09-19）：每个报表一个权限点 ──
  //
  // 背景（峰哥要求）：报表管理原先只有一个 `module:reports:read`，
  // 于是「能看学生结构概览」的人必然也能看成绩排名、考勤、活跃时段 —— 角色里无法区分。
  //
  // 🔴 `legacyRead` 这里填的是 **`module:reports:read`**（v2 之后的模块权限点，不是裸 `report:read`）：
  //    生产实测 12 个角色**全部**持有 `module:reports:read`，而裸 `report:read` 只剩 5 个角色
  //    （含 Phase1 / student / parent）。若按裸权限迁移，Phase2~8 会在升级瞬间静默丢掉全部报表。
  //    `inheritModulePermissions` 只看「legacy.has(...)」，所以填哪个权限点就是按哪个继承。
  //
  // ⚠️ 这些条目**不是侧边栏菜单**（侧边栏只有「报表管理」一个入口）：
  //    它们只出现在权限矩阵里供勾选，菜单渲染仍走 `homepage` 配置。
  //    前端「这张报表我能不能看」用各自的 `read` 权限点判断，不要用 `enter` ——
  //    `enter` 还要过角色的菜单白名单（历史角色多数有白名单），拿它判会误杀。
  ...Object.entries(REPORT_MODULE_KEYS).map(([key, moduleKey]) => ({
    key: moduleKey,
    label: REPORT_LABELS[key as ReportKey] ?? moduleKey,
    path: `/reports?report=${key}`,
    legacyRead: 'module:reports:read',
    legacyWrite: null,
    menuPermission: null,
    actions: READ,
    // 报表没有自己的菜单 ⇒ 必须挂到「报表管理」下当子行，否则权限矩阵里看不到（见 subOf 注释）
    subOf: 'reports',
  })),
  { key: 'mailAccounts', label: '邮件账户', path: '/mail-accounts', aliases: ['/export/mailAccount'], legacyRead: 'mail:read', legacyWrite: 'mail:write', menuPermission: 'mail:write', actions: RECORD },
  { key: 'mailArchive', label: '邮件归档', path: '/mail-archive', aliases: ['/export/mailArchive'], legacyRead: 'mail:read', legacyWrite: 'mail:write', menuPermission: 'mail:read', actions: [...READ, 'update', 'export'] },
  { key: 'teachers', label: '教师档案', path: '/teachers', aliases: ['/export/teacherProfile'], legacyRead: 'teacher:read', legacyWrite: 'teacher:write', menuPermission: 'teacher:read', actions: RECORD, legacyActions: { delete: ['teacher:archive'] } },
  { key: 'attendance', label: '教师履约', path: '/attendances', aliases: ['/attendance', '/export/teacherAttendance'], legacyRead: 'attendance:read', legacyWrite: 'attendance:write', menuPermission: 'attendance:read', actions: FLOW, legacyActions: { transition: ['attendance:write', 'attendance:approve'] } },
  { key: 'billing', label: '计费结算', path: '/billing', aliases: ['/export/billingDetail'], legacyRead: 'billing:read', legacyWrite: 'billing:write', menuPermission: 'billing:read', actions: FLOW, legacyActions: { transition: ['billing:write', 'billing:confirm', 'billing:settle'] } },
  { key: 'settlements', label: '月度结算', path: '/settlements', aliases: ['/export/monthlySettlement'], legacyRead: 'billing:read', legacyWrite: 'billing:settle', menuPermission: 'settlement:read', actions: FLOW, legacyActions: { transition: ['billing:settle', 'finance:approve'] } },
  { key: 'adjustments', label: '调整冲销', path: '/adjustments', aliases: ['/export/adjustment'], legacyRead: 'finance:read', legacyWrite: 'billing:settle', menuPermission: 'adjustment:read', actions: FLOW, legacyActions: { transition: ['finance:approve'] } },
  { key: 'partnerships', label: '聘用合作', path: '/partnerships', aliases: ['/export/partnership'], legacyRead: 'partnership:read', legacyWrite: 'partnership:write', menuPermission: 'partnership:read', actions: RECORD },
  { key: 'aiChat', label: 'AI 对话', path: '/ai/chat', aliases: ['/ai/conversations'], legacyRead: 'ai:chat', legacyWrite: 'ai:chat', menuPermission: 'ai:chat', actions: CRUD },
  // 个人设置旧服务校验 ai:chat，但组织默认设置写入需 ai:config，合并动作按较严条件继承。
  { key: 'aiConfig', label: 'AI 设置', path: '/ai/config', aliases: ['/ai/presets', '/ai/org-default'], legacyRead: 'ai:chat', legacyWrite: 'ai:config', menuPermission: 'ai:config', actions: [...READ, 'update', 'delete'], legacyActions: { update: ['ai:chat', 'ai:config'], delete: ['ai:chat'] } },
  { key: 'aiAgents', label: 'Bot管理', path: '/ai/agents', aliases: ['/ai/tools'], legacyRead: 'ai:config', legacyWrite: 'ai:config', menuPermission: 'aiagent:read', actions: [...CRUD, 'import'] },
  { key: 'aiSkills', label: '技能管理', path: '/ai/skills', legacyRead: 'ai:admin', legacyWrite: 'ai:admin', menuPermission: 'aiskill:read', actions: [...READ, 'update', 'import'] },
  { key: 'aiAutomations', label: '定时任务', path: '/ai/automations', aliases: ['/ai/cron/build'], legacyRead: 'ai:automation', legacyWrite: 'ai:automation', menuPermission: 'ai:automation', actions: [...CRUD, 'transition'] },
  { key: 'aiAdmin', label: 'AI 用量', path: '/ai/admin', legacyRead: 'ai:admin', legacyWrite: null, menuPermission: 'aiusage:read', actions: READ },
  { key: 'getnote', label: '知识库', path: '/getnote', legacyRead: 'getnote:read', legacyWrite: 'getnote:write', menuPermission: 'getnote:read', actions: [...CRUD, 'import'] },
  { key: 'getnoteSources', label: '知识库配置', path: '/getnote-sources', aliases: ['/getnote/sources', '/export/getnoteSource'], legacyRead: 'getnote:read', legacyWrite: 'getnote:write', menuPermission: 'getnote:write', actions: RECORD },
  { key: 'dictionary', label: '字典数据', path: '/dictionaries', legacyRead: 'config:read', legacyWrite: 'config:write', menuPermission: 'config:read', actions: [...READ, 'update'] },
  // 数据密级（2026-09-18）：配置「哪些字段在哪个密级以下会被打码/隐藏」。
  // adminOnly —— 改密级等于改全站脱敏口径，与用户管理/角色管理同级风险。
  { key: 'dataLevels', label: '数据密级', path: '/data-levels', legacyRead: 'config:read', legacyWrite: 'config:write', menuPermission: null, actions: [...READ, 'update'], adminOnly: true },
  // 导出工作台只授予入口/查看；执行导出必须检查源模块的 export，不提供全表通行证。
  { key: 'export', label: '数据导出', path: '/export', legacyRead: 'export:run', legacyWrite: null, menuPermission: 'export:run', actions: ['enter', 'read'] },
  { key: 'audit-logs', label: '审计日志', path: '/audit-logs', aliases: ['/export/auditLog'], legacyRead: 'admin:audit', legacyWrite: null, menuPermission: null, actions: [...READ, 'export'], adminOnly: true },
  { key: 'users', label: '用户管理', path: '/users', legacyRead: 'admin:user', legacyWrite: 'admin:user', menuPermission: null, actions: [...CRUD, 'transition'], adminOnly: true },
  { key: 'permissions', label: '权限授权', path: '/auth/permissions', aliases: ['/permissions'], legacyRead: 'admin:user', legacyWrite: null, menuPermission: null, actions: READ, adminOnly: true },
  { key: 'role-management', label: '角色管理', path: '/role-management', legacyRead: 'admin:user', legacyWrite: 'admin:user', menuPermission: 'admin:user', actions: CRUD, adminOnly: true },
  { key: 'notifications', label: '通知任务', path: '/notifications', aliases: ['/export/notificationLog'], legacyRead: 'notification:read', legacyWrite: 'notification:send', menuPermission: 'notification:read', actions: [...READ, 'create', 'transition', 'export'], legacyActions: { transition: ['notification:read', 'notification:send'] } },
  { key: 'notification-templates', label: '通知模板', path: '/notifications/templates', aliases: ['/notification-templates', '/export/notificationTemplate'], legacyRead: 'notification:read', legacyWrite: 'notification:write', menuPermission: 'notification:write', actions: RECORD },
  { key: 'settings', label: '系统设置', path: '/settings', aliases: ['/export/systemConfig'], legacyRead: 'config:read', legacyWrite: 'config:write', menuPermission: null, actions: RECORD_IMPORT, adminOnly: true, genericCrud: true },
  { key: 'attendance-zones', label: '考勤围栏', path: '/attendance-zones', aliases: ['/export/attendanceZone'], legacyRead: 'config:read', legacyWrite: 'config:write', menuPermission: null, actions: RECORD_IMPORT, adminOnly: true, genericCrud: true },
  { key: 'wechat-bindings', label: '微信用户', path: '/wechat-bindings', aliases: ['/wechat-binding-actions', '/export/wechatBinding'], legacyRead: 'config:read', legacyWrite: 'config:write', menuPermission: null, actions: [...RECORD_IMPORT, 'transition'], adminOnly: true, genericCrud: true, legacyActions: { transition: ['config:write'] } },
  // 两个页面共用 homepage-config 整体读写；该 API 归登录页配置，主题页保留独立前端入口。
  { key: 'homepage-management', label: '工作台主题', path: '/homepage-management', legacyRead: null, legacyWrite: null, menuPermission: null, actions: [...READ, 'update'], adminOnly: true },
  { key: 'homepage-settings', label: '登录页配置', path: '/homepage-config', aliases: ['/homepage-settings'], legacyRead: null, legacyWrite: null, menuPermission: null, actions: [...READ, 'update'], adminOnly: true },
  { key: 'menu-settings', label: '菜单管理', path: '/homepage-config/menu', aliases: ['/menu-settings'], legacyRead: null, legacyWrite: null, menuPermission: null, actions: [...READ, 'update'], adminOnly: true },
  { key: 'menu-groups-settings', label: '菜单分组', path: '/homepage-config/menu-groups', aliases: ['/menu-groups-settings'], legacyRead: null, legacyWrite: null, menuPermission: null, actions: [...READ, 'update'], adminOnly: true },
  { key: 'note-convert', label: '转换配置', path: '/homepage-config/note-convert', aliases: ['/note-convert'], legacyRead: null, legacyWrite: null, menuPermission: null, actions: [...READ, 'update'], adminOnly: true },
  { key: 'student-users', label: '学生账号', path: '/student-auth/accounts', aliases: ['/student-users', '/student-auth/search', '/student-auth/admin/set-password'], legacyRead: 'admin:studentUser', legacyWrite: 'admin:studentUser', menuPermission: 'admin:studentUser', actions: [...READ, 'update'], adminOnly: true },

  // ── AI 路由（acapi 多租户网关移植，2026-09-12）────────────────────
  // 五张可写表用 RECORD（含批量导入导出），用量明细与操作日志只读（READ）。
  // 权限点走 module:<key>:<action> 新体系，不设 legacy 点。
  // ⚠️ path 必须与 lifecycle.meta.ts 里 RecordMeta.path 完全一致，否则鉴权会静默回退。
  { key: 'aiRouteGroups', label: 'AI 路由分组', path: '/ai-route-groups', legacyRead: 'ai:admin', legacyWrite: 'ai:admin', menuPermission: null, actions: RECORD, genericCrud: true },
  { key: 'aiUpstreams', label: 'AI 上游账号', path: '/ai-upstreams', legacyRead: 'ai:admin', legacyWrite: 'ai:admin', menuPermission: null, actions: RECORD, genericCrud: true },
  { key: 'aiModelRoutes', label: 'AI 模型路由', path: '/ai-model-routes', legacyRead: 'ai:admin', legacyWrite: 'ai:admin', menuPermission: null, actions: RECORD, genericCrud: true },
  { key: 'aiApiKeys', label: 'AI 密钥', path: '/ai-api-keys', legacyRead: 'ai:admin', legacyWrite: 'ai:admin', menuPermission: null, actions: RECORD, genericCrud: true },
  { key: 'aiUsage', label: 'AI 用量明细', path: '/ai-usage', legacyRead: 'ai:admin', legacyWrite: null, menuPermission: null, actions: READ, genericCrud: true },
  { key: 'aiOpLogs', label: 'AI 路由操作日志', path: '/ai-op-logs', legacyRead: 'ai:admin', legacyWrite: null, menuPermission: null, actions: READ, genericCrud: true },
  { key: 'aiProxies', label: 'AI 上游代理', path: '/ai-proxies', legacyRead: 'ai:admin', legacyWrite: 'ai:admin', menuPermission: null, actions: RECORD, genericCrud: true },

  // ── 教学域（参照 Gibbon v31 移植，2026-09-13）──────────────────────
  // 粒度按「一个菜单一项权限」：成绩册把等级体系/类型权重/列/条目/目标收在一个模块下，
  // 行为记录把设置/记录/跟进/告警/信件收在一个模块下，避免权限矩阵爆炸。
  // ⚠️ 这 6 个教学模块的 legacyRead/Write 统一挂 `grade:read` / `grade:write`，
  //    而不是各自语义上「更像」的权限点（课程/考勤/学生…），原因：
  //    legacy 权限体系里**没有「是不是教学侧人员」这个维度**，而「教师本人」角色只有
  //    grade:read / student:read / attendance:read / report:read 这几个 —— 若按语义拆开挂，
  //    教师能看成绩册却看不到教案与课程规划（实测预演确认过）。
  //    所以统一用 `grade:read` 作「教学侧」判据：系统管理员 / 院级管理 / 教务 /
  //    教师本人 / 学生事务 / Phase1 命中；财务、招生、HR、student、parent 不命中。
  //    要单独放宽某类人，在权限矩阵里勾对应菜单即可（每个菜单都有独立权限点）。
  { key: 'attendanceCodes', label: '考勤码', path: '/attendance-codes', legacyRead: 'grade:read', legacyWrite: 'grade:write', menuPermission: null, actions: RECORD, genericCrud: true },
  { key: 'markbook', label: '成绩册', path: '/markbook', legacyRead: 'grade:read', legacyWrite: 'grade:write', menuPermission: null, actions: RECORD, genericCrud: true },
  // 成绩类型权重（2026-09-20 补页面）：`班级 × 考核类型 → 权重`，是「列权重」之外的第二层权重。
  // ⚠️ 实际匹配用的是**「班级」文本**（markbook.service 的 configsOf），「教学班」关联字段目前不参与匹配 ——
  //    只填教学班不填班级，权重会**静默不生效**（不报错），页面提示里必须说明。
  { key: 'markbookWeights', label: '成绩类型权重', path: '/markbook-weights', legacyRead: 'module:markbook:read', legacyWrite: 'module:markbook:update', menuPermission: 'module:markbook:read', actions: RECORD, genericCrud: true },
  // 学生个人目标（2026-09-20 补页面）：`学生 × 班级 → 目标等级序号 / 目标分`。
  // 「是否达标」= 条目等级序号 ≤ 目标等级序号，没建目标就写「未设目标」（不是不达标）。
  { key: 'markbookTargets', label: '学生成绩目标', path: '/markbook-targets', legacyRead: 'module:markbook:read', legacyWrite: 'module:markbook:update', menuPermission: 'module:markbook:read', actions: RECORD, genericCrud: true },
  // 考试与成绩（2026-09-16 参照 RosarioSIS v13 Grades 移植）：期末总评 / 成绩单 / 异常审查 / 分析
  // legacyRead/Write 为 null：没有任何历史遗留权限点可继承，管理员由 healLockedRoles() 兜底，
  // 普通角色需在权限矩阵里手工授予（matrix 存的是已派生的完整权限集，不会自动补）。
  // 用 FLOW 而不是 RECORD：多一个 transition，用于「确认 / 撤销确认」这类状态流转
  // （结转、调分、写评语属于 update；导出 PDF 属于 export）。
  { key: 'examGrades', label: '考试与成绩', path: '/exam-grades', legacyRead: null, legacyWrite: null, menuPermission: null, actions: FLOW, genericCrud: true },
  // 考核类型是本模块的配置表，但作为独立页面/菜单项（与「考勤码」同一套做法）
  // 考核类型组（2026-09-20 新增容器层）：没有自己的菜单，作为 `/exam-types` 页内的左栏维护，
  // 用 aliases 把它的 API 路径纳入本模块 —— 与「成绩等级体系」把 `/grade-scale-levels`
  // 收进来的做法一致：两级配置同属一件事，分开授权会出现「能改组、改不了组里的类型」。
  { key: 'examTypes', label: '考核类型', path: '/exam-types', aliases: ['/exam-type-groups'], legacyRead: null, legacyWrite: null, menuPermission: null, actions: RECORD, genericCrud: true },
  // 成绩批次（2026-09-20 补页面）：一次期末结转的批次 —— 起止日期决定「哪些成绩册列参与结转」，
  // 舍入 / 免考 / 缺考口径与异常阈值也挂在它上面。此前只有接口没有页面（`/exam-batches` 已存在，
  // 但侧边栏没有入口），页面上只能看到「先去『成绩批次』建一个」却无处可建。
  // ⚠️ legacy 挂 `module:examGrades:*`：这两个接口在 meta 里的 readPerm/writePerm 就是它，
  //    注册模块资源后鉴权切到 `module:examBatches:*` ⇒ 继承它们才能保证升级后「考试与成绩」
  //    页里的批次下拉与结转继续可用（否则是**升级即 403**）。
  { key: 'examBatches', label: '成绩批次', path: '/exam-batches', legacyRead: 'module:examGrades:read', legacyWrite: 'module:examGrades:update', menuPermission: 'module:examGrades:read', actions: RECORD, genericCrud: true },
  // 成绩等级体系（2026-09-20 补页面）：等级体系（`gradeScale`）→ 等级（`gradeScaleLevel`，含**绩点**）。
  // 「绩点」是 GPA / 班级排名的唯一数据来源，没配就明说「未配置绩点」，不是一堆 0.00。
  // aliases 把「等级」表的 API 一并纳入本模块：两级配置同属一件事，
  // 分开授权会出现「能改体系、却改不了体系里的等级」这种半开门。
  { key: 'gradeScales', label: '成绩等级体系', path: '/grade-scales', aliases: ['/grade-scale-levels'], legacyRead: 'module:markbook:read', legacyWrite: 'module:markbook:update', menuPermission: 'module:markbook:read', actions: RECORD, genericCrud: true },
  // 常用评语库（2026-09-16）：各科老师写评语时套用的句子。独立权限点 ——
  // 它是「写评语」的生产资料，跟考试与成绩的 admin 类操作分开授权。
  { key: 'examComments', label: '常用评语库', path: '/exam-comments', legacyRead: null, legacyWrite: null, menuPermission: null, actions: RECORD, genericCrud: true },
  { key: 'behaviour', label: '行为记录', path: '/behaviour', legacyRead: 'grade:read', legacyWrite: 'grade:write', menuPermission: null, actions: RECORD, genericCrud: true },
  { key: 'curriculum', label: '课程规划', path: '/curriculum', legacyRead: 'grade:read', legacyWrite: 'grade:write', menuPermission: null, actions: RECORD, genericCrud: true },
  { key: 'lessonPlan', label: '课时教案', path: '/lesson-plans', legacyRead: 'grade:read', legacyWrite: 'grade:write', menuPermission: null, actions: RECORD, genericCrud: true },
  { key: 'learningOutcomes', label: '学习成果', path: '/learning-outcomes', legacyRead: 'grade:read', legacyWrite: 'grade:write', menuPermission: null, actions: RECORD, genericCrud: true },
  // 部门管理（组织管理，2026-09-13 补登，2026-09-14 收敛）：只读同步飞书通讯录部门树 + 部门成员，
  // 读取接口只要求登录态（部门/成员属公开组织信息），这里登记是为了**菜单可授权**：
  // 之前菜单 perm 为空 => 所有人可见、权限矩阵里管不到，现在用 module:departmentManagement:read 控制入口。
  // ⚠️ `update` 专指「同步飞书部门」这个**写动作**（部门页右上角那个按钮，会打飞书通讯录并把
  //    部门/成员快照写进本地表），不是编辑部门。它跟读取分开授权：读取全员，同步**默认只给系统管理员**
  //    （2026-09-14 之前 sync 只挂了 SessionGuard ⇒ 任何登录用户含 student/parent 都能触发，已收紧）。
  // genericCrud: false（controller 是自建的，不走通用 CRUD）。
  // ⚠️ 曾经同时登记过 `departments`（legacyRead: department:read）与 `departmentManagement` 两条
  //    同 label、同 path 的资源 ⇒ 权限矩阵里出现两个「部门管理」，授权时极易勾错；
  //    `departments` 无人持有（没有任何角色有 department:read）且无代码引用，2026-09-14 已删除。
  { key: 'departmentManagement', label: '部门管理', path: '/department-management', legacyRead: null, legacyWrite: null, menuPermission: null, actions: [...READ, 'update'], genericCrud: false },
  // 定时任务（后台管理，2026-09-22 晚新增）：维护「笔记归档到飞书云盘」这类定时任务，
  // 并能手动运行一次。任务本身走通用 CRUD（path='/scheduled-tasks'）。
  //
  // 可见性与授权口径 = **仅系统管理员**（峰哥定），三处一起表达这个意图：
  //  ① 本行 `adminOnly: true` 限制菜单入口；
  //  ② 三个 legacy 字段全为 null ⇒ **不继承给任何存量角色**；
  //  ③ 故意**不抬 `ROLE_PERMISSION_VERSION`**，也**不进 `MODULE_RESOURCE_INTRODUCED_VERSION`**。
  // 🔴 ③ 是重点：抬版本会让增量迁移按 legacyRead 把权限发给一批角色，而这里恰恰
  //    不该发给任何人（任务能改目标文件夹、能手动跑全量，而那条链路会把**未脱敏的
  //    笔记原文**写进云盘）。不抬版本的代价是"除管理员外谁都没有"—— 那正是想要的结果。
  //    `healLockedRoles()` 用代码里的全量权限覆盖锁定角色 ⇒ 系统管理员自动持有。
  // 「运行」映射到 `transition`（不是 edit）：以后若要放开给某个助理，
  //    可以单独给"能跑但改不了配置"的权限，不用连写权限一起发。
  { key: 'scheduledTasks', label: '定时任务', path: '/scheduled-tasks', legacyRead: null, legacyWrite: null, menuPermission: null, actions: [...CRUD, 'transition'], genericCrud: true, adminOnly: true },
];

/** 返回值是 Permission 的子类型，供现有 authorize/hasPermission 直接使用。 */
export function modulePermission(key: string, action: ModuleAction): ModulePermission {
  return `module:${key}:${action}`;
}

/**
 * 菜单 key（DEFAULT_NAV_MENU_CONFIG）→ 模块资源 key 的别名表。
 *
 * 历史原因，4 个菜单的 key 与 MODULE_RESOURCES.key 不一致：
 *   weiling-contacts → weilingContacts、lessonPlans → lessonPlan、
 *   department-management → departmentManagement、open-platform → openPlatformApps；
 *   aiDocs / system-monitor 没有对应模块资源，继续用菜单自身的 legacy perm 判定（见 AppShell）。
 *
 * 为什么不直接把菜单 key 改成模块 key：菜单 key 同时被 i18n（nav.*）、角色菜单白名单
 * （role menus）、侧边栏折叠状态（localStorage）、笔记转换登记表引用，改一处牵动四处；别名收口成本最低。
 *
 * 为什么必须收口：AppShell.canSeeItem 原先用 `MODULE_RESOURCES.find(r => r.key === item.key)` 找模块，
 * 找不到就退回菜单自身的 legacy perm ⇒ 这些菜单的显隐判据与后端守卫（走 module:<资源 key>:<action>）
 * **脱钩**，是「看得见却点不动」的高发区。
 */
export const MENU_KEY_ALIASES: Record<string, string> = {
  'weiling-contacts': 'weilingContacts',
  lessonPlans: 'lessonPlan',
  'department-management': 'departmentManagement',
  'open-platform': 'openPlatformApps',
};

/** 按菜单 key 找模块资源：先查别名表，再按 key 直查。找不到返回 undefined，调用方回退菜单自身的 perm。 */
export function moduleByMenuKey(menuKey: string): ModuleResource | undefined {
  const target = MENU_KEY_ALIASES[menuKey] ?? menuKey;
  return MODULE_RESOURCES.find((r) => r.key === target);
}

export const MODULE_PERMISSIONS: readonly ModulePermission[] = MODULE_RESOURCES.flatMap((resource) =>
  resource.actions.map((action) => modulePermission(resource.key, action)),
);

/** 最长路径段边界匹配；支持 API 前缀、查询串、片段和完整前端 URL，未知路径返回 undefined。 */
export function moduleByPath(path: string): ModuleResource | undefined {
  let pathname = path;
  if (/^https?:\/\//i.test(pathname)) {
    const m = /^https?:\/\/[^/]+(\/[^?#]*)/.exec(pathname);
    if (!m) return undefined;
    pathname = m[1] ?? '/';
  }
  pathname = pathname.split(/[?#]/, 1)[0] ?? '';
  if (!pathname) return undefined;
  pathname = `/${pathname.replace(/^\/+|\/+$/g, '')}`;
  pathname = pathname.replace(/^\/api\/v1(?=\/|$)/, '') || '/';
  let best: ModuleResource | undefined;
  let length = -1;
  for (const resource of MODULE_RESOURCES) {
    for (const candidate of [resource.path, ...(resource.aliases ?? [])]) {
      if (candidate.length > length && (pathname === candidate || (candidate !== '/' && pathname.startsWith(`${candidate}/`)))) {
        best = resource;
        length = candidate.length;
      }
    }
  }
  return best;
}
