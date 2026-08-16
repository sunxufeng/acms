/** 飞书 Base 表注册（与 docs/base-schema-snapshot.json 对齐，2026-08-16） */
export const TABLES = {
  studentProfile: { tableId: 'tbl2peVECjHnm8la', name: '学生档案表' },
  sourceFollowup: { tableId: 'tblDEuaTDoiXkjZu', name: '生源跟进记录表' },
  attendance: { tableId: 'tblUkd1JKi4T7XQb', name: '考勤记录表' },
  academicGrade: { tableId: 'tblaYsfXSbqyZiZ5', name: '学业成绩表' },
  practiceActivity: { tableId: 'tblOitwcvOBSkeuu', name: '实践活动表' },
  homeSchoolComm: { tableId: 'tbl8Isr46G3BRQ52', name: '家校沟通表' },
  stageEvaluation: { tableId: 'tblHk6r8USy6BXV4', name: '阶段评价表' },
  alumniFollowup: { tableId: 'tblK02GgjnaLp1Gp', name: '校友长期跟进表' },
} as const;

export type TableKey = keyof typeof TABLES;

/** 用户表（后续如 Base 增加账号表，在此登记） */
export const USER_TABLE = { tableId: 'tblTV6VAO5x2967y', name: '系统用户表' } as const;
