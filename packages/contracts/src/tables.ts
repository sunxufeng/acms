/** 飞书 Base 表注册（DEV base RIAgbQsrfa7EJdslDnkcdAuanyd，2026-08-25 重映射） */
export const TABLES = {
  studentProfile: { tableId: 'tblyFIfe58IjxT4K', name: '学生档案表' },
  sourceFollowup: { tableId: 'tblagWpUSFB9SPIw', name: '生源跟进记录表' },
  attendance: { tableId: 'tblYnSI1HE4E4eIS', name: '考勤记录表' },
  academicGrade: { tableId: 'tblLl9S63reX8gcU', name: '学业成绩表' },
  practiceActivity: { tableId: 'tblSydXiQcpUdZ6i', name: '实践活动表' },
  homeSchoolComm: { tableId: 'tbl9eA6kF1DFQkI1', name: '家校沟通表' },
  dailyFollowup: { tableId: 'tblFVUnzdEWLvPeh', name: '日常跟进表' },
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
} as const;

export type TableKey = keyof typeof TABLES;

/** 用户表（后续如 Base 增加账号表，在此登记） */
export const USER_TABLE = { tableId: 'tblnFCIRBOZr2oVF', name: '系统用户表' } as const;
