import { describe, expect, it } from 'vitest';
import { checkAccessLimits, checkImpersonation, normalizePath } from '../src/auth/access-limit.js';

describe('路径归一化', () => {
  it('去掉 /api/v1 前缀与查询串', () => {
    expect(normalizePath('/api/v1/exam-grades/preview?batchId=x')).toBe('/exam-grades/preview');
    expect(normalizePath('/api/v2/students')).toBe('/students');
    expect(normalizePath('/students')).toBe('/students');
  });
});

describe('无限制时一律放行', () => {
  it('undefined / 空限制', () => {
    expect(checkImpersonation(undefined, 'POST', '/api/v1/students').ok).toBe(true);
    expect(checkImpersonation({}, 'DELETE', '/api/v1/students/x').ok).toBe(true);
    expect(checkImpersonation({ readOnly: false, modules: [] }, 'POST', '/api/v1/students').ok).toBe(true);
  });
});

describe('只读模式', () => {
  const limits = { readOnly: true };

  it('拦 POST / PUT / PATCH / DELETE', () => {
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const r = checkImpersonation(limits, m, '/api/v1/students');
      expect(r.ok, m).toBe(false);
      if (!r.ok) expect(r.code).toBe('IMPERSONATE_READONLY');
    }
  });

  it('放行 GET / HEAD / OPTIONS', () => {
    for (const m of ['GET', 'HEAD', 'OPTIONS']) {
      expect(checkImpersonation(limits, m, '/api/v1/students').ok, m).toBe(true);
    }
  });

  it('🔴 退出模拟（POST /impersonate/exit）必须放行 —— 否则人被困在模拟态里出不来', () => {
    expect(checkImpersonation(limits, 'POST', '/api/v1/impersonate/exit').ok).toBe(true);
    expect(checkImpersonation(limits, 'POST', '/api/v1/impersonate/lock').ok).toBe(true);
  });

  it('登录/登出与公共数据也放行', () => {
    expect(checkImpersonation(limits, 'POST', '/api/v1/auth/logout').ok).toBe(true);
    expect(checkImpersonation(limits, 'GET', '/api/v1/dictionaries').ok).toBe(true);
    expect(checkImpersonation(limits, 'GET', '/api/v1/homepage-config/menu').ok).toBe(true);
    expect(checkImpersonation(limits, 'GET', '/api/v1/users/directory').ok).toBe(true);
  });
});

describe('模块白名单', () => {
  const limits = { modules: ['markbook'] };

  it('白名单内的模块放行', () => {
    expect(checkImpersonation(limits, 'GET', '/api/v1/markbook/grid?cls=Pre-1').ok).toBe(true);
  });

  it('越界模块被拒，且给出可读原因', () => {
    const r = checkImpersonation(limits, 'GET', '/api/v1/students');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('IMPERSONATE_MODULE_DENIED');
      expect(r.message).toContain('学生档案');
    }
  });

  it('归不到模块的公共接口放行（白名单是"别进别的业务模块"，不是"把页面弄坏"）', () => {
    expect(checkImpersonation(limits, 'GET', '/api/v1/dictionaries').ok).toBe(true);
    expect(checkImpersonation(limits, 'GET', '/api/v1/homepage-config/menu').ok).toBe(true);
  });

  it('退出模拟永远放行', () => {
    expect(checkImpersonation(limits, 'POST', '/api/v1/impersonate/exit').ok).toBe(true);
  });
});

describe('两个限制同时生效', () => {
  const limits = { readOnly: true, modules: ['markbook'] };

  it('越界模块 + 写操作：先报只读（更贴近用户当下的动作）', () => {
    const r = checkImpersonation(limits, 'POST', '/api/v1/students');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('IMPERSONATE_READONLY');
  });

  it('白名单内但写操作：只读仍然拦住', () => {
    const r = checkImpersonation(limits, 'POST', '/api/v1/markbook/entries/save');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('IMPERSONATE_READONLY');
  });
});

