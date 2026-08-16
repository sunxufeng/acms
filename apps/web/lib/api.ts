/** 前端 API 客户端：统一 fetch 封装，自动带 cookie、统一错误处理、401 跳登录 */
const API_BASE = '/api/v1';

export interface ApiError {
  error: { code: string; message: string; requestId: string };
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  });
  if (res.status === 401) {
    if (typeof window !== 'undefined') window.location.href = '/login';
    throw new Error('UNAUTHENTICATED');
  }
  if (!res.ok) {
    let body: ApiError | null = null;
    try {
      body = (await res.json()) as ApiError;
    } catch {
      /* ignore */
    }
    throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
  }
  // 导出接口返回纯文本（CSV）
  if (res.headers.get('Content-Type')?.includes('text/csv')) {
    return (await res.text()) as unknown as T;
  }
  return (await res.json()) as T;
}

export interface Page<T> {
  items: T[];
  total: number;
  pageToken?: string;
  hasMore: boolean;
}

export interface StudentRecord {
  id: string;
  [key: string]: unknown;
}

export const api = {
  /** 当前会话用户 */
  me: () => request<SessionUser>('/auth/me'),

  /** 学生列表 */
  listStudents: (params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') qs.set(k, v);
    }
    const q = qs.toString();
    return request<Page<StudentRecord>>(`/students${q ? `?${q}` : ''}`);
  },

  /** 学生详情 */
  getStudent: (id: string) => request<StudentRecord>(`/students/${id}`),

  /** 新建学生 */
  createStudent: (data: Record<string, unknown>) =>
    request<StudentRecord>('/students', { method: 'POST', body: JSON.stringify(data) }),

  /** 编辑学生 */
  updateStudent: (id: string, data: Record<string, unknown>) =>
    request<StudentRecord>(`/students/${id}`, { method: 'PUT', body: JSON.stringify(data) }),

  /** 归档 */
  archiveStudent: (id: string) =>
    request<{ ok: boolean }>(`/students/${id}`, { method: 'DELETE' }),

  /** 恢复 */
  restoreStudent: (id: string) =>
    request<{ ok: boolean }>(`/students/${id}/restore`, { method: 'PATCH' }),

  /** 导出 CSV */
  exportStudents: (params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') qs.set(k, v);
    }
    const q = qs.toString();
    return request<string>(`/students/export${q ? `?${q}` : ''}`);
  },

  /** 字典表：全部候选项 */
  dictionaries: () => request<Record<string, string[]>>('/dictionaries'),

  /** 更新单个字典候选项 */
  updateDictionary: (key: string, options: string[]) =>
    request<{ key: string; options: string[] }>(`/dictionaries/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify({ options }),
    }),

  /** 把字典候选项同步进飞书 Base 字段 */
  syncDictionaries: () => request<unknown>('/dictionaries/sync', { method: 'POST' }),

  // ── M2 教师域 ───────────────────────────────
  listTeachers: (params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, v);
    const q = qs.toString();
    return request<Page<Record<string, unknown>>>(`/teachers${q ? `?${q}` : ''}`);
  },
  createTeacher: (data: Record<string, unknown>) => request<Record<string, unknown>>('/teachers', { method: 'POST', body: JSON.stringify(data) }),
  updateTeacher: (id: string, data: Record<string, unknown>) => request<Record<string, unknown>>(`/teachers/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  archiveTeacher: (id: string) => request<{ ok: boolean }>(`/teachers/${id}`, { method: 'DELETE' }),

  // ── M2 课程方案 ─────────────────────────────
  listCoursePlans: (params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, v);
    const q = qs.toString();
    return request<Page<Record<string, unknown>>>(`/course-plans${q ? `?${q}` : ''}`);
  },
  createCoursePlan: (data: Record<string, unknown>) => request<Record<string, unknown>>('/course-plans', { method: 'POST', body: JSON.stringify(data) }),
  updateCoursePlan: (id: string, data: Record<string, unknown>) => request<Record<string, unknown>>(`/course-plans/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  archiveCoursePlan: (id: string) => request<{ ok: boolean }>(`/course-plans/${id}`, { method: 'DELETE' }),
  transitionCoursePlan: (id: string, to: string) => request<Record<string, unknown>>(`/course-plans/${id}/transition`, { method: 'POST', body: JSON.stringify({ to }) }),

  // ── M2 教学班 ───────────────────────────────
  listTeachingClasses: (params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, v);
    const q = qs.toString();
    return request<Page<Record<string, unknown>>>(`/teaching-classes${q ? `?${q}` : ''}`);
  },
  createTeachingClass: (data: Record<string, unknown>) => request<Record<string, unknown>>('/teaching-classes', { method: 'POST', body: JSON.stringify(data) }),
  updateTeachingClass: (id: string, data: Record<string, unknown>) => request<Record<string, unknown>>(`/teaching-classes/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  archiveTeachingClass: (id: string) => request<{ ok: boolean }>(`/teaching-classes/${id}`, { method: 'DELETE' }),
  transitionTeachingClass: (id: string, to: string) => request<Record<string, unknown>>(`/teaching-classes/${id}/transition`, { method: 'POST', body: JSON.stringify({ to }) }),

  // ── M2 场地资源 ─────────────────────────────
  listVenues: (params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, v);
    const q = qs.toString();
    return request<Page<Record<string, unknown>>>(`/venues${q ? `?${q}` : ''}`);
  },
  createVenue: (data: Record<string, unknown>) => request<Record<string, unknown>>('/venues', { method: 'POST', body: JSON.stringify(data) }),
  updateVenue: (id: string, data: Record<string, unknown>) => request<Record<string, unknown>>(`/venues/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  archiveVenue: (id: string) => request<{ ok: boolean }>(`/venues/${id}`, { method: 'DELETE' }),

  // ── M2 课次排课 ─────────────────────────────
  listSessions: (params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, v);
    const q = qs.toString();
    return request<Page<Record<string, unknown>>>(`/sessions${q ? `?${q}` : ''}`);
  },
  createSession: (data: Record<string, unknown>) => request<Record<string, unknown>>('/sessions', { method: 'POST', body: JSON.stringify(data) }),
  updateSession: (id: string, data: Record<string, unknown>) => request<Record<string, unknown>>(`/sessions/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  archiveSession: (id: string) => request<{ ok: boolean }>(`/sessions/${id}`, { method: 'DELETE' }),
  transitionSession: (id: string, to: string) => request<Record<string, unknown>>(`/sessions/${id}/transition`, { method: 'POST', body: JSON.stringify({ to }) }),
  /** 排课冲突预检 */
  precheckConflicts: (data: Record<string, unknown>) => request<{ hard: { type: string; sessionId: string; field: string }[]; soft: unknown[] }>('/schedule/conflicts:precheck', { method: 'POST', body: JSON.stringify(data) }),

  // ── M2 修读关系 ─────────────────────────────
  listEnrollments: (params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, v);
    const q = qs.toString();
    return request<Page<Record<string, unknown>>>(`/enrollments${q ? `?${q}` : ''}`);
  },
  createEnrollment: (data: Record<string, unknown>) => request<Record<string, unknown>>('/enrollments', { method: 'POST', body: JSON.stringify(data) }),
  updateEnrollment: (id: string, data: Record<string, unknown>) => request<Record<string, unknown>>(`/enrollments/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  archiveEnrollment: (id: string) => request<{ ok: boolean }>(`/enrollments/${id}`, { method: 'DELETE' }),
  transitionEnrollment: (id: string, to: string) => request<Record<string, unknown>>(`/enrollments/${id}/transition`, { method: 'POST', body: JSON.stringify({ to }) }),

  // ── M5 学生自助门户 ─────────────────────────
  portalMe: () => request<Record<string, unknown>>('/portal/me'),
  portalGrades: () => request<{ items: Record<string, unknown>[]; total: number }>('/portal/grades'),
  portalSchedule: () => request<{ items: Record<string, unknown>[]; total: number; classes: string[] }>('/portal/schedule'),
  portalTeachers: () => request<{ items: Record<string, unknown>[]; total: number }>('/portal/teachers'),
};

export interface SessionUser {
  openId: string;
  name: string;
  roles: string[];
  campuses: string[];
  maxDataLevel: string;
  sessionId: string;
  expiresAt: number;
}
