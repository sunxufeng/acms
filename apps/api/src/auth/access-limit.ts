import { moduleByPath } from '@acms/contracts';

/**
 * 请求级「访问限制」判定（2026-09-16）。纯函数，便于单测与离线推演。
 *
 * ## 谁在用
 * 同一套限制项现在有**两个使用者**，语义完全一致：
 *   - **身份模拟**（impersonate）：管理员以他人身份浏览时收敛范围
 *   - **API 令牌**（api-token）  ：CLI / MCP / 脚本用的长期凭证
 *
 * 两个限制：
 *   - `readOnly` ⇒ 拦截一切写操作（排查权限问题九成只需要读；agent 更该默认只读）
 *   - `modules`  ⇒ 只允许访问这些模块（键 = MODULE_RESOURCES.key），越界拒绝
 *
 * ## 为什么用 kind 参数而不是复制一份
 * 两类凭证的放行规则**故意不同**（见下方 TOKEN_DENY 的注释），
 * 但差异只有「哪些路径永远不许碰」与「错误文案」两处。
 * 复制一份代码必然漂移 —— 而权限代码里的漂移是事故，不是 bug。
 *
 * ## 为什么放在 SessionGuard 里做、而不是每个业务接口自己判
 * 全站有 300+ 路由，逐个改必然漏；而「这次请求允不允许」本质上是**请求级上下文**，
 * 与操作人上下文（AsyncLocalStorage）同一个思路 —— 在凭证解析之后判一次即可，业务零改动。
 */

export interface AccessLimits {
  readOnly?: boolean;
  modules?: string[];
}

/** 凭证种类：决定放行规则 */
export type LimitKind = 'impersonate' | 'token';

export type AccessDenyCode =
  | 'IMPERSONATE_READONLY'
  | 'IMPERSONATE_MODULE_DENIED'
  | 'TOKEN_READONLY'
  | 'TOKEN_MODULE_DENIED'
  | 'TOKEN_PATH_FORBIDDEN';

export type AccessCheck = { ok: true } | { ok: false; code: AccessDenyCode; message: string };

/**
 * 两类凭证**共同**放行的前缀：页面骨架与纯公共数据。
 * 拦了不是收紧权限，而是把功能弄坏（下拉空、菜单没了）——
 * 白名单的目的是「别进别的业务模块」，不是「把页面弄坏」。
 */
const SHARED_ALLOW = ['/homepage-config', '/dictionaries', '/health', '/users/names', '/users/directory'];

/**
 * 🔴 API 令牌**硬拒**的路径（与限制项无关，任何令牌都不许碰）。
 *
 *  - `/impersonate/*`  —— 令牌若能模拟他人，等于把权限放大链打开了。
 *    ⚠️ 模拟态下 `/impersonate/*` 是**永久放行**的（退出模拟是 POST，拦了人就被困在里面），
 *    但这条规则**绝不能**给令牌用 —— 令牌没有「退出」这个需求，它只该被拒。
 *    这正是两类凭证必须用 kind 区分的根本原因。
 *  - `/auth/emergency` —— 应急密码是给「登录不上」准备的旁路，令牌不该碰。
 *  - `/auth/logout`    —— 令牌没有会话可登出，放行只会变成攻击面。
 *  - `/api-tokens/*`   —— **令牌不能改自己的限制项**，否则它能把「只读」关掉、把模块白名单清空，
 *    等于自己给自己提权。
 */
const TOKEN_DENY = ['/impersonate', '/auth/emergency', '/auth/logout', '/api-tokens'];

/**
 * 模拟态额外放行的前缀：
 *  - `/auth/*`        —— 会话本身（含退出登录），拦了会把人锁死在里面
 *  - `/impersonate/*` —— **退出模拟**是 POST，拦了就没法退出了（最关键的一条）
 *
 * 令牌**不**放行 `/auth` —— 那边靠 TOKEN_DENY 精确拒绝危险入口，
 * 其余 `/auth/*`（如 `/auth/me`）本来就归不到任何模块，模块白名单不会误伤。
 */
const IMPERSONATE_ALLOW = ['/auth', '/impersonate'];

/** 只读模式放行的方法（GET/HEAD/OPTIONS 之外一律拦） */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** 去掉 `/api/v1` 前缀与查询串，得到与 MODULE_RESOURCES.path 可比的路径 */
export function normalizePath(rawUrl: string): string {
  const noQuery = rawUrl.split('?')[0] ?? '';
  const stripped = noQuery.replace(/^\/api\/v\d+/, '');
  return stripped.startsWith('/') ? stripped : `/${stripped}`;
}

function matches(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * 判定一次请求在**访问限制**下是否放行。
 *
 * 模块白名单取「宽松」策略：只有能明确归到某个模块的路径才拦，
 * 归不到模块的（字典、下拉、上传等公共接口）一律放行。
 */
export function checkAccessLimits(
  limits: AccessLimits | undefined,
  method: string,
  rawUrl: string,
  kind: LimitKind,
): AccessCheck {
  const path = normalizePath(rawUrl);

  // ① 令牌的硬拒路径：**先于一切**判定，与有没有配限制项无关
  if (kind === 'token' && TOKEN_DENY.some((p) => matches(path, p))) {
    return {
      ok: false,
      code: 'TOKEN_PATH_FORBIDDEN',
      message: 'API 令牌不允许访问该地址（身份模拟与令牌管理只能由登录的人在网页上操作）。',
    };
  }

  if (!limits) return { ok: true };

  const allowed = kind === 'token' ? SHARED_ALLOW : [...SHARED_ALLOW, ...IMPERSONATE_ALLOW];
  if (allowed.some((p) => matches(path, p))) return { ok: true };

  if (limits.readOnly && !READ_METHODS.has(method.toUpperCase())) {
    return kind === 'token'
      ? {
          ok: false,
          code: 'TOKEN_READONLY',
          message: '该 API 令牌是只读的，不能提交修改。需要写入请让管理员在「令牌管理」里关掉只读开关。',
        }
      : {
          ok: false,
          code: 'IMPERSONATE_READONLY',
          message: '当前是「只读模拟」，不能提交修改。请退出模拟后以目标用户身份重新进入（不勾只读）。',
        };
  }

  const mods = limits.modules ?? [];
  if (mods.length) {
    // moduleByPath 认的是模块 path；再兜一层首段匹配，兼容带子路径的接口
    const seg = `/${path.split('/').filter(Boolean)[0] ?? ''}`;
    const mod = moduleByPath(path) ?? moduleByPath(seg);
    if (mod && !mods.includes(mod.key)) {
      return kind === 'token'
        ? {
            ok: false,
            code: 'TOKEN_MODULE_DENIED',
            message: `该 API 令牌只允许访问指定模块，「${mod.label}」不在范围内。`,
          }
        : {
            ok: false,
            code: 'IMPERSONATE_MODULE_DENIED',
            message: `当前模拟只允许访问指定模块，「${mod.label}」不在范围内。`,
          };
    }
  }
  return { ok: true };
}

/**
 * 身份模拟的限制判定（保持原签名，供既有调用点与测试使用）。
 * 实现已统一到 `checkAccessLimits`，这里只是薄包装 —— 请勿在此另写逻辑。
 */
export function checkImpersonation(
  limits: AccessLimits | undefined,
  method: string,
  rawUrl: string,
): AccessCheck {
  return checkAccessLimits(limits, method, rawUrl, 'impersonate');
}
