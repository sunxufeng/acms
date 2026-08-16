/** 学生档案 DTO（M1 仅编辑非关联字段；校验在 service 层做，避免引入 class-validator 依赖） */

/** 必填：学生姓名；其余选填 */
export interface CreateStudentDto {
  学生姓名: string;
  来源渠道?: string;
  生源跟进状态?: string;
  招生负责老师?: string[];
  当前状态?: string;
  班级?: string;
  班主任?: string[];
  入学日期?: string;
  毕业日期?: string;
  姓名拼音?: string;
  英文名?: string;
  曾用名?: string;
  出生日期?: string;
  性别?: string;
  国籍或地区?: string;
  民族?: string;
  籍贯?: string;
  户籍类型?: string;
  '证件号码（脱敏）'?: string;
  学生手机号?: string;
  学生邮箱?: string;
  现居住地址?: string;
  通讯地址?: string;
  邮政编码?: string;
  当前学段?: string;
  当前年级?: string;
  入学类型?: string;
  '学籍号（脱敏）'?: string;
  预计毕业日期?: string;
  离校原因?: string;
  校区?: string;
  宿舍信息?: string;
  健康风险摘要?: string;
  特殊支持摘要?: string[];
  摘要?: string;
  数据密级?: string;
  数据负责人?: string[];
  档案完整度?: string;
  最近核验日期?: string;
  学生标签?: string;
  备注?: string;
  通知状态?: string;
  学生微信号?: string;
  政治面貌?: string;
  专业学科?: string;
  就读方式?: string;
  毕业学校?: string;
  '飞书 Open ID'?: string;
  入学级?: string;
  毕业届?: string;
}

/** 编辑：全部可选（部分更新） */
export interface UpdateStudentDto {
  学生姓名?: string;
  来源渠道?: string;
  生源跟进状态?: string;
  招生负责老师?: string[];
  当前状态?: string;
  班级?: string;
  班主任?: string[];
  入学日期?: string;
  毕业日期?: string;
  姓名拼音?: string;
  英文名?: string;
  曾用名?: string;
  出生日期?: string;
  性别?: string;
  国籍或地区?: string;
  民族?: string;
  籍贯?: string;
  户籍类型?: string;
  '证件号码（脱敏）'?: string;
  学生手机号?: string;
  学生邮箱?: string;
  现居住地址?: string;
  通讯地址?: string;
  邮政编码?: string;
  当前学段?: string;
  当前年级?: string;
  入学类型?: string;
  '学籍号（脱敏）'?: string;
  预计毕业日期?: string;
  离校原因?: string;
  校区?: string;
  宿舍信息?: string;
  健康风险摘要?: string;
  特殊支持摘要?: string[];
  摘要?: string;
  数据密级?: string;
  数据负责人?: string[];
  档案完整度?: string;
  最近核验日期?: string;
  学生标签?: string;
  备注?: string;
  通知状态?: string;
  学生微信号?: string;
  政治面貌?: string;
  专业学科?: string;
  就读方式?: string;
  毕业学校?: string;
  '飞书 Open ID'?: string;
  入学级?: string;
  毕业届?: string;
}

/** 列表筛选 */
export interface StudentFilterDto {
  q?: string; // 姓名模糊搜索
  当前状态?: string;
  当前年级?: string;
  班级?: string;
  班主任?: string;
  招生负责老师?: string;
  校区?: string;
  数据密级?: string;
  性别?: string;
  来源渠道?: string;
  生源跟进状态?: string;
  sortBy?: '学生编号' | '学生姓名' | '更新时间' | '创建时间' | '入学日期';
  sortOrder?: 'asc' | 'desc';
  pageToken?: string;
  includeArchived?: string; // 'true' 包含已归档
  入学级?: string;
  毕业届?: string;
}

/** 导出查询（复用列表筛选） */
export interface ExportQueryDto {
  q?: string;
  当前状态?: string;
  班级?: string;
  校区?: string;
  数据密级?: string;
}