// ─────────────────────────────────────────────────────────────────────
// API 令牌（2026-09-16）：与模拟共用同一条链路，但**放行规则故意不同**
// ─────────────────────────────────────────────────────────────────────
describe('API 令牌：硬拒路径（与限制项无关）', () => {
  it('即使是只读令牌，GET /impersonate/users 也要拒（模拟他人 = 权限放大链）', () => {
    const r = checkAccessLimits({ readOnly: true, modules: [] }, 'GET', '/api/v1/impersonate/users', 'token');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('TOKEN_PATH_FORBIDDEN');
  });

  it('令牌不能退出模拟（它没有模拟态）', () => {
    const r = checkAccessLimits(undefined, 'POST', '/api/v1/impersonate/exit', 'token');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('TOKEN_PATH_FORBIDDEN');
  });

  it('🔴 令牌不能改自己的限制项（否则能给自己提权）', () => {
    for (const [method, url] of [
      ['GET', '/api/v1/api-tokens'],
      ['POST', '/api/v1/api-tokens'],
      ['PATCH', '/api/v1/api-tokens/abc'],
      ['POST', '/api/v1/api-tokens/abc/revoke'],
    ] as const) {
      const r = checkAccessLimits(undefined, method, url, 'token');
      expect(r.ok, `${method} ${url}`).toBe(false);
      if (!r.ok) expect(r.code).toBe('TOKEN_PATH_FORBIDDEN');
    }
  });

  it('令牌不能碰应急登录', () => {
    const r = checkAccessLimits(undefined, 'POST', '/api/v1/auth/emergency', 'token');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('TOKEN_PATH_FORBIDDEN');
  });

  it('契约对照：同一条路径对「模拟」是放行的，对「令牌」必须拒', () => {
    // 这条是本设计最容易改错的地方：模拟态下 /impersonate/* 永久放行（否则退不出去），
    // 令牌则必须硬拒。两者用 kind 区分而不是复制代码。
    const url = '/api/v1/impersonate/exit';
    expect(checkAccessLimits({ readOnly: true, modules: [] }, 'POST', url, 'impersonate').ok).toBe(true);
    expect(checkAccessLimits({ readOnly: true, modules: [] }, 'POST', url, 'token').ok).toBe(false);
  });
});

describe('API 令牌：只读与模块白名单', () => {
  const ro = { readOnly: true, modules: [] };

  it('只读令牌的 GET 放行，POST 拒绝并给 TOKEN_READONLY（错误码要能和模拟区分开）', () => {
    expect(checkAccessLimits(ro, 'GET', '/api/v1/students', 'token').ok).toBe(true);
    const r = checkAccessLimits(ro, 'POST', '/api/v1/students', 'token');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('TOKEN_READONLY');
  });

  it('/auth/me 不被只读拦住（CLI 的 whoami 要用）', () => {
    expect(checkAccessLimits(ro, 'GET', '/api/v1/auth/me', 'token').ok).toBe(true);
  });

  it('模块白名单外的路径越界；未归入模块的公共接口放行', () => {
    const lim = { readOnly: false, modules: ['markbook'] };
    expect(checkAccessLimits(lim, 'GET', '/api/v1/markbook/classes', 'token').ok).toBe(true);
    const bad = checkAccessLimits(lim, 'GET', '/api/v1/students', 'token');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe('TOKEN_MODULE_DENIED');
    // 字典/公共数据不归任何模块 ⇒ 放行（白名单不是「把页面弄坏」）
    expect(checkAccessLimits(lim, 'GET', '/api/v1/dictionaries', 'token').ok).toBe(true);
  });

  it('没有限制项的令牌不该被额外拦住（除了硬拒路径）', () => {
    expect(checkAccessLimits(undefined, 'POST', '/api/v1/students', 'token').ok).toBe(true);
  });
});
