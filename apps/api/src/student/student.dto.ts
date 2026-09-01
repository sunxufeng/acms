/** 学生档案 DTO（M1 仅编辑非关联字段；校验在 service 层做，避免引入 class-validator 依赖） */

/** 必填：学生姓名；其余选填 */
export interface CreateStudentDto {
  学生姓名: string;
  来源渠道?: string;
  生源跟进状态?: string;
  招生负责老师?: string[];
  当前状态?: string;
  当前年级?: string;
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
  现居住省?: string;
  城市?: string;
  政治面貌?: string;
  '证件号码（脱敏）'?: string;
  学生手机号?: string;
  学生邮箱?: string;
  现居住地址?: string;
  通讯地址?: string;
  邮政编码?: string;
  当前学段?: string;
  入学年级?: string;
  入学类型?: string;
  入学年份?: string;
  实际学制?: string;
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
  学生标签?: string[];
  特长标签?: string[];
  备注?: string;
  通知状态?: string;
  原学校?: string;
  原学校类型?: string;
  合同状态?: string;
  付款状态?: string;
  奖学金金额?: string;
  家庭关键决策点?: string;
  学生微信号?: string;
  专业学科?: string;
  就读方式?: string;
  毕业学校?: string;
  '飞书 Open ID'?: string;
  入学级?: string;
  毕业届?: string;
  'Arete毕业届'?: string;
  '证件信息'?: string;
  // ── 入学测试 ──
  数学笔试成绩?: string;
  英语笔试成绩?: string;
  英语标化成绩?: string; // 结构：JSON 数组 [{type, score}]，类型来自字典「英语标化类型」
  英语口语评分?: string;
  家长面谈情况?: string;
  学生面试情况?: string;
  '作品集/附加材料评价'?: string;
  综合评定等级?: string;
  // ── 学术表现 ──
  GPA成绩?: string; // 结构：JSON 数组 [{type, score}]，类型来自字典「GPA成绩类型」
  预警科目?: string;
  提升成果?: string;
  语言标化成绩?: string; // 结构：JSON 数组 [{type, score}]，类型来自字典「语言标化类型」
  学术标化成绩?: string; // 结构：JSON 数组 [{type, score}]，类型来自字典「学术标化类型」
  出勤率?: string;
  作业完成率?: string;
  核心课程表现?: string;
  // ── 成长表现 ──
  社团表现?: string;
  社区服务表现?: string;
  企业参访表现?: string;
  创新创业PBL表现?: string;
  'AI LAB项目表现'?: string;
  亮点行动?: string;
  交付物?: string;
  '项目导师评语/成长改进建议'?: string;
  'IDP导师评语/成长改进建议'?: string;
  // ── 家庭情况 ──
  父亲姓名?: string;
  父亲单位?: string;
  父亲职位?: string;
  父亲电话?: string;
  父亲邮箱?: string;
  母亲姓名?: string;
  母亲单位?: string;
  母亲职位?: string;
  母亲电话?: string;
  母亲邮箱?: string;
  是否企业家庭?: string;
  是否工坊企业?: string;
  是否多胎家庭?: string;
  家庭地址?: string;
  家长期待?: string;
  // ── 升学阶段 ──
  升学导师?: string[];
  初始留学意向?: string;
  目标国家?: string;
  目标院校?: string;
  意向专业?: string;
  录取offer?: string;
  最终入读院校?: string;
  签证情况?: string;
  // ── 健康与安全 / 基本信息 ──
  既往病史?: string;
  心理状态?: string;
  日常禁忌?: string;
  宗教信仰?: string;
}

/** 编辑：全部可选（部分更新） */
export interface UpdateStudentDto {
  学生姓名?: string;
  来源渠道?: string;
  生源跟进状态?: string;
  招生负责老师?: string[];
  当前状态?: string;
  当前年级?: string;
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
  现居住省?: string;
  城市?: string;
  政治面貌?: string;
  '证件号码（脱敏）'?: string;
  学生手机号?: string;
  学生邮箱?: string;
  现居住地址?: string;
  通讯地址?: string;
  邮政编码?: string;
  当前学段?: string;
  入学年级?: string;
  入学类型?: string;
  入学年份?: string;
  实际学制?: string;
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
  学生标签?: string[];
  特长标签?: string[];
  备注?: string;
  通知状态?: string;
  原学校?: string;
  原学校类型?: string;
  合同状态?: string;
  付款状态?: string;
  奖学金金额?: string;
  家庭关键决策点?: string;
  学生微信号?: string;
  专业学科?: string;
  就读方式?: string;
  毕业学校?: string;
  '飞书 Open ID'?: string;
  入学级?: string;
  毕业届?: string;
  'Arete毕业届'?: string;
  '证件信息'?: string;
  /** 照片（附件数组，每项含 file_token） */
  学生照片?: Array<{ file_token: string; name?: string }>;
  /** 证件与文件附件 */
  证件与文件?: Array<{ file_token: string; name?: string }>;
}

/** 列表筛选 */
export interface StudentFilterDto {
  q?: string; // 姓名模糊搜索
  当前状态?: string;
  入学年级?: string;
  当前年级?: string;
  班主任?: string;
  招生负责老师?: string;
  校区?: string;
  数据密级?: string;
  性别?: string;
  来源渠道?: string;
  生源跟进状态?: string;
  现居住省?: string;
  城市?: string;
  入学年份?: string;
  实际学制?: string;
  学生标签?: string;
  特长标签?: string;
  原学校类型?: string;
  合同状态?: string;
  付款状态?: string;
  家庭关键决策点?: string;
  综合评定等级?: string;
  签证情况?: string;
  是否企业家庭?: string;
  是否工坊企业?: string;
  是否多胎家庭?: string;
  sortBy?: '学生编号' | '学生姓名' | '更新时间' | '创建时间' | '入学日期' | '学籍号（脱敏）';
  sortOrder?: 'asc' | 'desc';
  pageSize?: number;
  pageToken?: string;
  includeArchived?: string; // 'true' 包含已归档
  入学级?: string;
  毕业届?: string;
}

/** 导出查询（复用列表筛选） */
export interface ExportQueryDto {
  q?: string;
  当前状态?: string;
  入学年级?: string;
  当前年级?: string;
  校区?: string;
  数据密级?: string;
}
