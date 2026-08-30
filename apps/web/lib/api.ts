import type { HomepageConfig, NavMenuConfig, NavMenuGroupConfig, RoleDef } from '@acms/contracts';

/** 前端 API 客户端：统一 fetch 封装，自动带 cookie、统一错误处理、401 跳登录 */
const API_BASE = '/api/v1';

export interface ApiError {
  error?: { code: string; message: string; requestId: string };
  message?: string | string[];
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  // multipart 上传（FormData）不能带 Content-Type，必须由浏览器自动填充 boundary，
  // 否则服务端 multer/FileInterceptor 会因非 multipart/form-data 直接返回 400。
  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    headers: {
      ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
      ...(options.headers || {}),
    },
    ...options,
  });
  if (res.status === 401) {
    // 未登录：根据当前路径决定跳转目标，避免自刷新死循环。
    // 学生自助门户/学生登录走学生网页登录页，其余走飞书登录页。
    if (typeof window !== 'undefined') {
      const p = window.location.pathname;
      if (p === '/student-login' || p === '/portal') {
        if (p !== '/student-login') window.location.href = '/student-login';
      } else if (p !== '/login') {
        window.location.href = '/login';
      }
    }
    throw new Error('UNAUTHENTICATED');
  }
  if (!res.ok) {
    let message: string | undefined;
    try {
      const text = await res.text();
      if (text) {
        try {
          const body = JSON.parse(text) as ApiError;
          message = Array.isArray(body?.message)
            ? body.message.join('; ')
            : body?.message;
          message = body?.error?.message ?? message;
        } catch {
          message = text;
        }
      }
    } catch {
      /* ignore */
    }
    throw new Error(message ?? `HTTP ${res.status}`);
  }
  // 读取文本一次：空 body（如 200 无内容 / 204）视为 null，
  // 避免 res.json() 抛 “Unexpected end of JSON input”。
  const text = await res.text();
  if (!text) return null as unknown as T;
  // 导出接口返回纯文本（CSV）
  if (res.headers.get('Content-Type')?.includes('text/csv')) {
    return text as unknown as T;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    // 非 JSON（如纯文本响应）原样返回，避免解析失败
    return text as unknown as T;
  }
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

  /** 上传学生照片（multipart） */
  uploadStudentPhoto: (id: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<{ ok: boolean; file_token: string; viewUrl?: string; name?: string }>(`/students/${id}/photo`, {
      method: 'POST',
      body: form as unknown as BodyInit,
    });
  },

  /** 上传学生附件（multipart） */
  uploadStudentAttachment: (id: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<{ ok: boolean; file_token: string; name: string; viewUrl?: string }>(`/students/${id}/attachments`, {
      method: 'POST',
      body: form as unknown as BodyInit,
    });
  },

  /** 获取附件下载 URL */
  getAttachmentUrl: (studentId: string, fileToken: string) =>
    request<{ url: string }>(`/students/${studentId}/attachment-url?file_token=${encodeURIComponent(fileToken)}`),

  /** 移除学生附件（删除关联表记录，双向关联自动解除） */
  deleteStudentAttachment: (id: string, fileToken: string) =>
    request<{ ok: boolean }>(`/students/${id}/attachments/${encodeURIComponent(fileToken)}`, {
      method: 'DELETE',
    }),

  /** 移除学生照片（从「学生照片」字段摘除指定 file_token） */
  deleteStudentPhoto: (id: string, fileToken: string) =>
    request<{ ok: boolean }>(`/students/${id}/photo/${encodeURIComponent(fileToken)}`, {
      method: 'DELETE',
    }),

  /** 通用文件上传（家校沟通附件等）：音频 / 文本 / MD 等，返回 { ok, file_token, name } */
  uploadFile: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    // 单独传 filename 文本字段：busboy 对文本字段按 UTF-8 解码，
    // 而 multipart 的 filename 参数会被 multer 错判为 latin1 导致中文乱码。
    form.append('filename', file.name);
    return request<{ ok: boolean; file_token: string; name: string }>('/files/upload', {
      method: 'POST',
      body: form as unknown as BodyInit,
    });
  },

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
  /** 省 → 市级联映射 */
  provinceCities: () => request<Record<string, string[]>>('/dictionaries/province-cities'),

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
  /** 课次详情（编辑页加载用） */
  getSession: (id: string) => request<Record<string, unknown>>(`/sessions/${id}`),
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

  /** 学生网页自助登录：学号 + 姓名 → 种 cookie 会话（角色 student） */
  studentLogin: (studentNo: string, name: string) =>
    request<{ ok: boolean; studentId: string; name: string; campus: string }>('/student/auth/bind', {
      method: 'POST',
      body: JSON.stringify({ studentNo, name }),
    }),

  /** 学生门户：本人考勤记录 */
  portalAttendances: () => request<{ items: Record<string, unknown>[]; total: number }>('/portal/attendances'),
  /** 退出学生网页会话 */
  studentLogout: () => request<unknown>('/auth/logout', { method: 'POST' }),

  /** 学生密码登录：学号 + 密码 → 种 cookie 会话（角色 student） */
  studentPasswordLogin: (studentNo: string, password: string) =>
    request<{ ok: boolean; studentId: string; name: string; campus: string }>('/student-auth/login', {
      method: 'POST',
      body: JSON.stringify({ studentNo, password }),
    }),
  /** 学生自助设置密码：学号 + 姓名验证身份，成功后登录 */
  studentSetPassword: (studentNo: string, name: string, password: string) =>
    request<{ ok: boolean; studentId: string; name: string; campus: string }>('/student-auth/set-password', {
      method: 'POST',
      body: JSON.stringify({ studentNo, name, password }),
    }),
  /** 管理员为学生设置密码 */
  adminSetStudentPassword: (studentNo: string, password: string) =>
    request<{ ok: boolean }>('/student-auth/admin/set-password', {
      method: 'POST',
      body: JSON.stringify({ studentNo, password }),
    }),
  /** 管理员查看已开户学生密码账号清单 */
  studentAccounts: () =>
    request<{ items: Array<{ studentNo: string; name: string; studentId: string; campus: string; createdAt: string; updatedAt: string }> }>('/student-auth/accounts'),
  /** 管理员按学号 / 姓名检索学生并标注是否已开户 */
  studentSearch: (keyword: string) =>
    request<{ items: Array<{ studentNo: string; name: string; studentId: string; campus: string; hasAccount: boolean }> }>(`/student-auth/search?keyword=${encodeURIComponent(keyword)}`),

  /** 学生门户一键打卡：gps / wifi 二选一（studentId 由会话决定） */
  portalSign: (data: { mode: 'gps' | 'wifi'; gps?: string; ssid?: string; bssid?: string; at?: string }) =>
    request<{
      duplicated: boolean;
      passed: boolean;
      direction: string;
      method: string;
      distanceMeters: number | null;
      matchedCampus: string;
      record?: Record<string, unknown>;
    }>('/student-attendances/sign', { method: 'POST', body: JSON.stringify(data) }),

  // ── M3 教师履约 ─────────────────────────────
  listAttendances: (params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, v);
    const q = qs.toString();
    return request<Page<Record<string, unknown>>>(`/attendances${q ? `?${q}` : ''}`);
  },
  createAttendance: (data: Record<string, unknown>) => request<Record<string, unknown>>('/attendances', { method: 'POST', body: JSON.stringify(data) }),
  updateAttendance: (id: string, data: Record<string, unknown>) => request<Record<string, unknown>>(`/attendances/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  archiveAttendance: (id: string) => request<{ ok: boolean }>(`/attendances/${id}`, { method: 'DELETE' }),
  transitionAttendance: (id: string, to: string) => request<Record<string, unknown>>(`/attendances/${id}/transition`, { method: 'POST', body: JSON.stringify({ to }) }),

  // ── M3 聘用合作关系 ─────────────────────────
  listPartnerships: (params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, v);
    const q = qs.toString();
    return request<Page<Record<string, unknown>>>(`/partnerships${q ? `?${q}` : ''}`);
  },
  createPartnership: (data: Record<string, unknown>) => request<Record<string, unknown>>('/partnerships', { method: 'POST', body: JSON.stringify(data) }),
  updatePartnership: (id: string, data: Record<string, unknown>) => request<Record<string, unknown>>(`/partnerships/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  archivePartnership: (id: string) => request<{ ok: boolean }>(`/partnerships/${id}`, { method: 'DELETE' }),

  // ── M3 计费明细 ─────────────────────────────
  listBilling: (params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, v);
    const q = qs.toString();
    return request<Page<Record<string, unknown>>>(`/billing${q ? `?${q}` : ''}`);
  },
  createBilling: (data: Record<string, unknown>) => request<Record<string, unknown>>('/billing', { method: 'POST', body: JSON.stringify(data) }),
  updateBilling: (id: string, data: Record<string, unknown>) => request<Record<string, unknown>>(`/billing/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  archiveBilling: (id: string) => request<{ ok: boolean }>(`/billing/${id}`, { method: 'DELETE' }),
  transitionBilling: (id: string, to: string) => request<Record<string, unknown>>(`/billing/${id}/transition`, { method: 'POST', body: JSON.stringify({ to }) }),
  generateBilling: (attendanceId: string) => request<Record<string, unknown>>('/billing/generate', { method: 'POST', body: JSON.stringify({ attendanceId }) }),

  // ── M3 月度结算 ─────────────────────────────
  listSettlements: (params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, v);
    const q = qs.toString();
    return request<Page<Record<string, unknown>>>(`/settlements${q ? `?${q}` : ''}`);
  },
  createSettlement: (data: Record<string, unknown>) => request<Record<string, unknown>>('/settlements', { method: 'POST', body: JSON.stringify(data) }),
  updateSettlement: (id: string, data: Record<string, unknown>) => request<Record<string, unknown>>(`/settlements/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  archiveSettlement: (id: string) => request<{ ok: boolean }>(`/settlements/${id}`, { method: 'DELETE' }),
  transitionSettlement: (id: string, to: string) => request<Record<string, unknown>>(`/settlements/${id}/transition`, { method: 'POST', body: JSON.stringify({ to }) }),
  aggregateSettlement: (data: Record<string, unknown>) => request<Record<string, unknown>>('/settlements/aggregate', { method: 'POST', body: JSON.stringify(data) }),

  // ── M3 调整冲销 ─────────────────────────────
  listAdjustments: (params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, v);
    const q = qs.toString();
    return request<Page<Record<string, unknown>>>(`/adjustments${q ? `?${q}` : ''}`);
  },
  createAdjustment: (data: Record<string, unknown>) => request<Record<string, unknown>>('/adjustments', { method: 'POST', body: JSON.stringify(data) }),
  updateAdjustment: (id: string, data: Record<string, unknown>) => request<Record<string, unknown>>(`/adjustments/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  archiveAdjustment: (id: string) => request<{ ok: boolean }>(`/adjustments/${id}`, { method: 'DELETE' }),
  transitionAdjustment: (id: string, to: string) => request<Record<string, unknown>>(`/adjustments/${id}/transition`, { method: 'POST', body: JSON.stringify({ to }) }),

  // ── M4 通知闭环 ─────────────────────────────
  listTemplates: (params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, v);
    const q = qs.toString();
    return request<Page<Record<string, unknown>>>(`/notifications/templates${q ? `?${q}` : ''}`);
  },
  createTemplate: (data: Record<string, unknown>) => request<Record<string, unknown>>('/notifications/templates', { method: 'POST', body: JSON.stringify(data) }),
  updateTemplate: (id: string, data: Record<string, unknown>) => request<Record<string, unknown>>(`/notifications/templates/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  archiveTemplate: (id: string) => request<{ ok: boolean }>(`/notifications/templates/${id}`, { method: 'DELETE' }),
  listNotificationLogs: (params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, v);
    const q = qs.toString();
    return request<Page<Record<string, unknown>>>(`/notifications/logs${q ? `?${q}` : ''}`);
  },
  sendNotification: (data: Record<string, unknown>) => request<Record<string, unknown>>('/notifications/send', { method: 'POST', body: JSON.stringify(data) }),
  batchNotification: (data: Record<string, unknown>) => request<{ count: number; items: unknown[] }>('/notifications/batch', { method: 'POST', body: JSON.stringify(data) }),
  transitionNotificationLog: (id: string, to: string) => request<Record<string, unknown>>(`/notifications/logs/${id}/transition`, { method: 'POST', body: JSON.stringify({ to }) }),

  // ── M6 运营工作台 / 搜索 ────────────────────
  dashboardMetrics: () => request<{ cards: { key: string; label: string; value: number }[]; todos: { key: string; label: string; value: number }[]; exceptions: { key: string; label: string; value: number }[] }>('/dashboard/metrics'),
  globalSearch: (q: string) => request<{ students: { id: string; label: string }[]; teachers: { id: string; label: string }[]; courses: { id: string; label: string }[]; classes: { id: string; label: string }[] }>(`/search?q=${encodeURIComponent(q)}`),

  // ── M1 学生生命周期域（通用 CRUD） ───────────
  listSourceFollowups: (params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, v);
    const q = qs.toString();
    return request<Page<Record<string, unknown>>>(`/source-followups${q ? `?${q}` : ''}`);
  },
  createSourceFollowup: (data: Record<string, unknown>) => request<Record<string, unknown>>('/source-followups', { method: 'POST', body: JSON.stringify(data) }),
  updateSourceFollowup: (id: string, data: Record<string, unknown>) => request<Record<string, unknown>>(`/source-followups/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  archiveSourceFollowup: (id: string) => request<{ ok: boolean }>(`/source-followups/${id}`, { method: 'DELETE' }),
  /** 招生跟进单条记录（详情只读页用） */
  getSourceFollowup: (id: string) => request<Record<string, unknown>>(`/source-followups/${id}`),

  /** 招生跟进 AI 总结：准备数据（附件、当前明细/总结/沟通主题） */
  sourceFollowupAiPrepare: (id: string) =>
    request<{ attachments: { file_token: string; name: string }[]; currentDetail: string; currentSummary: string; content: string }>(
      `/source-followups-ai/${id}/prepare`,
    ),
  /** 招生跟进 AI 总结：合并所有附件生成沟通明细与总结 */
  sourceFollowupAiMergeAll: (id: string, overwriteDetail = false, overwriteSummary = false) =>
    request<{ ok: boolean; 沟通明细: string; 沟通总结: string; parsedAttachments: number; totalAttachments: number }>(
      `/source-followups-ai/${id}/merge-all`,
      { method: 'POST', body: JSON.stringify({ overwriteDetail, overwriteSummary }) },
    ),

  listStudentAttendances: (params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, v);
    const q = qs.toString();
    return request<Page<Record<string, unknown>>>(`/student-attendances${q ? `?${q}` : ''}`);
  },
  createStudentAttendance: (data: Record<string, unknown>) => request<Record<string, unknown>>('/student-attendances', { method: 'POST', body: JSON.stringify(data) }),
  updateStudentAttendance: (id: string, data: Record<string, unknown>) => request<Record<string, unknown>>(`/student-attendances/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  archiveStudentAttendance: (id: string) => request<{ ok: boolean }>(`/student-attendances/${id}`, { method: 'DELETE' }),
  /** 学生考勤单条记录（详情只读页用） */
  getStudentAttendance: (id: string) => request<Record<string, unknown>>(`/student-attendances/${id}`),

  listGrades: (params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, v);
    const q = qs.toString();
    return request<Page<Record<string, unknown>>>(`/grades${q ? `?${q}` : ''}`);
  },
  createGrade: (data: Record<string, unknown>) => request<Record<string, unknown>>('/grades', { method: 'POST', body: JSON.stringify(data) }),
  updateGrade: (id: string, data: Record<string, unknown>) => request<Record<string, unknown>>(`/grades/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  archiveGrade: (id: string) => request<{ ok: boolean }>(`/grades/${id}`, { method: 'DELETE' }),
  /** 学业成绩单条记录（详情只读页用） */
  getGrade: (id: string) => request<Record<string, unknown>>(`/grades/${id}`),

  listPracticeActivities: (params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, v);
    const q = qs.toString();
    return request<Page<Record<string, unknown>>>(`/practice-activities${q ? `?${q}` : ''}`);
  },
  createPracticeActivity: (data: Record<string, unknown>) => request<Record<string, unknown>>('/practice-activities', { method: 'POST', body: JSON.stringify(data) }),
  updatePracticeActivity: (id: string, data: Record<string, unknown>) => request<Record<string, unknown>>(`/practice-activities/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  archivePracticeActivity: (id: string) => request<{ ok: boolean }>(`/practice-activities/${id}`, { method: 'DELETE' }),
  /** 实践活动单条记录（详情只读页用） */
  getPracticeActivity: (id: string) => request<Record<string, unknown>>(`/practice-activities/${id}`),

  listHomeSchoolComms: (params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, v);
    const q = qs.toString();
    return request<Page<Record<string, unknown>>>(`/home-school-comms${q ? `?${q}` : ''}`);
  },
  /** 家校沟通单条记录（详情只读页用） */
  getHomeSchoolComm: (id: string) => request<Record<string, unknown>>(`/home-school-comms/${id}`),
  createHomeSchoolComm: (data: Record<string, unknown>) => request<Record<string, unknown>>('/home-school-comms', { method: 'POST', body: JSON.stringify(data) }),
  updateHomeSchoolComm: (id: string, data: Record<string, unknown>) => request<Record<string, unknown>>(`/home-school-comms/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  archiveHomeSchoolComm: (id: string) => request<{ ok: boolean }>(`/home-school-comms/${id}`, { method: 'DELETE' }),

  /** 家校沟通 AI 总结：准备数据（附件、当前明细/总结/沟通人备注） */
  aiSummarizePrepare: (id: string) =>
    request<{ attachments: { file_token: string; name: string }[]; currentDetail: string; currentSummary: string; content: string }>(
      `/home-school-comms-ai/${id}/prepare`,
    ),

  /** 家校沟通 AI 总结：同步单个附件到沟通明细 */
  aiSummarizeSyncAttachment: (id: string, fileToken: string, overwriteDetail = false) =>
    request<{ ok: boolean; synced: string; overwritten: boolean; 沟通明细: string }>(
      `/home-school-comms-ai/${id}/sync-attachment`,
      { method: 'POST', body: JSON.stringify({ fileToken, overwriteDetail }) },
    ),

  /** 家校沟通 AI 总结：合并所有附件生成沟通明细与总结 */
  aiSummarizeMergeAll: (id: string, overwriteDetail = false, overwriteSummary = false) =>
    request<{ ok: boolean; 沟通明细: string; 沟通总结: string; parsedAttachments: number; totalAttachments: number }>(
      `/home-school-comms-ai/${id}/merge-all`,
      { method: 'POST', body: JSON.stringify({ overwriteDetail, overwriteSummary }) },
    ),

  /** 日常跟进 AI 总结：准备数据（附件、当前明细/总结/沟通人备注） */
  dailyFollowupAiPrepare: (id: string) =>
    request<{ attachments: { file_token: string; name: string }[]; currentDetail: string; currentSummary: string; content: string }>(
      `/daily-followups-ai/${id}/prepare`,
    ),

  /** 日常跟进 AI 总结：同步单个附件到沟通明细 */
  dailyFollowupAiSyncAttachment: (id: string, fileToken: string, overwriteDetail = false) =>
    request<{ ok: boolean; synced: string; overwritten: boolean; 沟通明细: string }>(
      `/daily-followups-ai/${id}/sync-attachment`,
      { method: 'POST', body: JSON.stringify({ fileToken, overwriteDetail }) },
    ),

  /** 日常跟进 AI 总结：合并所有附件生成沟通明细与总结 */
  dailyFollowupAiMergeAll: (id: string, overwriteDetail = false, overwriteSummary = false) =>
    request<{ ok: boolean; 沟通明细: string; 沟通总结: string; parsedAttachments: number; totalAttachments: number }>(
      `/daily-followups-ai/${id}/merge-all`,
      { method: 'POST', body: JSON.stringify({ overwriteDetail, overwriteSummary }) },
    ),

  listDailyFollowups: (params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, v);
    const q = qs.toString();
    return request<Page<Record<string, unknown>>>(`/daily-followups${q ? `?${q}` : ''}`);
  },
  /** 日常跟进单条记录（详情只读页用） */
  getDailyFollowup: (id: string) => request<Record<string, unknown>>(`/daily-followups/${id}`),
  createDailyFollowup: (data: Record<string, unknown>) => request<Record<string, unknown>>('/daily-followups', { method: 'POST', body: JSON.stringify(data) }),
  updateDailyFollowup: (id: string, data: Record<string, unknown>) => request<Record<string, unknown>>(`/daily-followups/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  archiveDailyFollowup: (id: string) => request<{ ok: boolean }>(`/daily-followups/${id}`, { method: 'DELETE' }),

  listStageEvaluations: (params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, v);
    const q = qs.toString();
    return request<Page<Record<string, unknown>>>(`/stage-evaluations${q ? `?${q}` : ''}`);
  },
  createStageEvaluation: (data: Record<string, unknown>) => request<Record<string, unknown>>('/stage-evaluations', { method: 'POST', body: JSON.stringify(data) }),
  updateStageEvaluation: (id: string, data: Record<string, unknown>) => request<Record<string, unknown>>(`/stage-evaluations/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  archiveStageEvaluation: (id: string) => request<{ ok: boolean }>(`/stage-evaluations/${id}`, { method: 'DELETE' }),
  /** 阶段评价单条记录（详情只读页用） */
  getStageEvaluation: (id: string) => request<Record<string, unknown>>(`/stage-evaluations/${id}`),

  listAlumniFollowups: (params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, v);
    const q = qs.toString();
    return request<Page<Record<string, unknown>>>(`/alumni-followups${q ? `?${q}` : ''}`);
  },
  createAlumniFollowup: (data: Record<string, unknown>) => request<Record<string, unknown>>('/alumni-followups', { method: 'POST', body: JSON.stringify(data) }),
  updateAlumniFollowup: (id: string, data: Record<string, unknown>) => request<Record<string, unknown>>(`/alumni-followups/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  archiveAlumniFollowup: (id: string) => request<{ ok: boolean }>(`/alumni-followups/${id}`, { method: 'DELETE' }),
  /** 校友跟进单条记录（详情只读页用） */
  getAlumniFollowup: (id: string) => request<Record<string, unknown>>(`/alumni-followups/${id}`),

  /** 学生 360 视图：聚合某学生的全生命周期记录（sections 为维度中文名；为空表示全部维度） */
  student360: (studentId: string, params: { from?: string; to?: string; sections?: string[] } = {}) => {
    const qs = new URLSearchParams();
    if (params.from) qs.set('from', params.from);
    if (params.to) qs.set('to', params.to);
    if (params.sections && params.sections.length) qs.set('sections', params.sections.join(','));
    const q = qs.toString();
    return request<{ student: Record<string, unknown>; sections: { key: string; label: string; items: Record<string, unknown>[] }[] }>(
      `/student-360/${studentId}${q ? `?${q}` : ''}`,
    );
  },

  // ── 首页配置（登录页 / 登录页配置编辑器） ─────
  getHomepageConfig: () => request<HomepageConfig>('/homepage-config'),
  updateHomepageConfig: (data: HomepageConfig) =>
    request<{ ok: boolean }>('/homepage-config', { method: 'PUT', body: JSON.stringify(data) }),

  getMenuConfig: () => request<NavMenuConfig>('/homepage-config/menu'),
  updateMenuConfig: (data: NavMenuConfig) =>
    request<{ ok: boolean }>('/homepage-config/menu', { method: 'PUT', body: JSON.stringify(data) }),

  getMenuGroups: () => request<NavMenuGroupConfig>('/homepage-config/menu-groups'),
  updateMenuGroups: (data: NavMenuGroupConfig) =>
    request<{ ok: boolean }>('/homepage-config/menu-groups', { method: 'PUT', body: JSON.stringify(data) }),

  // ── 系统配置（通用 CRUD） ───────────────────
  listSettings: (params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, v);
    const q = qs.toString();
    return request<Page<Record<string, unknown>>>(`/settings${q ? `?${q}` : ''}`);
  },
  createSetting: (data: Record<string, unknown>) => request<Record<string, unknown>>('/settings', { method: 'POST', body: JSON.stringify(data) }),
  updateSetting: (id: string, data: Record<string, unknown>) => request<Record<string, unknown>>(`/settings/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  archiveSetting: (id: string) => request<{ ok: boolean }>(`/settings/${id}`, { method: 'DELETE' }),

  // ── 考勤围栏（GPS / WiFi 打卡区域配置，通用 CRUD） ──
  listAttendanceZones: (params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, v);
    const q = qs.toString();
    return request<Page<Record<string, unknown>>>(`/attendance-zones${q ? `?${q}` : ''}`);
  },
  createAttendanceZone: (data: Record<string, unknown>) => request<Record<string, unknown>>('/attendance-zones', { method: 'POST', body: JSON.stringify(data) }),
  updateAttendanceZone: (id: string, data: Record<string, unknown>) => request<Record<string, unknown>>(`/attendance-zones/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  archiveAttendanceZone: (id: string) => request<{ ok: boolean }>(`/attendance-zones/${id}`, { method: 'DELETE' }),

  // ── 微信用户（家长/学生登录绑定记录，通用 CRUD + 解绑/强制下线动作） ──
  listWechatBindings: (params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, v);
    const q = qs.toString();
    return request<Page<Record<string, unknown>>>(`/wechat-bindings${q ? `?${q}` : ''}`);
  },
  createWechatBinding: (data: Record<string, unknown>) => request<Record<string, unknown>>('/wechat-bindings', { method: 'POST', body: JSON.stringify(data) }),
  updateWechatBinding: (id: string, data: Record<string, unknown>) => request<Record<string, unknown>>(`/wechat-bindings/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  archiveWechatBinding: (id: string) => request<{ ok: boolean }>(`/wechat-bindings/${id}`, { method: 'DELETE' }),
  unbindWechatBinding: (id: string) => request<{ ok: boolean }>(`/wechat-binding-actions/unbind`, { method: 'POST', body: JSON.stringify({ id }) }),
  forceLogoutWechatBinding: (id: string) => request<{ ok: boolean }>(`/wechat-binding-actions/force-logout`, { method: 'POST', body: JSON.stringify({ id }) }),

  // ── 审计日志（只读，需 admin:audit 权限） ─────────
  listAuditLogs: (params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, v);
    const q = qs.toString();
    return request<Page<Record<string, unknown>>>(`/audit-logs${q ? `?${q}` : ''}`);
  },

  // ── 用户管理（需 admin:user 权限） ───────────
  listUsers: (params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, v);
    const q = qs.toString();
    return request<Page<Record<string, unknown>>>(`/users${q ? `?${q}` : ''}`);
  },
  getUser: (id: string) => request<Record<string, unknown>>(`/users/${id}`),
  createUser: (data: Record<string, unknown>) =>
    request<Record<string, unknown>>('/users', { method: 'POST', body: JSON.stringify(data) }),
  updateUser: (id: string, data: Record<string, unknown>) =>
    request<Record<string, unknown>>(`/users/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteUser: (id: string) => request<{ ok: boolean }>(`/users/${id}`, { method: 'DELETE' }),
  setUserStatus: (id: string, status: string) =>
    request<Record<string, unknown>>(`/users/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) }),

  // ── AI 域（acaily 迁移） ─────────────────────
  aiPresets: () => request<unknown[]>('/ai/presets'),
  aiGetConfig: () => request<Record<string, unknown> | null>('/ai/config/me'),
  aiSaveConfig: (data: Record<string, unknown>) =>
    request<Record<string, unknown>>('/ai/config/me', { method: 'POST', body: JSON.stringify(data) }),
  aiDeleteConfig: () => request<{ ok: boolean }>('/ai/config/me', { method: 'DELETE' }),
  aiTestConfig: (data: Record<string, unknown>) =>
    request<{ ok: boolean; error?: string }>('/ai/config/test', { method: 'POST', body: JSON.stringify(data) }),
  aiChat: (data: { message: string; sessionId?: string; model?: string; agentId?: string; history?: { role: string; content: string }[] }, signal?: AbortSignal) =>
    request<{ content: string; sessionId: string; steps: number }>('/ai/chat', { method: 'POST', body: JSON.stringify(data), signal }),
  aiListConversations: (q?: string) => request<{ id: string; title: string; updatedAt: string }[]>(`/ai/conversations${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  aiCreateConversation: (data: { title?: string }) =>
    request<{ id: string }>('/ai/conversations', { method: 'POST', body: JSON.stringify(data) }),
  aiGetConversation: (id: string) =>
    request<{ role: string; content: string }[]>(`/ai/conversations/${encodeURIComponent(id)}`),
  aiRenameConversation: (id: string, title: string) =>
    request<{ id: string; title: string }>(`/ai/conversations/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
  aiDeleteConversation: (id: string) =>
    request<{ ok: boolean }>(`/ai/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  aiGetOrgDefault: () => request<Record<string, unknown> | null>('/ai/org-default'),
  aiSaveOrgDefault: (data: Record<string, unknown>) =>
    request<Record<string, unknown>>('/ai/org-default', { method: 'POST', body: JSON.stringify(data) }),
  aiListAutomations: () => request<Record<string, unknown>[]>('/ai/automations'),
  aiGetAutomation: (id: string) =>
    request<Record<string, unknown>>(`/ai/automations/${encodeURIComponent(id)}`),
  aiCreateAutomation: (data: Record<string, unknown>) =>
    request<Record<string, unknown>>('/ai/automations', { method: 'POST', body: JSON.stringify(data) }),
  aiUpdateAutomation: (id: string, data: Record<string, unknown>) =>
    request<Record<string, unknown>>(`/ai/automations/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(data) }),
  aiDeleteAutomation: (id: string) =>
    request<{ ok: boolean }>(`/ai/automations/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  aiRunAutomation: (id: string) =>
    request<{ ok: boolean }>(`/ai/automations/${encodeURIComponent(id)}/run`, { method: 'POST' }),
  aiBuildCron: (data: { freq: string; hour?: number; minute?: number; weeklyDay?: number; monthlyDay?: number }) =>
    request<{ cron: string }>('/ai/cron/build', { method: 'POST', body: JSON.stringify(data) }),
  aiUsage: (rangeDays = 30) =>
    request<Record<string, unknown>>(`/ai/admin/usage?rangeDays=${rangeDays}`),
  aiAudit: (limit = 200) =>
    request<Record<string, unknown>[]>(`/ai/admin/audit?limit=${limit}`),
  aiListAgents: () => request<Record<string, unknown>[]>('/ai/agents'),
  aiGetAgent: (id: string) => request<Record<string, unknown> | null>(`/ai/agents/${encodeURIComponent(id)}`),
  aiCreateAgent: (data: Record<string, unknown>) =>
    request<Record<string, unknown>>('/ai/agents', { method: 'POST', body: JSON.stringify(data) }),
  aiUpdateAgent: (id: string, data: Record<string, unknown>) =>
    request<Record<string, unknown>>(`/ai/agents/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(data) }),
  aiDeleteAgent: (id: string) =>
    request<{ ok: boolean }>(`/ai/agents/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  aiTools: () => request<{ name: string; description: string }[]>('/ai/tools'),
  aiListSkills: () => request<Record<string, unknown>[]>('/ai/skills'),
  aiGetSkill: (name: string) => request<Record<string, unknown> | null>(`/ai/skills/${encodeURIComponent(name)}`),
  aiSaveSkill: (name: string, data: Record<string, unknown>) =>
    request<Record<string, unknown>>(`/ai/skills/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify(data) }),

  /** 权限模型 + 当前用户有效权限（菜单「权限与授权」使用） */
  getPermissions: () => request<PermissionsPayload>('/auth/permissions'),

  // ── 角色管理 ───────────────────────────────
  getRoleManagement: () => request<RoleManagementPayload>('/role-management'),
  createRole: (data: { key: string; label?: string; permissions: string[]; maxDataLevel: string }) =>
    request<RoleManagementPayload>('/role-management', { method: 'POST', body: JSON.stringify(data) }),
  updateRole: (key: string, data: { label?: string; permissions?: string[]; maxDataLevel?: string }) =>
    request<RoleManagementPayload>(`/role-management/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deleteRole: (key: string) =>
    request<{ ok: boolean }>(`/role-management/${encodeURIComponent(key)}`, { method: 'DELETE' }),

  // ── IDP 管理 ───────────────────────────────
  listIdpPlans: (params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, v);
    const q = qs.toString();
    return request<Page<Record<string, unknown>>>(`/idp-plans${q ? `?${q}` : ''}`);
  },
  getIdpPlan: (id: string) => request<Record<string, unknown>>(`/idp-plans/${id}`),
  createIdpPlan: (data: Record<string, unknown>) =>
    request<Record<string, unknown>>('/idp-plans', { method: 'POST', body: JSON.stringify(data) }),
  updateIdpPlan: (id: string, data: Record<string, unknown>) =>
    request<Record<string, unknown>>(`/idp-plans/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  archiveIdpPlan: (id: string) => request<{ ok: boolean }>(`/idp-plans/${id}`, { method: 'DELETE' }),
  transitionIdpPlan: (id: string, to: string) =>
    request<Record<string, unknown>>(`/idp-plans/${id}/transition`, { method: 'POST', body: JSON.stringify({ to }) }),

  listIdpCommunications: (params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, v);
    const q = qs.toString();
    return request<Page<Record<string, unknown>>>(`/idp-communications${q ? `?${q}` : ''}`);
  },
  getIdpCommunication: (id: string) => request<Record<string, unknown>>(`/idp-communications/${id}`),
  createIdpCommunication: (data: Record<string, unknown>) =>
    request<Record<string, unknown>>('/idp-communications', { method: 'POST', body: JSON.stringify(data) }),
  updateIdpCommunication: (id: string, data: Record<string, unknown>) =>
    request<Record<string, unknown>>(`/idp-communications/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  archiveIdpCommunication: (id: string) => request<{ ok: boolean }>(`/idp-communications/${id}`, { method: 'DELETE' }),

  // ── 邮件自动归档 ───────────────────────────────
  listMailAccounts: (params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, v);
    const q = qs.toString();
    return request<Page<Record<string, unknown>>>(`/mail-accounts${q ? `?${q}` : ''}`);
  },
  getMailAccount: (id: string) => request<Record<string, unknown>>(`/mail-accounts/${id}`),
  createMailAccount: (data: Record<string, unknown>) =>
    request<Record<string, unknown>>('/mail-accounts', { method: 'POST', body: JSON.stringify(data) }),
  updateMailAccount: (id: string, data: Record<string, unknown>) =>
    request<Record<string, unknown>>(`/mail-accounts/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  archiveMailAccount: (id: string) => request<{ ok: boolean }>(`/mail-accounts/${id}`, { method: 'DELETE' }),
  syncMailAccount: (id: string) => request<{ ok: boolean; fetched: number; stored: number; error?: string }>(`/mail-accounts/${id}/sync`, { method: 'POST' }),

  listMailArchive: (params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, v);
    const q = qs.toString();
    return request<Page<Record<string, unknown>>>(`/mail-archive${q ? `?${q}` : ''}`);
  },
  getMailArchive: (id: string) => request<Record<string, unknown>>(`/mail-archive/${id}`),
  /** 手动关联/解除关联学生：studentIds 为完整列表，传 [] 即清空 */
  linkMailStudents: (id: string, studentIds: string[]) =>
    request<{ ok: boolean }>(`/mail-archive/${id}/link`, { method: 'PUT', body: JSON.stringify({ studentIds }) }),
  syncAllMail: () => request<{ synced: number; results: Record<string, unknown> }>('/mail-archive/sync-all', { method: 'POST' }),
  getMailAttachmentUrl: (id: string, fileToken: string) =>
    request<{ url: string }>(`/mail-archive/${id}/attachment-url?file_token=${encodeURIComponent(fileToken)}`),
};

export interface PermissionsPayload {
  roles: string[];
  permissions: string[];
  matrix: Record<string, string[]>;
  dataLevels: string[];
  myRoles: string[];
  myMaxDataLevel: string;
  myPermissions: string[];
}

export interface RoleManagementPayload {
  roles: RoleDef[];
  allPermissions: string[];
  dataLevels: string[];
  /** 新建角色时自动同步到飞书「系统角色」字段的选项名（仅 createRole 返回） */
  syncedToFeishu?: string[];
}

/** 通用导出：任一已注册飞书表 → CSV 下载（需 export:run 权限） */
export async function exportTable(table: string): Promise<void> {
  const res = await fetch(`${API_BASE}/export/${table}`, { credentials: 'include' });
  if (res.status === 401) {
    // 未登录：与 request() 一致，按当前路径分流到飞书/学生登录页
    if (typeof window !== 'undefined') {
      const p = window.location.pathname;
      if (p === '/student-login' || p === '/portal') {
        if (p !== '/student-login') window.location.href = '/student-login';
      } else if (p !== '/login') {
        window.location.href = '/login';
      }
    }
    throw new Error('UNAUTHENTICATED');
  }
  if (!res.ok) throw new Error(`导出失败 HTTP ${res.status}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${table}_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export interface SessionUser {
  openId: string;
  name: string;
  roles: string[];
  campuses: string[];
  maxDataLevel: string;
  studentId?: string;
  sessionId: string;
  expiresAt: number;
}
