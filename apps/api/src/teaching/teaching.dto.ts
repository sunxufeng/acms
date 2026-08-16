/** 课程方案 / 教学班 DTO（M2 教学域） */

export interface CreateCoursePlanDto {
  课程方案名称: string;
  方案类型?: string;
  适用学段?: string;
  适用年级?: string[];
  课程目标?: string;
  课程大纲?: string;
  标准总课时?: number | string;
  单次标准课时?: number | string;
  建议班额?: number | string;
  授课方式?: string;
  方案状态?: string;
  版本号?: string;
  备注?: string;
}

export interface UpdateCoursePlanDto {
  课程方案名称?: string;
  方案类型?: string;
  适用学段?: string;
  适用年级?: string[];
  课程目标?: string;
  课程大纲?: string;
  标准总课时?: number | string;
  单次标准课时?: number | string;
  建议班额?: number | string;
  授课方式?: string;
  方案状态?: string;
  版本号?: string;
  备注?: string;
}

export interface CreateTeachingClassDto {
  教学班名称: string;
  教学班类型?: string;
  学期?: string;
  上课地点?: string;
  标准上课时间?: string;
  班额上限?: number | string;
  计划课次?: number | string;
  计划总课时?: number | string;
  计划开始日期?: string;
  计划结束日期?: string;
  排课状态?: string;
  教学状态?: string;
  主讲教师文本?: string;
  备注?: string;
}

export interface UpdateTeachingClassDto {
  教学班名称?: string;
  教学班类型?: string;
  学期?: string;
  上课地点?: string;
  标准上课时间?: string;
  班额上限?: number | string;
  计划课次?: number | string;
  计划总课时?: number | string;
  计划开始日期?: string;
  计划结束日期?: string;
  排课状态?: string;
  教学状态?: string;
  主讲教师文本?: string;
  备注?: string;
}

export interface CoursePlanFilterDto {
  q?: string;
  方案类型?: string;
  方案状态?: string;
  适用学段?: string;
  sortBy?: '课程方案名称' | '更新时间';
  sortOrder?: 'asc' | 'desc';
  pageToken?: string;
}

export interface TeachingClassFilterDto {
  q?: string;
  教学班类型?: string;
  教学状态?: string;
  排课状态?: string;
  sortBy?: '教学班名称' | '更新时间';
  sortOrder?: 'asc' | 'desc';
  pageToken?: string;
}

/** 状态机转移：课程方案 草拟→审核中→已发布→停用 */
export const COURSE_PLAN_TRANSITIONS: Record<string, string[]> = {
  草拟: ['审核中'],
  审核中: ['已发布', '草拟'],
  已发布: ['停用'],
  停用: ['草拟'],
};

/** 状态机转移：教学班 筹备→进行中→已结课/取消 */
export const TEACHING_CLASS_TRANSITIONS: Record<string, string[]> = {
  筹备: ['进行中', '取消'],
  进行中: ['已结课', '取消'],
  已结课: [],
  取消: [],
};
