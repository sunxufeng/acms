/** 学生密码登录请求体（B1）。不使用 class-validator，校验在服务层完成（与项目其他 DTO 一致）。 */
export interface StudentLoginDto {
  studentNo?: string;
  password?: string;
}

/** 学生自助设置密码请求体（需学号 + 姓名验证身份） */
export interface StudentSetPasswordDto {
  studentNo?: string;
  name?: string;
  password?: string;
}

/** 管理员为学生设置密码请求体 */
export interface AdminSetStudentPasswordDto {
  studentNo?: string;
  password?: string;
}
