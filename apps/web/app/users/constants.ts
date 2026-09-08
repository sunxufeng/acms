/** 用户管理页与 UserForm 共用的选项常量（单一真源，避免两处重复定义） */

/** 数据密级上限选项（存储值本身就是这些文本） */
export const LEVEL_OPTS = ['一般', '内部', '敏感', '高度敏感', 'L4'];

/** 账号状态选项 */
export const STATUS_OPTS = ['启用', '停用'];

/** 教师类型兜底选项（优先取字典「教师类型」） */
export const TEACHER_TYPE_FALLBACK = ['班主任', '招生老师'];
