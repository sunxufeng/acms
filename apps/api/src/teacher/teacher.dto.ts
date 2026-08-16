/** 教师档案 DTO（M2 教师域；校验在 service 层） */

export interface CreateTeacherDto {
  教师姓名: string;
  英文名?: string;
  教师类别?: string;
  外聘归属类型?: string;
  在职合作状态?: string;
  所属部门?: string;
  主要学科?: string[];
  可授年级与课程?: string;
  资质与证书摘要?: string;
  数据密级?: string;
  入职或首次合作日期?: string;
  离职或终止日期?: string;
  邮箱?: string;
  备注?: string;
}

export interface UpdateTeacherDto {
  教师姓名?: string;
  英文名?: string;
  教师类别?: string;
  外聘归属类型?: string;
  在职合作状态?: string;
  所属部门?: string;
  主要学科?: string[];
  可授年级与课程?: string;
  资质与证书摘要?: string;
  数据密级?: string;
  入职或首次合作日期?: string;
  离职或终止日期?: string;
  邮箱?: string;
  备注?: string;
}

export interface TeacherFilterDto {
  q?: string;
  教师类别?: string;
  在职合作状态?: string;
  所属部门?: string;
  数据密级?: string;
  sortBy?: '教师姓名' | '更新时间';
  sortOrder?: 'asc' | 'desc';
  pageToken?: string;
}
