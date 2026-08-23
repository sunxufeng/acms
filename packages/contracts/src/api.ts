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
  sessionId: string;
  expiresAt: number;
}
