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
  /**
   * 用户级密级上限（引擎取值 L1–L4）。
   *
   * 🔴 **可缺省**：缺省 = 用户表「数据密级上限」留空 ⇒ 由 `maxDataLevelOf()` 回退到
   *    「角色管理 · 数据密级上限」里该用户各角色的最高值。
   *    2026-09-18 之前这里被写成 `?? 'L1'`，个人值永远是 L1 ⇒ 角色上限那段分支成为死代码。
   *    不要为了"省事"给它补默认值，那会让角色上限再次失效。
   */
  maxDataLevel?: string;
  /** 学生端/家长端会话：绑定的学生档案 record_id（同时作为关联学生编号的 link 值） */
  studentId?: string;
  /**
   * 家长端会话：**本家长名下可切换的子女** record_id 列表（2026-09-19，issue #2 多子女）。
   *
   * 语义分工：
   *   - `studentId`   = **当前选中**的子女（所有既有查询都读它，一行都不用改）
   *   - `studentIds`  = 可切换的全集（只给「切换子女」用；为空/缺省 = 单子女，不显示切换器）
   *
   * 🔴 两者必须满足 `studentId ∈ studentIds`。切换接口只允许切到 `studentIds` 里的值 ——
   *    若凭前端传来的 studentId 直接改会话，等于把"看哪个孩子"变成客户端可任选，
   *    越权访问别的孩子档案。判定放在服务端（`ParentService.switchChild`）。
   */
  studentIds?: string[];
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
   *
   * ⚠️ 这是身份模拟引入时的字段名。**API 令牌**用的是同结构的 `limits`（见下），
   * 守卫两者都认（`limits ?? impersonation`）—— 保留旧名是因为线上已存在带
   * `impersonation` 的模拟会话（Redis，30 分钟 TTL），改名会让它们在 TTL 内失效。
   * 新代码请用 `limits`。
   */
  impersonation?: { readOnly: boolean; modules: string[] };
  /**
   * 访问限制项（2026-09-16，API 令牌引入）。结构同 `impersonation`，语义完全一致：
   *  - `readOnly: true` ⇒ 拦截一切写操作
   *  - `modules` 非空 ⇒ 只允许访问这些模块（键 = MODULE_RESOURCES.key），越界 403
   *
   * 之所以不叫 impersonation：令牌不是「模拟谁」，它是「以某人的权限长期访问」。
   * 两者共用同一条判定链路（`checkAccessLimits`），只是 `kind` 不同。
   */
  limits?: { readOnly: boolean; modules: string[] };
  /**
   * 本次请求的凭证来源（**只在内存里，不落 Redis**）：
   *  - 缺省 / `session` = Cookie 或 `x-acms-sid` 的会话
   *  - `token`          = `Authorization: Bearer acms-sk-…`
   *
   * 供审计与留痕区分「人点的」还是「程序调的」。
   */
  authVia?: 'session' | 'token';
  /** 令牌认证时的令牌记录 id（= 明文哈希），用于调用留痕；会话认证时为空 */
  tokenId?: string;
  sessionId: string;
  expiresAt: number;
}
