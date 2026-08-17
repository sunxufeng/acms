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

  /** 上传学生照片（multipart） */
  uploadStudentPhoto: (id: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<{ ok: boolean; file_token: string }>(
      `/students/${id}/photo`,
      { method: 'POST', body: form as any, headers: {} as Record<string, string> },
    );
  },

  /** 上传学生附件（multipart） */
  uploadStudentAttachment: (id: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<{ ok: boolean; file_token: string; name: string }>(
      `/students/${id}/attachments`,
      { method: 'POST', body: form as any, headers: {} as Record<string, string> },
    );
  },

  /** 获取附件下载 URL */
  getAttachmentUrl: (studentId: string, fileToken: string) =>
    request<{ url: string }>(`/students/${studentId}/attachment-url?file_token=${encodeURIComponent(fileToken)}`),

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

  listStudentAttendances: (params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, v);
    const q = qs.toString();
    return request<Page<Record<string, unknown>>>(`/student-attendances${q ? `?${q}` : ''}`);
  },
  createStudentAttendance: (data: Record<string, unknown>) => request<Record<string, unknown>>('/student-attendances', { method: 'POST', body: JSON.stringify(data) }),
  updateStudentAttendance: (id: string, data: Record<string, unknown>) => request<Record<string, unknown>>(`/student-attendances/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  archiveStudentAttendance: (id: string) => request<{ ok: boolean }>(`/student-attendances/${id}`, { method: 'DELETE' }),

  listGrades: (params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, v);
    const q = qs.toString();
    return request<Page<Record<string, unknown>>>(`/grades${q ? `?${q}` : ''}`);
  },
  createGrade: (data: Record<string, unknown>) => request<Record<string, unknown>>('/grades', { method: 'POST', body: JSON.stringify(data) }),
  updateGrade: (id: string, data: Record<string, unknown>) => request<Record<string, unknown>>(`/grades/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  archiveGrade: (id: string) => request<{ ok: boolean }>(`/grades/${id}`, { method: 'DELETE' }),

  listPracticeActivities: (params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, v);
    const q = qs.toString();
    return request<Page<Record<string, unknown>>>(`/practice-activities${q ? `?${q}` : ''}`);
  },
  createPracticeActivity: (data: Record<string, unknown>) => request<Record<string, unknown>>('/practice-activities', { method: 'POST', body: JSON.stringify(data) }),
  updatePracticeActivity: (id: string, data: Record<string, unknown>) => request<Record<string, unknown>>(`/practice-activities/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  archivePracticeActivity: (id: string) => request<{ ok: boolean }>(`/practice-activities/${id}`, { method: 'DELETE' }),

  listHomeSchoolComms: (params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, v);
    const q = qs.toString();
    return request<Page<Record<string, unknown>>>(`/home-school-comms${q ? `?${q}` : ''}`);
  },
  createHomeSchoolComm: (data: Record<string, unknown>) => request<Record<string, unknown>>('/home-school-comms', { method: 'POST', body: JSON.stringify(data) }),
  updateHomeSchoolComm: (id: string, data: Record<string, unknown>) => request<Record<string, unknown>>(`/home-school-comms/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  archiveHomeSchoolComm: (id: string) => request<{ ok: boolean }>(`/home-school-comms/${id}`, { method: 'DELETE' }),

  listStageEvaluations: (params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, v);
    const q = qs.toString();
    return request<Page<Record<string, unknown>>>(`/stage-evaluations${q ? `?${q}` : ''}`);
  },
  createStageEvaluation: (data: Record<string, unknown>) => request<Record<string, unknown>>('/stage-evaluations', { method: 'POST', body: JSON.stringify(data) }),
  updateStageEvaluation: (id: string, data: Record<string, unknown>) => request<Record<string, unknown>>(`/stage-evaluations/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  archiveStageEvaluation: (id: string) => request<{ ok: boolean }>(`/stage-evaluations/${id}`, { method: 'DELETE' }),

  listAlumniFollowups: (params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, v);
    const q = qs.toString();
    return request<Page<Record<string, unknown>>>(`/alumni-followups${q ? `?${q}` : ''}`);
  },
  createAlumniFollowup: (data: Record<string, unknown>) => request<Record<string, unknown>>('/alumni-followups', { method: 'POST', body: JSON.stringify(data) }),
  updateAlumniFollowup: (id: string, data: Record<string, unknown>) => request<Record<string, unknown>>(`/alumni-followups/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  archiveAlumniFollowup: (id: string) => request<{ ok: boolean }>(`/alumni-followups/${id}`, { method: 'DELETE' }),

  /** 学生 360 视图：聚合某学生的全生命周期记录 */
  student360: (studentId: string) =>
    request<{ student: Record<string, unknown>; sections: { key: string; label: string; items: Record<string, unknown>[] }[] }>(`/student-360/${studentId}`),

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

  // ── 审计日志（只读，需 admin:audit 权限） ─────────
  listAuditLogs: (params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, v);
    const q = qs.toString();
    return request<Page<Record<string, unknown>>>(`/audit-logs${q ? `?${q}` : ''}`);
  },
};

/** 通用导出：任一已注册飞书表 → CSV 下载（需 export:run 权限） */
export async function exportTable(table: string): Promise<void> {
  const res = await fetch(`${API_BASE}/export/${table}`, { credentials: 'include' });
  if (res.status === 401) {
    if (typeof window !== 'undefined') window.location.href = '/login';
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
  sessionId: string;
  expiresAt: number;
}
