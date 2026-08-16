/** 学生修读关系 DTO（M2 教学域） */

export interface CreateEnrollmentDto {
  修读关系名称: string;
  修读类型?: string;
  加入日期?: string;
  退出日期?: string;
  个性化学习目标?: string;
  特殊安排?: string;
  收费状态?: string;
  备注?: string;
  修读状态?: string;
}

export interface UpdateEnrollmentDto {
  修读关系名称?: string;
  修读类型?: string;
  加入日期?: string;
  退出日期?: string;
  个性化学习目标?: string;
  特殊安排?: string;
  收费状态?: string;
  备注?: string;
  修读状态?: string;
}

export interface EnrollmentFilterDto {
  q?: string;
  修读类型?: string;
  修读状态?: string;
  收费状态?: string;
  sortBy?: '修读关系名称' | '更新时间';
  sortOrder?: 'asc' | 'desc';
  pageToken?: string;
}

/** 状态机转移：修读关系 待确认→在读→暂停/完成/退出 */
export const ENROLLMENT_TRANSITIONS: Record<string, string[]> = {
  待确认: ['在读', '退出'],
  在读: ['暂停', '完成', '退出'],
  暂停: ['在读', '退出'],
  完成: [],
  退出: [],
};
