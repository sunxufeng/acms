/** 课次排课 DTO（M2 排课域） */

export interface CreateSessionDto {
  课次名称: string;
  课次日期?: string;
  开始时间?: string;
  结束时间?: string;
  计划课时?: number | string;
  上课地点?: string;
  授课方式?: string;
  排课来源?: string;
  调课原因?: string;
  教学内容?: string;
  备注?: string;
  教学班文本?: string;
  授课教师文本?: string;
  场地文本?: string;
  课次状态?: string;
}

export interface UpdateSessionDto {
  课次名称?: string;
  课次日期?: string;
  开始时间?: string;
  结束时间?: string;
  计划课时?: number | string;
  上课地点?: string;
  授课方式?: string;
  排课来源?: string;
  调课原因?: string;
  教学内容?: string;
  备注?: string;
  教学班文本?: string;
  授课教师文本?: string;
  场地文本?: string;
  课次状态?: string;
}

export interface SessionFilterDto {
  q?: string;
  授课方式?: string;
  课次状态?: string;
  教学班文本?: string;
  授课教师文本?: string;
  sortBy?: '课次名称' | '课次日期' | '更新时间';
  sortOrder?: 'asc' | 'desc';
  pageToken?: string;
}

export interface PrecheckConflictDto {
  id?: string;
  课次日期?: string;
  开始时间?: string;
  结束时间?: string;
  教学班文本?: string;
  授课教师文本?: string;
  场地文本?: string;
}

/** 状态机转移：课次 待确认→已确认→已完成/已取消/已调课（BR-006） */
export const SESSION_TRANSITIONS: Record<string, string[]> = {
  待确认: ['已确认', '已取消', '已调课'],
  已确认: ['已完成', '已取消', '已调课'],
  已完成: [],
  已取消: [],
  已调课: ['待确认'],
};
