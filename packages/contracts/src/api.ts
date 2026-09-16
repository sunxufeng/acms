/** 统一 API 错误模型：GET /api/v1/* 返回 4xx/5xx + 该结构 */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: unknown;
  };
}

export const ERROR_CODES = {
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION: 'VALIDATION',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  UPSTREAM: 'UPSTREAM',
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** 统一分页 */
export interface Page<T> {
  items: T[];
  total: number;
  pageToken?: string;
  hasMore: boolean;
}

export interface PageQuery {
  pageSize?: number;
  pageToken?: string;
}

/** 会话用户（API 鉴权后挂到 request.user） */
export interface SessionUser {
  openId: string;
  name: string;
  roles: string[];
  campuses: string[];
  maxDataLevel: string;
  /** 学生端/家长端会话：绑定的学生档案 record_id（同时作为关联学生编号的 link 值） */
  studentId?: string;
  /**
   * 身份模拟（2026-09-16）：本会话由哪位系统管理员发起。缺省 = 本人真实登录。
   *
   * 存在的意义有两个：
   *  1. 前端据此渲染全局提醒横幅 + 把登出按钮换成「退出模拟」
   *  2. 服务端据此拒绝嵌套模拟，并让审计摘要在写入时标注「由 XXX 代为操作」
   */
  impersonatedBy?: { openId: string; name: string };
  /**
   * 身份模拟的**限制项**（2026-09-16 Phase 2）：
   *  - `readOnly: true` ⇒ 拦截一切写操作（排查权限问题九成只需要读）
   *  - `modules` 非空 ⇒ 只允许访问这些模块（键 = MODULE_RESOURCES.key），越界 403
   *
   * 由 SessionGuard 在读会话后统一判定，业务代码零改动（与操作人上下文同一手法）。
   */
  impersonation?: { readOnly: boolean; modules: string[] };
  sessionId: string;
  expiresAt: number;
}
