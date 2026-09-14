/** 教师履约 / 出勤 DTO（M3 教学履约与计费，表：教师履约记录表） */

export interface CreateAttendanceDto {
  课次文本?: string;
  教学班文本?: string;
  授课教师文本?: string;
  出勤日期?: string;
  时段?: string;
  计划课时?: number | string;
  实到人数?: number | string;
  异常描述?: string;
  校区?: string;
  备注?: string;
}

export interface UpdateAttendanceDto {
  课次文本?: string;
  教学班文本?: string;
  授课教师文本?: string;
  出勤日期?: string;
  时段?: string;
  计划课时?: number | string;
  实到人数?: number | string;
  异常描述?: string;
  校区?: string;
  备注?: string;
}

export interface AttendanceFilterDto {
  q?: string;
  出勤状态?: string;
  时段?: string;
  教学班文本?: string;
  授课教师文本?: string;
  校区?: string;
  sortBy?: '出勤日期' | '更新时间';
  sortOrder?: 'asc' | 'desc';
  pageToken?: string;
}

export interface TransitionDto {
  to: string;
}

/** 出勤状态机（BR-007：教务审核→可计费 仅教务可操作，教师不可自批计费） */
export const ATTENDANCE_TRANSITIONS: Record<string, { to: string; perm: string }[]> = {
  待提交: [{ to: '已提交', perm: 'attendance:write' }],
  已提交: [{ to: '教师已确认', perm: 'attendance:write' }],
  教师已确认: [{ to: '教务已审核', perm: 'attendance:approve' }],
  教务已审核: [{ to: '可计费', perm: 'attendance:approve' }],
};

// ─────────────────────────────────────────────────────────────────────────
// 学生考勤记录表（TABLES.attendance）的**终态审核**字段与 DTO
// ─────────────────────────────────────────────────────────────────────────
//
// 范式对齐「教师履约记录表」的 `审核人 / 审核意见`（同一套叫法，别另造 name），
// 但审核对象是**学生考勤记录**（出勤率报表读的就是它）。
//
// 字段（PG 宽表，写进 data jsonb 即可，**不需要改表结构**）：
//   · 审核状态：待审核 | 已通过 | 已驳回    —— 新建时由服务端写「待审核」，用户不可选；
//                                          空值/未标注一律按「待审核」处理（见 attendance-rate.ts）
//   · 审核人  ：审核人姓名（与教师履约的「审核人」同为文本，取当前登录用户，不接受前端传入）
//   · 审核时间：本地时间字符串 "YYYY-MM-DD HH:mm"
//   · 审核意见：审核备注（可选）
//
// 只有「已通过」的考勤记录才进出勤率的分子分母 —— 未审核的不进结算基数。

/** 审核终态取值（唯一真源在 reports/attendance-rate.ts，这里只做类型说明与引用） */
export interface AttendanceReviewFields {
  审核状态?: string;
  审核人?: string;
  审核时间?: string;
  审核意见?: string;
}

/** 单条审核：status 只接受「已通过」/「已驳回」（不接受「待审核」——没有撤回动作） */
export interface ReviewAttendanceDto {
  status?: string;
  comment?: string;
}

/** 批量审核：ids 为考勤记录 id（一次最多 500 条） */
export interface ReviewAttendanceBatchDto {
  ids?: string[];
  status?: string;
  comment?: string;
}
