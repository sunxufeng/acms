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
