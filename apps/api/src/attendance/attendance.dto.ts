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
