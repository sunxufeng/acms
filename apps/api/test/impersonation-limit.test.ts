import { describe, expect, it } from 'vitest';
import { checkImpersonation, normalizePath } from '../src/auth/impersonation-limit.js';

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
