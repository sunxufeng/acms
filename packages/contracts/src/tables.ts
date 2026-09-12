/** 飞书 Base 表注册（DEV base RIAgbQsrfa7EJdslDnkcdAuanyd，2026-08-25 重映射） */
export const TABLES = {
  studentProfile: { tableId: 'tblyFIfe58IjxT4K', name: '学生档案表' },
  sourceFollowup: { tableId: 'tblagWpUSFB9SPIw', name: '生源跟进记录表' },
  attendance: { tableId: 'tblYnSI1HE4E4eIS', name: '考勤记录表' },
  academicGrade: { tableId: 'tblLl9S63reX8gcU', name: '学业成绩表' },
  practiceActivity: { tableId: 'tblSydXiQcpUdZ6i', name: '实践活动表' },
  homeSchoolComm: { tableId: 'tbl9eA6kF1DFQkI1', name: '家校沟通表' },
  dailyFollowup: { tableId: 'tblFVUnzdEWLvPeh', name: '日常跟进表' },
  // 学生观察（2026-09-06 新增）：字段结构照搬「日常跟进表」18 字段 + 新增「观察类型」单选。
  // ⚠️ 只在生产 Base 存在，无 DEV 版本；建表脚本 scripts/setup_student_observation_table.mjs（幂等）。
  // 界面上统一把「沟通X」显示为「观察X」，但飞书字段名保持「沟通X」，以便复用字典同步逻辑。
  studentObservation: { tableId: 'tblDtqXu3yXLp56l', name: '学生观察表' },
  stageEvaluation: { tableId: 'tblNa4YeCzQiKXxy', name: '阶段评价表' },
  alumniFollowup: { tableId: 'tblXiV5eN9Qr07jU', name: '校友长期跟进表' },
  // M2 教学域
  teacherProfile: { tableId: 'tbll7G6Ye0UCTaZs', name: '教师档案表' },
  coursePlan: { tableId: 'tblXovizOeIXE8av', name: '课程方案表' },
  teachingClass: { tableId: 'tblcdt6QJDZzRRI6', name: '教学班表' },
  venue: { tableId: 'tblFGKbSQ68tgnTo', name: '场地资源表' },
  session: { tableId: 'tblEEmx3fy9EvWlY', name: '课次排课表' },
  enrollment: { tableId: 'tblVyhkzNTBcxWEY', name: '学生修读关系表' },
  // M3 教师履约与计费财务
  teacherAttendance: { tableId: 'tblKB4ZwrxrWmDpT', name: '教师履约记录表' },
  partnership: { tableId: 'tblmWvk2K0BaMPlI', name: '聘用合作关系表' },
  billingDetail: { tableId: 'tblRQyFz5whzd8uV', name: '计费明细表' },
  monthlySettlement: { tableId: 'tblXk3ezWN16NHNq', name: '月度结算表' },
  adjustment: { tableId: 'tblC0LG1u99eh63J', name: '调整冲销表' },
  // M4 通知闭环
  notificationTemplate: { tableId: 'tblWkJ9kDY6lb0td', name: '通知模板表' },
  notificationLog: { tableId: 'tbl82657kmkUnZ4r', name: '通知记录表' },
  // 系统配置
  systemConfig: { tableId: 'tblvBrRCWO65L6Yg', name: '系统配置表' },
  // 考勤围栏（GPS/ WiFi 打卡区域配置，见 docs/student-portal-plan.md §7）
  attendanceZone: { tableId: 'tblsNY74wMqmg5Ry', name: '考勤围栏表' },
  // 审计日志
  auditLog: { tableId: 'tblDqovZWWuA7f0Q', name: '审计日志表' },
  // 微信登录用户（家长/学生通过微信小程序、家长 H5 登录的绑定记录，后台可管理）
  wechatBinding: { tableId: 'tblP8aLCQ1qgvwnT', name: '微信登录用户表' },
  // 邮件自动归档：账户配置 + 归档记录（2026-08-28 新建）
  mailAccount: { tableId: 'tbl1hfl00NnE53aq', name: '邮件账户表' },
  mailArchive: { tableId: 'tblp0P9XVJZSfi3f', name: '邮件归档表' },
  // IDP 管理（2026-08-24 按 doc 精确字段重建）
  idpPlan: { tableId: 'tblMs4DTUTk0QgT5', name: 'IDP方案' },
  idpCommunication: { tableId: 'tbluU16XfgJJh3Rf', name: 'IDP沟通记录' },
  // 生命周期域关联目标表（link 字段跨表解析用，2026-08-17 经 listFields 核对）
  academicYear: { tableId: 'tblp9jbG7WMw609S', name: '学年表' },
  classLink: { tableId: 'tblsgoryRptizqBL', name: '班级表' },
  courseLink: { tableId: 'tblfDfwVKsPEFQcn', name: '学科课程表' },
  authorization: { tableId: 'tblUiDLO215YeT8C', name: '授权事项表' },
  guardian: { tableId: 'tbl0snrN3h2XXlZg', name: '监护人表' },
  // 得到大脑（Get笔记）笔记 ↔ 业务实体 关联映射（2026-09-04 生产新建）
  // ⚠️ 这张表只在生产 Base 存在，没有 DEV 版本，所以代码内直接登记生产表 ID ——
  //    TABLE_ID_MAP 未配置该 key 时原样返回，无需额外映射。
  noteLink: { tableId: 'tblwLvYxzXl0UFIM', name: '笔记关联' },
  // 知识库配置：笔记来源 × 收取频率 × 凭证 的全局配置表（2026-09-05 生产建表）
  // ⚠️ 只在生产 Base 存在，无 DEV 版本；建表脚本 scripts/setup_getnote_source_table.mjs（幂等）。
  getnoteSource: { tableId: 'tblmKQtZ5IOgyhv6', name: '知识库配置' },
  // 笔记转换记录：「我的笔记 → 业务模块」的留痕表（2026-09-06 生产建表）
  // 为什么不用 Get笔记 标签留痕：上游硬限制「单篇笔记最多 5 个标签」，而 system + ai
  // 标签往往已占掉 4 个 —— 一篇笔记只能成功留痕一个模块，之后转换全部静默失败。
  // 所以留痕落在 ACMS 自己这张表里，顺带能记录「转成了哪条业务记录」。
  // ⚠️ 只在生产 Base 存在，无 DEV 版本；建表脚本 scripts/setup_note_convert_log_table.mjs（幂等）。
  noteConvertLog: { tableId: 'tblMy5LrwR3YbLxf', name: '笔记转换记录' },
  // 笔记配置映射：笔记 ↔ 知识库配置 的归属表（2026-09-07 生产建表）
  // 为什么需要：Get笔记 的 note 对象里**没有任何字段**能标识它属于哪个配置 ——
  // 实测 14 条笔记的 source 全是 "app"（平台自己的来源标识，指手机 App 录音），
  // note_type 全是 recorder_audio，tags 里也没有配置名。归属只能由 ACMS 侧建立：
  // 自动同步时（SourcesService.processNote）写入，历史笔记用
  // scripts/backfill_note_config_map.mjs 补。
  // ⚠️ 只在生产 Base 存在，无 DEV 版本；建表脚本 scripts/setup_note_config_map_table.mjs（幂等）。
  noteConfigMap: { tableId: 'tbleFsIxXwZckVB8', name: '笔记配置映射' },
  // 部门表（组织管理 / 部门管理，2026-09-10 新增）：只读同步飞书通讯录部门树。
  // 这是 ACMS 自建 SQL 表（不走飞书 Base），建表用 SqlStore.ensureTable 幂等首建 t_tbldept0000001。
  // ⚠️ 合成 tableId，仅本地使用，无需 TABLE_ID_MAP 映射；记录 id = 飞书 open_department_id。
  departments: { tableId: 'tbldept0000001', name: '部门表' },
  // 会议纪要表（组织管理 / 会议纪要，2026-09-11 新增）：会议记录与总结，关联部门（存部门名）。
  // 与部门表同为该校自建 SQL 表（不走飞书 Base），由 SqlStore.ensureTable 幂等首建 t_tblmtg0000000001。
  // ⚠️ 合成 tableId，仅本地使用，无需 TABLE_ID_MAP 映射。
  meetingMinutes: { tableId: 'tblmtg0000000001', name: '会议纪要表' },
  // 登录日志表（2026-09-11 新增）：统计「谁在什么时间用了系统」。
  // 会话只在 Redis（1 小时过期、不落库），没有任何可回溯的登录记录，
  // 所以这里自建一张 SQL 表，由 SessionService.create 成功后 fire-and-forget 写入。
  // ⚠️ 合成 tableId，仅本地使用，无需 TABLE_ID_MAP 映射。
  loginLog: { tableId: 'tbllogin000000001', name: '登录日志表' },
  // 笔记快照表（2026-09-11 新增）：笔记本体在 Get笔记 外部 API（每次实时拉、QPS 2），
  // 无法直接做时间段统计。这里把管理员聚合到的笔记落一份，供「笔记统计报表」查本地。
  // ⚠️ 不额外消耗上游额度：复用已经拉到的管理员快照，fire-and-forget 写入。
  // 记录 id = 笔记 ID（上游 note_id）。
  noteSnapshot: { tableId: 'tblnotesnap000001', name: '笔记快照表' },
  /** 开放平台：外接系统的应用凭证（App ID / App Secret）。自建 SQL 表，启动期幂等建表。 */
  openPlatformApp: { tableId: 'tblopenapp000001', name: '开放平台应用表' },
  /** 卫瓴SCRM 联系人（从开放平台同步过来的只读副本） */
  weilingContact: { tableId: 'tblwlcontact0001', name: '卫瓴联系人表' },
  /** 卫瓴SCRM 对象字段描述缓存（api_name → 中文名 + 枚举选项） */
  weilingField: { tableId: 'tblwlfield000001', name: '卫瓴字段描述表' },
  /** 卫瓴跟进记录（按联系人同步，附在联系人详情里展示） */
  weilingProgress: { tableId: 'tblwlprogress0001', name: '卫瓴跟进记录表' },

  // ── AI 路由（从 acapi 多租户网关移植，2026-09-12）─────────────────
  // 自建 SQL 表，启动期幂等建表。六张表构成一条链路：
  //   分组（上游池 + 倍率 + 配额）→ 上游账号（真实 key）→ 模型路由（逻辑模型 → 上游模型）
  //   → API 密钥（发给使用方，绑定分组）→ 用量明细（每次调用一条）→ 操作日志（管理动作留痕）
  /** AI 路由分组：一组上游账号的集合，决定价格倍率、RPM/并发上限、月配额、可用模型 */
  aiRouteGroup: { tableId: 'tblairgroup000001', name: 'AI路由分组表' },
  /** AI 上游账号：真实的厂商账号（含加密存储的 key） */
  aiUpstream: { tableId: 'tblairupstream001', name: 'AI上游账号表' },
  /** AI 模型路由：逻辑模型名 → 某上游账号上的实际模型名 */
  aiModelRoute: { tableId: 'tblairroute000001', name: 'AI模型路由表' },
  /** AI 密钥：发给使用方的密钥。⚠️ 记录 id 就是密钥的 SHA-256 哈希（主键天然唯一，校验 O(1)） */
  aiApiKey: { tableId: 'tblairkey00000001', name: 'AI密钥表' },
  /** AI 用量明细：每次调用一条（高频写入） */
  aiUsage: { tableId: 'tblairusage000001', name: 'AI用量明细表' },
  /** AI 路由操作日志：密钥代发/吊销、上游与分组变更等管理动作 */
  aiOpLog: { tableId: 'tblairop000000001', name: 'AI路由操作日志表' },
  /** AI 上游代理：国内访问境外 API 时用（协议/主机/端口/账密 + 到期自动切备用） */
  aiProxy: { tableId: 'tblairproxy000001', name: 'AI上游代理表' },
} as const;

export type TableKey = keyof typeof TABLES;

/** 用户表（后续如 Base 增加账号表，在此登记） */
export const USER_TABLE = { tableId: 'tblnFCIRBOZr2oVF', name: '系统用户表' } as const;
