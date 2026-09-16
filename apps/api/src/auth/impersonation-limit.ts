import { moduleByPath } from '@acms/contracts';

/**
 * 身份模拟的**限制项**判定（2026-09-16 Phase 2）。纯函数，便于单测与离线推演。
 *
 * 两个限制：
 *  - `readOnly`  ⇒ 拦截一切写操作（排查权限问题九成只需要读）
 *  - `modules`   ⇒ 只允许访问这些模块（键 = MODULE_RESOURCES.key），越界拒绝
 *
 * 为什么放在 SessionGuard 里做、而不是每个业务接口自己判：
 * 全站有上百个路由，逐个改必然漏；而「这次请求允不允许」本质上是**请求级上下文**，
 * 与操作人上下文（AsyncLocalStorage）同一个思路 —— 在会话解析之后判一次即可，业务零改动。
 */

export interface ImpersonationLimits {
  readOnly?: boolean;
  modules?: string[];
}

export type ImpersonationCheck =
  | { ok: true }
  | { ok: false; code: 'IMPERSONATE_READONLY' | 'IMPERSONATE_MODULE_DENIED'; message: string };

/**
 * 永远放行的前缀：
 *  - `/auth/*`       —— 会话本身（含退出登录），拦了会把人锁死在里面
 *  - `/impersonate/*` —— **退出模拟**是 POST，拦了就没法退出了（这是最关键的一条）
 *  - `/homepage-config/*`、`/dictionaries` —— 页面骨架要用的公共数据
 *  - `/health`
 */
const ALWAYS_ALLOW = [
  '/auth',
  '/impersonate',
  '/homepage-config',
  '/dictionaries',
  '/health',
  '/users/names',
  '/users/directory',
];

/** 只读模式放行的方法（GET/HEAD/OPTIONS 之外一律拦） */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** 去掉 `/api/v1` 前缀与查询串，得到与 MODULE_RESOURCES.path 可比的路径 */
export function normalizePath(rawUrl: string): string {
  const noQuery = rawUrl.split('?')[0] ?? '';
  const stripped = noQuery.replace(/^\/api\/v\d+/, '');
  return stripped.startsWith('/') ? stripped : `/${stripped}`;
}

function isAlwaysAllowed(path: string): boolean {
  return ALWAYS_ALLOW.some((p) => path === p || path.startsWith(`${p}/`));
}

/**
 * 判定一次请求在**模拟限制**下是否放行。
 *
 * 模块白名单的判定取「宽松」策略：只有能明确归到某个模块的路径才拦。
 * 归不到模块的（字典、下拉、上传等公共接口）一律放行 ——
 * 白名单的目的是「别让他进别的业务模块」，不是「把页面弄坏」。
 */
export function checkImpersonation(
  limits: ImpersonationLimits | undefined,
  method: string,
  rawUrl: string,
): ImpersonationCheck {
  if (!limits) return { ok: true };
  const path = normalizePath(rawUrl);
  if (isAlwaysAllowed(path)) return { ok: true };

  if (limits.readOnly && !READ_METHODS.has(method.toUpperCase())) {
    return {
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
      return {
        ok: false,
        code: 'IMPERSONATE_MODULE_DENIED',
        message: `当前模拟只允许访问指定模块，「${mod.label}」不在范围内。`,
      };
    }
  }
  return { ok: true };
}
