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
  微信号?: string;
  常驻城市?: string;
  开课人数说明?: string;
  个人描述?: string;
  附件?: string;
  教师合作等级?: string;
  教学评估?: string;
  收款主体?: string;
  授课学段?: string;
  授课科目类型?: string;
  授课科目?: string[];
  合作开始时间?: string;
  备注?: string;
  // ── 教师档案新增字段（与飞书 Base 字段一一对应） ──
  性别?: string;
  毕业大学?: string;
  '学历/学位'?: string;
  '标准课时(每周)'?: number;
  学期预计总课时?: number;
  每学期预计课酬总额?: number;
  实际课酬总额?: number;
  内部对接人?: string;
  手机号?: string;
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
  微信号?: string;
  常驻城市?: string;
  开课人数说明?: string;
  个人描述?: string;
  附件?: string;
  教师合作等级?: string;
  教学评估?: string;
  收款主体?: string;
  授课学段?: string;
  授课科目类型?: string;
  授课科目?: string[];
  合作开始时间?: string;
  备注?: string;
  // ── 教师档案新增字段（与飞书 Base 字段一一对应） ──
  性别?: string;
  毕业大学?: string;
  '学历/学位'?: string;
  '标准课时(每周)'?: number;
  学期预计总课时?: number;
  每学期预计课酬总额?: number;
  实际课酬总额?: number;
  内部对接人?: string;
  手机号?: string;
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
