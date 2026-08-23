/**
 * 微信小程序端登录 / 区域拉取的请求体。
 * 与本项目其他 DTO 保持一致：interface + 服务层自行校验，不使用 class-validator。
 * 详见 docs/student-portal-plan.md §4 / §7。
 */
export interface WechatLoginDto {
  /** wx.login() 返回的临时登录 code（生产环境用它向微信 code2Session 换 openid） */
  code: string;
  /** 首次绑定用学号（学生档案「学生编号」/「学籍号」之一），与姓名共同校验 */
  studentNo?: string;
  /** 首次绑定用姓名（学生档案「学生姓名」） */
  name?: string;
  /**
   * 开发模式占位：仅当服务端未配置 WECHAT_MINI_APPID/SECRET 时生效，
   * 直接作为 openid（前缀 dev_）用于本地联调。生产环境配置真实凭证后此字段被忽略。
   */
  devCode?: string;
}

export interface ZoneQueryDto {
  /** 按校区过滤（可选）；不传则返回全部启用围栏 */
  campus?: string;
}
