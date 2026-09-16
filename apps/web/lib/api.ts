import type {
  HomepageConfig,
  NavMenuConfig,
  NavMenuGroupConfig,
  NoteConvertConfig,
  NoteConvertLogItem,
  NoteConfigMapItem,
  RoleDef,
} from '@acms/contracts';

// 「作业 → 成绩册同步」的请求 / 返回形状由面板组件（apps/web/components/markbook/
// HomeworkSyncPanel.tsx）单一维护 —— 那里是这套接口契约的文档所在（口径与坑都在注释里）。
// ⚠️ 只 import type：编译期擦除，不会产生 lib → components 的运行时依赖，也不成环。
//    两边字段一旦不一致，页面传参处会直接编译报错。
import type {
  HomeworkOption,
  HomeworkSyncPreview,
  HomeworkSyncQuery,
  HomeworkSyncResult,
} from '../components/markbook/HomeworkSyncPanel';

/** 前端 API 客户端：统一 fetch 封装，自动带 cookie、统一错误处理、401 跳登录 */
const API_BASE = '/api/v1';

export interface ApiError {
  error?: { code: string; message: string; requestId: string };
  message?: string | string[];
  /** 业务错误码。后端以对象形式抛 HttpException 时直接落在响应体顶层。 */
  code?: string;
}

/**
 * 带上结构化错误码的 Error。
 *
 * 后端把上游错误码翻成了 `GETNOTE_NOT_MEMBER` / `GETNOTE_AUTH_FAILED` /
 * `GETNOTE_RATE_LIMITED` 这类可识别的码，前端需要据此给出完全不同的提示
 * （非会员要引导开通，Key 无效要引导重填），光看 message 文案区分不了。
 * 只额外挂属性、不改 message，所有既有 catch 逻辑不受影响。
 */
export type ApiRequestError = Error & { apiCode?: string };

/** 字典候选项完整模型（与后端 DictOption 对齐）：key 稳定标识，label 展示名，aliases 历史曾用名 */
export interface DictOption {
  key: string;
  label: string;
  aliases?: string[];
}

/** 字典 /meta 响应：options 全量 + resolve 映射（旧值/别名/key → 当前 label） + 字段名→字典 key */
export interface DictMeta {
  options: Record<string, DictOption[]>;
  resolve: Record<string, Record<string, string>>;
  fieldDictKey: Record<string, string>;
}

/** 把存储值（旧 label / 别名 / key）解析为当前展示 label；未命中原样返回。 */
export function resolveDictValue(
  meta: DictMeta | null | undefined,
  dictKey: string,
  value: string,
): string {
  if (!meta || value == null) return value;
  const map = meta.resolve[dictKey];
  if (!map) return value;
  return map[value] ?? value;
}

/** 批量解析多选字段值数组。 */
export function resolveDictValues(
  meta: DictMeta | null | undefined,
  dictKey: string,
  values: string[],
): string[] {
  if (!Array.isArray(values)) return values;
  return values.map((v) => resolveDictValue(meta, dictKey, v));
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  // multipart 上传（FormData）不能带 Content-Type，必须由浏览器自动填充 boundary，
  // 否则服务端 multer/FileInterceptor 会因非 multipart/form-data 直接返回 400。
  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
  // 上游临时不可用自愈（2026-09-10 修复「立即收取」502）：
  // 部署/重启时 api 会短暂不监听端口，nginx 返回 502/503/504 或浏览器直接连接失败。
  // 这类错误请求通常没抵达后端（连接被拒），重试安全；最多重试 2 次、间隔 800ms，
  // 能把约 2s 的部署空窗完全掩盖，用户无感知。4xx/500 等业务错误不重试。
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const MAX_RETRY = 2;
  let res!: Response;
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    try {
      res = await fetch(`${API_BASE}${path}`, {
        credentials: 'include',
        headers: {
          ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
          ...(options.headers || {}),
        },
        ...options,
      });
    } catch (e) {
      // 网络层错误（连接拒绝 / 超时 / 断网）：重试
      if (attempt < MAX_RETRY) {
        await sleep(800);
        continue;
      }
      throw e;
    }
    // 502/503/504 视为瞬时上游错误，重试；其余状态直接跳出进入正常处理
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      if (attempt < MAX_RETRY) {
        await sleep(800);
        continue;
      }
      // 超出重试次数，落入下方统一错误处理
    } else {
      break;
    }
  }
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
    let parsed: ApiError | undefined;
    try {
      const text = await res.text();
      if (text) {
        try {
          const body = JSON.parse(text) as ApiError;
          parsed = body;
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
    const err: ApiRequestError = new Error(message ?? `HTTP ${res.status}`);
    err.apiCode = parsed?.code ?? parsed?.error?.code;
    throw err;
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

/** 邮件同步的实时进度（「立即收取」异步化后轮询展示） */
export interface MailSyncProgress {
  running: boolean;
  startedAt: number;
  finishedAt?: number;
  fetched: number;
  stored: number;
  folders?: { folder: string; isSent: boolean; fetched: number; stored: number; error?: string }[];
  error?: string;
  result?: string;
}

export interface StudentRecord {
  id: string;
  [key: string]: unknown;
}


/** 查询参数拼接（AI 路由模块用；空值不传） */
function qs(params: Record<string, string | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') sp.set(k, v);
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/** 联系人去重：组内一条记录（= 一条卫瓴联系人） */
export interface DedupMember {
  id: string;
  name: string;
  phone: string;
  remark: string;
  channel: string;
  owner: string;
  stage: string;
  /** 流失状态 */
  lost: string;
  /** 关联学生（已匹配时才有） */
  student: string;
  createdAt: number;
  lastFollowAt: number;
  score: number;
  /** 卫瓴联系人 ID（导出后回卫瓴核对） */
  weilingId: string;
  /** 建议保留（信息最全 + 创建最早） */
  keep: boolean;
  // 以下为后端判据用的内部字段，页面不展示
  phoneKey?: string;
  wxId?: string;
  studentName?: string;
}

export type DedupLevel = 'strong' | 'likely' | 'weak';

/** 联系人去重：一个疑似重复组 */
export interface DedupGroup {
  /** 稳定编号 G-001…（与导出清单一致） */
  key: string;
  label: string;
  level: DedupLevel;
  evidences: string[];
  members: DedupMember[];
}

export interface ContactDedupResult {
  generatedAt: number;
  stats: {
    total: number;
    noPhone: number;
    groups: number;
    records: number;
    mergeable: number;
    byLevel: Record<DedupLevel, number>;
  };
  groups: DedupGroup[];
  filterOptions: { channels: string[]; owners: string[] };
}

export const api = {
  /** 当前会话用户 */
  me: () => request<SessionUser>('/auth/me'),

  /** 通用 POST（如 CrudPage 批量导入 endpoint）。返回解析后的 JSON。 */
  post: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body) }),

  /** 学生列表 */
  listStudents: (params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') qs.set(k, v);
    }
    const q = qs.toString();
    return request<Page<StudentRecord>>(`/students${q ? `?${q}` : ''}`);
  },

  /**
   * 报表专用学生数据（权限点 report:read，与 student:read 解耦）。
   * 返回脱敏投影：维度字段为真值，其余字段为「有无」占位符，不含学生明细。
   */
  listReportStudents: () =>
    request<{ items: Record<string, unknown>[]; total: number }>('/reports/students'),

  /**
   * 联系人去重（需 `report:read`）：疑似同一个人的多条联系人记录。
   * level: strong（仅强证据）/ likely（默认，强+较可信）/ all（含仅同名）；
   * refresh=1 强制重算（后端默认缓存 5 分钟）。
   */
  getContactDedup: (
    params: { level?: string; channel?: string; owner?: string; refresh?: string } = {},
  ) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
    const q = qs.toString();
    return request<ContactDedupResult>(`/reports/contact-dedup${q ? `?${q}` : ''}`);
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

  /** 更新单个字典候选项（接受 DictOption[] 或遗留 string[]） */
  updateDictionary: (key: string, options: string[] | DictOption[]) =>
    request<{ key: string; options: DictOption[] }>(`/dictionaries/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify({ options }),
    }),

  /** 字典元数据（完整 DictOption[] + 旧值→当前名 resolve 映射）：供编辑器编辑 / CrudPage 显示解析 */
  dictionaryMeta: () => request<DictMeta>('/dictionaries/meta'),

  /** AI 文档（云文档内化）：列表 / 详情 / 创建 / 更新 / 删除 */
  aiDocs: {
    list: () => request<unknown[]>('/ai-docs'),
    get: (id: string) => request<Record<string, unknown>>(`/ai-docs/${encodeURIComponent(id)}`),
    create: (body: { title?: string; content?: string; refTable?: string; refRecord?: string }) =>
      request<{ id: string; url: string }>('/ai-docs', { method: 'POST', body: JSON.stringify(body) }),
    update: (id: string, body: { title?: string; content?: string }) =>
      request<{ ok: boolean }>(`/ai-docs/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) }),
    remove: (id: string) => request<{ ok: boolean }>(`/ai-docs/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },

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

  /** 卫瓴SCRM 联系人（2026-09-11 新增）：只读，数据由后台从卫瓴同步 */
  listWeilingContacts: (params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, v);
    const q = qs.toString();
    return request<Page<Record<string, unknown>>>(`/weiling-contacts${q ? `?${q}` : ''}`);
  },
  getWeilingContact: (id: string) => request<Record<string, unknown>>(`/weiling-contacts/${id}`),
  weilingFields: (refresh?: boolean) =>
    request<{ api_name: string; view_name: string; property_type?: number; options?: { label: string; value: string }[] }[]>(
      `/weiling/fields${refresh ? '?refresh=1' : ''}`,
    ),
  getWeilingProgress: (contactId: string) =>
    request<{ 跟进时间: number; 跟进人: string; 跟进内容: string; 图片: string; 附件: string }[]>(
      `/weiling/progress?contactId=${encodeURIComponent(contactId)}`,
    ),
  syncWeilingProgress: (full = true) =>
    request<{ ok: boolean; started: boolean; message?: string }>(`/weiling/sync-progress${full ? '' : '?full=0'}`, {
      method: 'POST',
    }),
  /** 重算「跟进次数」缓存（与跟进记录表对齐；同步快照漂移时用） */
  recountWeilingFollows: () =>
    request<{ scanned: number; fixed: number }>('/weiling/recount-follows', { method: 'POST' }),
  syncWeilingLost: () =>
    request<{ ok: boolean; started: boolean; message?: string }>('/weiling/sync-lost', { method: 'POST' }),
  weilingAnalyze: (params: { from?: string; to?: string; owner?: string; channel?: string; stage?: string } = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, v);
    const q = qs.toString();
    return request<unknown>(`/weiling/analyze${q ? `?${q}` : ''}`);
  },
  // ── AI 路由（acapi 网关移植）────────────────────────────────
  // 六张表都由 generic-crud 承载，路径即 RecordMeta.path；另加 4 个专用接口。
  listAiRouteGroups: (params: Record<string, string | undefined> = {}) =>
    request<Page<Record<string, unknown>>>(`/ai-route-groups${qs(params)}`),
  getAiRouteGroup: (id: string) => request<Record<string, unknown>>(`/ai-route-groups/${id}`),
  createAiRouteGroup: (d: Record<string, unknown>) =>
    request('/ai-route-groups', { method: 'POST', body: JSON.stringify(d) }),
  updateAiRouteGroup: (id: string, d: Record<string, unknown>) =>
    request(`/ai-route-groups/${id}`, { method: 'PUT', body: JSON.stringify(d) }),
  deleteAiRouteGroup: (id: string) => request(`/ai-route-groups/${id}`, { method: 'DELETE' }),

  listAiUpstreams: (params: Record<string, string | undefined> = {}) =>
    request<Page<Record<string, unknown>>>(`/ai-upstreams${qs(params)}`),
  getAiUpstream: (id: string) => request<Record<string, unknown>>(`/ai-upstreams/${id}`),
  createAiUpstream: (d: Record<string, unknown>) => request('/ai-upstreams', { method: 'POST', body: JSON.stringify(d) }),
  updateAiUpstream: (id: string, d: Record<string, unknown>) =>
    request(`/ai-upstreams/${id}`, { method: 'PUT', body: JSON.stringify(d) }),
  deleteAiUpstream: (id: string) => request(`/ai-upstreams/${id}`, { method: 'DELETE' }),
  /** 查看上游凭证明文（会记操作日志）。列表永远只有掩码 ****** */
  revealAiUpstreamSecret: (id: string) =>
    request<{ credential: Record<string, string> }>(`/ai-upstreams/${id}/secret`, { method: 'POST' }),
  /** 立即体检所有启用上游（探测 /models） */
  aiUpstreamHealthCheck: () =>
    request<{ checked: number; ok: number; bad: number }>('/ai-upstreams/health-check', { method: 'POST' }),

  /** 单账号测试连接（探测上游 /models），比全量体检更精准的排障入口 */
  testAiUpstream: (id: string) =>
    request<{ ok: boolean; status: number; latencyMs: number; modelCount: number; error: string }>(
      `/ai-upstreams/${id}/test`,
      { method: 'POST' },
    ),
  /** 单账号用量统计：今日 / 近 7 天 / 近 30 天 / 累计 + 按模型 */
  aiUpstreamStats: (id: string) =>
    request<{
      name: string;
      windows: { label: string; calls: number; tokens: number; costUsd: number }[];
      byModel: { model: string; calls: number; tokens: number; costUsd: number }[];
      lastError: string;
    }>(`/ai-upstreams/${id}/stats`),
  /** 复制账号（凭证密文原样带过去，只清运行时状态） */
  duplicateAiUpstream: (id: string) =>
    request<{ id: string; name: string }>(`/ai-upstreams/${id}/duplicate`, { method: 'POST' }),
  /** 批量动作：enable-schedule / disable-schedule / reset-state / delete / patch */
  bulkAiUpstream: (action: string, ids: string[], patch: Record<string, unknown> = {}) =>
    request<{ ok: number; failed: number; message: string }>('/ai-upstreams/bulk', {
      method: 'POST',
      body: JSON.stringify({ action, ids, patch }),
    }),
  /** 从上游同步「支持模型」清单（新建时用表单里正在填的 BaseURL + 凭证探测） */
  aiUpstreamSyncModels: (body: {
    baseUrl?: string;
    provider?: string;
    credential?: Record<string, string>;
    upstreamId?: string;
  }) =>
    request<{ models: string[]; source: string; warnings: string[] }>('/ai-upstreams/models/sync', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** 重置账号调度状态（清限流/过载/临时摘除冷却） */
  resetAiUpstreamState: (id: string) =>
    request<{ ok: boolean }>(`/ai-upstreams/${id}/reset-state`, { method: 'POST' }),

  // ── AI 上游代理 ──
  listAiProxies: (params: Record<string, string | undefined> = {}) =>
    request<Page<Record<string, unknown>>>(`/ai-proxies${qs(params)}`),
  createAiProxy: (d: Record<string, unknown>) => request('/ai-proxies', { method: 'POST', body: JSON.stringify(d) }),
  updateAiProxy: (id: string, d: Record<string, unknown>) =>
    request(`/ai-proxies/${id}`, { method: 'PUT', body: JSON.stringify(d) }),
  deleteAiProxy: (id: string) => request(`/ai-proxies/${id}`, { method: 'DELETE' }),

  listAiModelRoutes: (params: Record<string, string | undefined> = {}) =>
    request<Page<Record<string, unknown>>>(`/ai-model-routes${qs(params)}`),
  createAiModelRoute: (d: Record<string, unknown>) =>
    request('/ai-model-routes', { method: 'POST', body: JSON.stringify(d) }),
  updateAiModelRoute: (id: string, d: Record<string, unknown>) =>
    request(`/ai-model-routes/${id}`, { method: 'PUT', body: JSON.stringify(d) }),
  deleteAiModelRoute: (id: string) => request(`/ai-model-routes/${id}`, { method: 'DELETE' }),

  listAiApiKeys: (params: Record<string, string | undefined> = {}) =>
    request<Page<Record<string, unknown>>>(`/ai-api-keys${qs(params)}`),
  /** 代发密钥：返回体里的 key 是明文，只此一次 */
  mintAiApiKey: (d: Record<string, unknown>) =>
    request<{ id: string; key: string; prefix: string }>('/ai-api-keys/mint', {
      method: 'POST',
      body: JSON.stringify(d),
    }),
  revokeAiApiKey: (id: string) => request<{ ok: boolean }>(`/ai-api-keys/${id}/revoke`, { method: 'POST' }),

  listAiUsage: (params: Record<string, string | undefined> = {}) =>
    request<Page<Record<string, unknown>>>(`/ai-usage${qs(params)}`),
  aiUsageStats: (params: Record<string, string | undefined> = {}) =>
    request<{
      totals: { calls: number; promptTokens: number; completionTokens: number; totalTokens: number; costUsd: number };
      byModel: { name: string; calls: number; tokens: number; costUsd: number }[];
      byUser: { name: string; calls: number; tokens: number; costUsd: number }[];
      byDay: { day: string; calls: number; tokens: number; costUsd: number }[];
      truncated: boolean;
    }>(`/ai-usage/stats${qs(params)}`),

  listAiOpLogs: (params: Record<string, string | undefined> = {}) =>
    request<Page<Record<string, unknown>>>(`/ai-op-logs${qs(params)}`),

  /**
   * 联系人筛选下拉的可选值（客户阶段 / 来源渠道 / 归属人），取自本地联系人表的实际取值。
   * ⚠️ 不要改用 weilingFields() 的枚举：那套 options 是 `{label: 数字编码, value: 中文名}`，
   * 取 label 会在筛选框里显示成一串数字（2026-09-13 用户报的现场）；而且渠道有父子层级、
   * 缓存的枚举值跟表里存的值对不上，拿它当筛选项会一条都筛不出来。
   */
  weilingContactFilterOptions: () => request<Record<string, string[]>>('/weiling/contact-filter-options'),

  weilingSyncStatus: () =>
    request<{
      lastSyncAt: number;
      count: number;
      syncing: boolean;
      progress?: { running: boolean; done: boolean; scanned: number; contacts: number; records: number; error: string };
      lost?: {
        running: boolean;
        done: boolean;
        total: number;
        scanned: number;
        lost: number;
        kept: number;
        skipped: number;
        error: string;
      };
    }>('/weiling/sync-status'),
  weilingSync: (full = true) =>
    request<{ ok: boolean; count: number; message?: string }>(`/weiling/sync${full ? '' : '?full=0'}`, { method: 'POST' }),

  /** 开放平台：外接系统应用凭证（2026-09-11 新增）。App Secret 读取侧恒为掩码 ****** */
  listOpenPlatformApps: (params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, v);
    const q = qs.toString();
    return request<Page<Record<string, unknown>>>(`/open-platform${q ? `?${q}` : ''}`);
  },
  getOpenPlatformApp: (id: string) => request<Record<string, unknown>>(`/open-platform/${id}`),
  createOpenPlatformApp: (data: Record<string, unknown>) =>
    request<Record<string, unknown>>('/open-platform', { method: 'POST', body: JSON.stringify(data) }),
  updateOpenPlatformApp: (id: string, data: Record<string, unknown>) =>
    request<Record<string, unknown>>(`/open-platform/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  archiveOpenPlatformApp: (id: string) => request<{ ok: boolean }>(`/open-platform/${id}`, { method: 'DELETE' }),

  /** 会议纪要（组织管理域，2026-09-11 新增）：与日常跟进同构，主体为部门 */
  listMeetingMinutes: (params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, v);
    const q = qs.toString();
    return request<Page<Record<string, unknown>>>(`/meeting-minutes${q ? `?${q}` : ''}`);
  },
  /** 会议纪要单条记录（详情只读页用） */
  getMeetingMinute: (id: string) => request<Record<string, unknown>>(`/meeting-minutes/${id}`),
  createMeetingMinute: (data: Record<string, unknown>) => request<Record<string, unknown>>('/meeting-minutes', { method: 'POST', body: JSON.stringify(data) }),
  updateMeetingMinute: (id: string, data: Record<string, unknown>) => request<Record<string, unknown>>(`/meeting-minutes/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  archiveMeetingMinute: (id: string) => request<{ ok: boolean }>(`/meeting-minutes/${id}`, { method: 'DELETE' }),

  /** 学生观察 AI 总结：准备数据（附件、当前明细/总结/观察人备注） */
  studentObservationAiPrepare: (id: string) =>
    request<{ attachments: { file_token: string; name: string }[]; currentDetail: string; currentSummary: string; content: string }>(
      `/student-observations-ai/${id}/prepare`,
    ),

  /** 学生观察 AI 总结：同步单个附件到观察明细 */
  studentObservationAiSyncAttachment: (id: string, fileToken: string, overwriteDetail = false) =>
    request<{ ok: boolean; synced: string; overwritten: boolean; 沟通明细: string }>(
      `/student-observations-ai/${id}/sync-attachment`,
      { method: 'POST', body: JSON.stringify({ fileToken, overwriteDetail }) },
    ),

  /** 学生观察 AI 总结：合并所有附件生成观察明细与总结 */
  studentObservationAiMergeAll: (id: string, overwriteDetail = false, overwriteSummary = false) =>
    request<{ ok: boolean; 沟通明细: string; 沟通总结: string; parsedAttachments: number; totalAttachments: number }>(
      `/student-observations-ai/${id}/merge-all`,
      { method: 'POST', body: JSON.stringify({ overwriteDetail, overwriteSummary }) },
    ),

  listStudentObservations: (params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, v);
    const q = qs.toString();
    return request<Page<Record<string, unknown>>>(`/student-observations${q ? `?${q}` : ''}`);
  },
  /** 学生观察单条记录（详情只读页用） */
  getStudentObservation: (id: string) => request<Record<string, unknown>>(`/student-observations/${id}`),
  createStudentObservation: (data: Record<string, unknown>) => request<Record<string, unknown>>('/student-observations', { method: 'POST', body: JSON.stringify(data) }),
  updateStudentObservation: (id: string, data: Record<string, unknown>) => request<Record<string, unknown>>(`/student-observations/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  archiveStudentObservation: (id: string) => request<{ ok: boolean }>(`/student-observations/${id}`, { method: 'DELETE' }),

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

  getNoteConvert: () => request<NoteConvertConfig>('/homepage-config/note-convert'),
  updateNoteConvert: (data: NoteConvertConfig) =>
    request<{ ok: boolean }>('/homepage-config/note-convert', { method: 'PUT', body: JSON.stringify(data) }),

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
  /** 人员姓名列表：全员可读、只返回姓名，供主持人/记录人等下拉使用
   *  （listUsers 需要 admin:user，普通角色会 403 导致下拉为空） */
  listUserNames: () => request<string[]>('/users/names'),
  /** 人员目录：全员可读，含 Open ID / 教师类型 / 校区 / 角色（不含密级、账号状态）。
   *  班主任、招生老师等字段存的是 Open ID，只拿姓名无法完成还原。
   *  `id` 是用户记录的 record id —— 「关联字段」存的是 record id，选人控件需要它。 */
  listUserDirectory: () =>
    request<{ id: string; name: string; openId: string; teacherType: string; campus: string; roles: string[] }[]>(
      '/users/directory',
    ),
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

  // ── 系统监控（需 admin:monitor 权限） ─────
  systemStatus: () => request<SystemStatusPayload>('/system/status'),

  // ── 笔记统计（需 report:read 权限） ─────
  syncNoteSnapshot: () =>
    request<{ ok: boolean; count: number; message?: string }>('/getnote/sync-snapshot', { method: 'POST' }),
  noteStats: (params: { from?: string; to?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.from) qs.set('from', params.from);
    if (params.to) qs.set('to', params.to);
    const q = qs.toString();
    return request<NoteStatsPayload>(`/reports/notes${q ? `?${q}` : ''}`);
  },

  // ── 活跃时段统计（需 report:read 权限） ─────
  activity: (params: { from?: string; to?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.from) qs.set('from', params.from);
    if (params.to) qs.set('to', params.to);
    const q = qs.toString();
    return request<ActivityPayload>(`/reports/activity${q ? `?${q}` : ''}`);
  },
  createRole: (data: { key: string; label?: string; permissions: string[]; maxDataLevel: string; menus?: string[]; dataScope?: unknown }) =>
    request<RoleManagementPayload>('/role-management', { method: 'POST', body: JSON.stringify(data) }),
  updateRole: (key: string, data: { label?: string; permissions?: string[]; maxDataLevel?: string; menus?: string[]; dataScope?: unknown }) =>
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
  // 立即收取是异步的：POST 立即返回，之后轮询 sync-status 拿实时进度
  syncMailAccount: (id: string) => request<MailSyncProgress>(`/mail-accounts/${id}/sync`, { method: 'POST' }),
  getMailSyncStatus: (id: string) => request<MailSyncProgress>(`/mail-accounts/${id}/sync-status`),

  listMailArchive: (params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, v);
    const q = qs.toString();
    return request<Page<Record<string, unknown>>>(`/mail-archive${q ? `?${q}` : ''}`);
  },
  getMailArchive: (id: string) => request<Record<string, unknown>>(`/mail-archive/${id}`),
  /** 列表页筛选下拉的动态候选项（发件人/收件人/归属账户/邮箱文件夹/关联学生的真实去重值） */
  listMailArchiveFilterOptions: () =>
    request<Record<string, string[]>>('/mail-archive/filter-options'),
  /** 手动关联/解除关联**学生**：studentIds 为完整列表，传 [] 即清空 */
  linkMailStudents: (id: string, studentIds: string[]) =>
    request<{ ok: boolean }>(`/mail-archive/${id}/link`, { method: 'PUT', body: JSON.stringify({ studentIds }) }),
  /** 手动关联/解除关联**联系人**（卫瓴）：contactIds 为完整列表，传 [] 即清空。
   *  与学生共用同一个接口，只传一类时另一类保持不动。 */
  linkMailContacts: (id: string, contactIds: string[]) =>
    request<{ ok: boolean }>(`/mail-archive/${id}/link`, { method: 'PUT', body: JSON.stringify({ contactIds }) }),
  syncAllMail: () => request<{ synced: number; results: Record<string, unknown> }>('/mail-archive/sync-all', { method: 'POST' }),
  getMailAttachmentUrl: (id: string, fileToken: string) =>
    request<{ url: string }>(`/mail-archive/${id}/attachment-url?file_token=${encodeURIComponent(fileToken)}`),

  // ── 得到大脑（Get笔记）知识库 ──────────────────────────────────────────
  // ⚠️ 凭证模型（2026-09-05 二次修正）：Client ID 与 API Key **都是每人一份**。
  //    官方「创建应用 → 获取 Client ID 和 API Key」是成对拿到的，所以用户能完全
  //    自助，服务器不需要配任何东西（早期版本要管理员配 Client ID，已废弃）。
  //    官方限流按 Key 算（QPS 2 / 每天 5000 次），共用一份会直接撞墙。
  // ⚠️ 笔记 ID 是字符串形态的 int64，全程不要转 Number（会丢精度）。
  getGetnoteCredential: () => request<GetnoteCredential>('/getnote/credential'),
  /** 保存前服务端会先打一次真实请求验活，验不过不落库（非会员会在这里被拦下） */
  saveGetnoteCredential: (apiKey: string, clientId: string) =>
    request<GetnoteCredential & { verified: boolean }>('/getnote/credential', {
      method: 'PUT',
      body: JSON.stringify({ apiKey, clientId }),
    }),
  clearGetnoteCredential: () => request<{ ok: boolean }>('/getnote/credential', { method: 'DELETE' }),
  /** OAuth 设备授权第 1 步：换设备码。未开启一键授权时返回 503。 */
  startGetnoteOAuth: () => request<GetnoteOAuthStart>('/getnote/oauth/start', { method: 'POST' }),
  /** OAuth 第 2 步：按服务端给的 interval 定时轮询，不要自己改快 */
  pollGetnoteOAuth: () => request<GetnoteOAuthPoll>('/getnote/oauth/poll'),
  cancelGetnoteOAuth: () => request<{ ok: boolean }>('/getnote/oauth', { method: 'DELETE' }),
  listGetnote: (params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, v);
    const q = qs.toString();
    return request<Page<Record<string, unknown>>>(`/getnote/notes${q ? `?${q}` : ''}`);
  },
  getGetnote: (id: string) => request<Record<string, unknown>>(`/getnote/notes/${id}`),
  createGetnote: (data: Record<string, unknown>) =>
    request<Record<string, unknown>>('/getnote/notes', { method: 'POST', body: JSON.stringify(data) }),
  updateGetnote: (id: string, data: Record<string, unknown>) =>
    request<Record<string, unknown>>(`/getnote/notes/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteGetnote: (id: string) => request<{ ok: boolean }>(`/getnote/notes/${id}`, { method: 'DELETE' }),
  /** 语义搜索（不是关键字匹配）。返回的是相关片段，不是完整笔记。 */
  searchGetnote: (query: string, topK?: number) =>
    request<Record<string, unknown>[]>('/getnote/notes/search', {
      method: 'POST',
      body: JSON.stringify({ query, top_k: topK }),
    }),
  addGetnoteTags: (id: string, tags: string[]) =>
    request<Record<string, unknown>>(`/getnote/notes/${id}/tags`, {
      method: 'POST',
      body: JSON.stringify({ tags }),
    }),
  /** ⚠️ 删的是标签 ID（tags[].id），不是标签名 */
  removeGetnoteTag: (id: string, tagId: string) =>
    request<{ ok: boolean }>(`/getnote/notes/${id}/tags/${encodeURIComponent(tagId)}`, { method: 'DELETE' }),

  // ── 笔记转换留痕（存在 ACMS 自己的「笔记转换记录」表，不写 Get笔记 标签） ──
  // 为什么不用标签留痕：Get笔记 上游限制单篇笔记最多 5 个标签，system + ai 标签
  // 常已占掉 4 个，留痕挤不进去（上游报 tags length must be less than 5）。
  logNoteConvert: (data: {
    noteId: string;
    noteTitle?: string;
    moduleKey: string;
    moduleLabel: string;
  }) =>
    request<{ logId: string; count: number }>('/getnote/convert-log', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  /** 批量查留痕：列表页一次拿全，避免逐行请求 */
  listNoteConverts: (noteIds: string[]) =>
    request<Record<string, NoteConvertLogItem[]>>(
      `/getnote/convert-log?noteIds=${encodeURIComponent(noteIds.join(','))}`,
    ),
  /** 回填「转成了哪条业务记录」，目标页保存成功后调用 */
  linkNoteConvert: (logId: string, targetRecordId: string) =>
    request<{ ok: boolean }>(`/getnote/convert-log/${encodeURIComponent(logId)}/target`, {
      method: 'PUT',
      body: JSON.stringify({ targetRecordId }),
    }),
  /**
   * 批量查笔记归属（属于哪个知识库配置）：列表页一次拿全，避免逐行请求。
   * ⚠️ 后端单次最多接 100 个 id，超了要分批（见 getnote 页面的 fetchConfigMap）。
   */
  listNoteConfigMap: (noteIds: string[]) =>
    request<Record<string, NoteConfigMapItem>>(
      `/getnote/config-map?noteIds=${encodeURIComponent(noteIds.join(','))}`,
    ),

  // ── 笔记 ↔ 业务实体 关联（标签 + 映射表双写） ────────────────────────
  listGetnoteLinks: (entityType: string, entityId: string) =>
    request<GetnoteLink[]>(
      `/getnote/links?entityType=${encodeURIComponent(entityType)}&entityId=${encodeURIComponent(entityId)}`,
    ),
  /** 全量覆盖式写入：传空数组即清空，与邮件归档「手动关联学生」同范式 */
  replaceGetnoteLinks: (
    entityType: string,
    entityId: string,
    entityName: string,
    links: { noteId: string; title?: string }[],
  ) =>
    request<{ linked: number }>('/getnote/links', {
      method: 'PUT',
      body: JSON.stringify({ entityType, entityId, entityName, links }),
    }),
  /** 新建笔记并立刻关联到当前实体 */
  createAndLinkGetnote: (data: {
    title?: string;
    content?: string;
    tags?: string[];
    entityType: string;
    entityId: string;
    entityName?: string;
  }) =>
    request<Record<string, unknown> & { noteId?: string }>('/getnote/notes/link', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // ── 知识库配置（笔记来源 × 收取频率）────────────────────────────
  // 走独立的 getnote-sources 路由，落库在飞书「知识库配置」表（tblmKQtZ5IOgyhv6）。
  // 凭证字段后端永不下发明文，列表/详情里是空串；编辑时留空表示保留原值。
  listGetnoteSources: (params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, v);
    const q = qs.toString();
    return request<Page<Record<string, unknown>>>(`/getnote-sources${q ? `?${q}` : ''}`);
  },
  createGetnoteSource: (data: Record<string, unknown>) =>
    request<Record<string, unknown>>('/getnote-sources', { method: 'POST', body: JSON.stringify(data) }),
  updateGetnoteSource: (id: string, data: Record<string, unknown>) =>
    request<Record<string, unknown>>(`/getnote-sources/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  archiveGetnoteSource: (id: string) => request<{ ok: boolean }>(`/getnote-sources/${id}`, { method: 'DELETE' }),
  /** 测试连通性（按已保存记录 id）。非「得到大脑」的源返回 ok:false + note 提示未接入，不是异常。 */
  testGetnoteSource: (id: string) =>
    request<{ ok: boolean; sourceType: string; note: string }>(`/getnote-sources/${id}/test`, { method: 'POST' }),
  /** 免 id 测试连通性：新建/编辑表单里还没保存即可用填的凭证直接验活 */
  testGetnoteSourceCred: (data: { apiKey?: string; clientId?: string; 笔记类型?: string }) =>
    request<{ ok: boolean; sourceType: string; note: string }>('/getnote-sources/test', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  /** 立即收取：异步触发，立刻返回当前进度；之后轮询 sync-status */
  syncGetnoteSource: (id: string) => request<SourceSyncProgress>(`/getnote-sources/${id}/sync`, { method: 'POST' }),
  getGetnoteSourceSyncStatus: (id: string) => request<SourceSyncProgress>(`/getnote-sources/${id}/sync-status`),
  // ── 部门管理（组织管理）：只读同步飞书通讯录部门树 ──
  /** 读取全部部门（前端构建树；已删除部门 status='invalid' 由前端过滤） */
  /**
   * 学生档案「数据范围」的候选值（当前年级 / 当前状态 的实际去重值 + 人数 + 两维交叉计数）。
   * 配置界面（角色管理 ③ 数据范围、用户管理 学生档案范围）用它渲染可选项并实时算预览人数。
   * ⚠️ 取的是**学生表实际值**而不是字典：字典的入学年级是托班~高三 + G1~G12，与实际数据不符。
   */
  /**
   * 我自己的学生数据范围说明（学生档案页顶部提示条用）。
   * level: org / user-all / user-custom / role / none —— 用来区分是哪一层在限制。
   */
  myStudentScope: () =>
    request<{ level: string; visible: number; total: number; campuses: string[]; orgWide: boolean }>(
      '/students/my-scope',
    ),
  studentScopeOptions: () =>
    request<{
      dims: { dim: string; values: { value: string; count: number }[] }[];
      cross: { 当前年级: string; 当前状态: string; count: number }[];
      total: number;
    }>('/students/scope-options'),
  listDepartments: () => request<DepartmentListResult>('/departments'),
  /**
   * 部门成员快照的轻量索引（一次拿全，约几十行）。
   * 用户管理页左树用它给每个节点算「点进去能筛出几个系统账号」——
   * 逐部门调 listDepartmentMembers 会发 N 次请求。
   */
  departmentMemberIndex: () =>
    request<{ departmentId: string; departmentName: string; openId: string }[]>('/departments/member-index'),
  /** 立即同步飞书部门：异步触发，立刻返回当前进度；之后轮询 sync-status */
  syncDepartments: () => request<DepartmentSyncProgress>('/departments/sync', { method: 'POST' }),
  getDepartmentSyncStatus: () => request<DepartmentSyncProgress>('/departments/sync-status'),
  /** 某部门下的员工（读本地快照）。includeSub 默认 true=含子部门 */
  listDepartmentMembers: (id: string, includeSub = true) =>
    request<DepartmentMemberResult>(
      `/departments/${encodeURIComponent(id)}/members${includeSub ? '' : '?includeSub=0'}`,
    ),

  // ── 成绩册（Markbook，2026-09-13 参照 Gibbon 移植）────────────────────
  /** 可选班级（学生档案「当前班级」聚合） */
  markbookClasses: () => request<MarkbookClassOption[]>('/markbook/classes'),
  /** 整个班级的成绩册网格（列 × 学生 + 单元格 + 加权总评） */
  markbookGrid: (cls: string) => request<MarkbookGrid>(`/markbook/grid?cls=${encodeURIComponent(cls)}`),
  /** 批量保存单元格（score 传空 = 删除该条目） */
  markbookSaveEntries: (cls: string, rows: MarkbookSaveRow[]) =>
    request<{
      saved: number;
      removed: number;
      skipped: number;
      /** 已自动修正的问题（超满分截断 / 负数归 0） */
      warnings: { columnId: string; studentId: string; message: string }[];
      /** 没有落库的非法输入（保留原值由前端回显） */
      errors: { columnId: string; studentId: string; value: string; message: string }[];
    }>('/markbook/entries/save', {
      method: 'POST',
      body: JSON.stringify({ cls, rows }),
    }),
  /** 用当前等级体系与目标重算既有条目的快照 */
  markbookRecalc: (cls: string) =>
    request<{ scanned: number; updated: number }>('/markbook/recalc', {
      method: 'POST',
      body: JSON.stringify({ cls }),
    }),
  /** 新建 / 更新一列 */
  markbookSaveColumn: (payload: MarkbookColumnPayload) =>
    request<{ id: string }>('/markbook/columns', { method: 'POST', body: JSON.stringify(payload) }),
  /** 删除一列（连同其条目） */
  markbookDeleteColumn: (id: string) =>
    request<{ removedEntries: number }>(`/markbook/columns/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // ── 作业 → 成绩册联动（2026-09-14）────────────────────────────────────
  // 口径：作业**已完成**才写分（有提交就按得分，没有提交按满分），未完成 / 无提交**留空不写 0** ——
  // 成绩册总评是自归一化的（分母只算已录入项），写 0 等于「参与了得 0 分」，与「没参与」是两回事。
  /** 该班可选作业（含完成率与已绑定的考核列），供同步面板的「作业」下拉用 */
  markbookHomeworkCatalog: (cls: string) =>
    request<HomeworkOption[]>(`/markbook/homework-catalog?cls=${encodeURIComponent(cls)}`),
  /** 写入预览：本次会改哪几格（与 sync 共用同一份计划器，预览到什么就写什么） */
  markbookSyncHomeworkPreview: (q: HomeworkSyncQuery) =>
    request<HomeworkSyncPreview>(
      `/markbook/sync-homework/preview${qs({
        cls: q.cls,
        homeworkName: q.homeworkName,
        columnId: q.columnId,
        mode: q.mode,
      })}`,
    ),
  /** 执行同步（真的写成绩册，不能盲写：页面上必须先预览） */
  markbookSyncHomework: (b: HomeworkSyncQuery) =>
    request<HomeworkSyncResult>('/markbook/sync-homework', { method: 'POST', body: JSON.stringify(b) }),
  /** 绑定 / 解绑「考核列 ↔ 作业」（homeworkName 传空 = 解绑，不影响已写入的分数） */
  markbookHomeworkBind: (b: { cls: string; columnId: string; homeworkName: string }) =>
    request<{ ok: boolean }>('/markbook/homework-bind', { method: 'POST', body: JSON.stringify(b) }),

  /** 考勤码（教学域配置表，通用 CRUD）。出勤口径的可配置码表，见 /attendance-codes 页面 */
  attendanceCodes: crud('/attendance-codes'),

  // ── 考试与成绩（2026-09-16 参照 RosarioSIS v13 的 Grades 模块）──────────────
  // 四张表全部由后端 generic-crud 承载，端点形状一致
  // （GET / | POST / | PUT /:id | DELETE /:id）。
  // 专用动作（结转预览/一键结转/确认/成绩单/PDF）走 /exam-grades/*，另见下方专用方法。
  examTypes: crud('/exam-types'),
  examBatches: crud('/exam-batches'),
  examTermGrades: crud('/exam-term-grades'),
  examReportCards: crud('/exam-report-cards'),

  /** 批次下拉 */
  examListBatches: () => request<ExamBatch[]>('/exam-grades/batches'),
  /** 该班可用科目（取成绩册列上「科目」的实际去重值，不读字典） */
  examSubjects: (cls: string) =>
    request<{ value: string; label: string; columns: number }[]>(
      `/exam-grades/subjects?cls=${encodeURIComponent(cls)}`,
    ),
  /** 结转**预览**（不落库） */
  examPreview: (batchId: string, cls: string, subject = '') =>
    request<TermGradePreview>(
      `/exam-grades/preview?batchId=${encodeURIComponent(batchId)}&cls=${encodeURIComponent(cls)}&subject=${encodeURIComponent(subject)}`,
    ),
  /** 一键结转（幂等 upsert，已确认跳过） */
  examRoll: (batchId: string, cls: string, subject = '') =>
    request<{ saved: number; skipped: number }>('/exam-grades/roll', {
      method: 'POST',
      body: JSON.stringify({ batchId, cls, subject }),
    }),
  /** 确认单条（状态流转） */
  examConfirm: (id: string) => request<{ ok: true }>(`/exam-grades/confirm/${encodeURIComponent(id)}`, { method: 'POST' }),
  /** 批量确认（状态流转） */
  examConfirmAll: (batchId: string, cls: string, subject = '') =>
    request<{ confirmed: number }>('/exam-grades/confirm-all', {
      method: 'POST',
      body: JSON.stringify({ batchId, cls, subject }),
    }),
  /** 撤销确认 */
  examUndo: (id: string) => request<{ ok: true }>(`/exam-grades/undo/${encodeURIComponent(id)}`, { method: 'POST' }),
  /** 手工调分 */
  examAdjust: (id: string, total: number, reason = '') =>
    request<{ ok: true }>(`/exam-grades/adjust/${encodeURIComponent(id)}`, {
      method: 'POST',
      body: JSON.stringify({ total, reason }),
    }),
  /** 还原自动值 */
  examRestore: (id: string) => request<{ ok: true }>(`/exam-grades/restore/${encodeURIComponent(id)}`, { method: 'POST' }),
  /** 期末总评列表（评语页用） */
  examTermGradeList: (opts: { batchId: string; cls?: string; subject?: string; onlyMissingComment?: boolean }) => {
    const q = new URLSearchParams({ batchId: opts.batchId });
    if (opts.cls) q.set('cls', opts.cls);
    if (opts.subject) q.set('subject', opts.subject);
    if (opts.onlyMissingComment) q.set('onlyMissingComment', '1');
    return request<{ rows: TermGradeListItem[] }>(`/exam-grades/term-grades?${q.toString()}`);
  },
  /** 批量保存评语（失焦即存，每次一条也没问题） */
  examSaveComments: (rows: { id: string; comment: string; status?: string }[]) =>
    request<{ saved: number; locked: number }>('/exam-grades/comments', {
      method: 'POST',
      body: JSON.stringify({ rows }),
    }),
  /** 班主任总评语（学生 × 批次） */
  examSaveSummary: (d: { batchId: string; studentId: string; comment: string; studentName: string; cls: string }) =>
    request<{ ok: true }>('/exam-grades/summary-comment', { method: 'POST', body: JSON.stringify(d) }),
  /** 异常成绩审查（只提示，不改分） */
  examAnomalies: (batchId: string, cls: string) =>
    request<{ rows: ExamAnomalyRow[]; thresholds: { highFactor: number; lowFactor: number; swingScore: number }; scanned: number }>(
      `/exam-grades/anomalies?batchId=${encodeURIComponent(batchId)}&cls=${encodeURIComponent(cls)}`,
    ),
  /** 成绩单数据（屏幕预览；与 PDF 同一份数据） */
  examReportCard: (studentId: string, batchId: string) =>
    request<ExamReportCard | null>(
      `/exam-grades/report-card?studentId=${encodeURIComponent(studentId)}&batchId=${encodeURIComponent(batchId)}`,
    ),

  // ── 考试与成绩 Phase 2（2026-09-16）───────────────────────────────────
  /** 成绩口径设置（全局缺省；批次上的同名字段优先） */
  examSettings: () => request<ExamGradeSettings>('/exam-grades/settings'),
  saveExamSettings: (dto: Partial<ExamGradeSettings>) =>
    request<ExamGradeSettings>('/exam-grades/settings', { method: 'PUT', body: JSON.stringify(dto) }),
  /** 常用评语库（标准 CRUD，路径 /exam-comments） */
  examComments: crud('/exam-comments'),
  /** 报表：考试成绩分布 */
  reportExamDist: (o: { batchId?: string; cls?: string; subject?: string }) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(o)) if (v) q.set(k, String(v));
    return request<ExamDistReport>(`/reports/exam-dist${q.toString() ? `?${q}` : ''}`);
  },
  /** 报表：GPA 与班级排名 */
  reportExamGpa: (o: { batchId?: string; cls?: string }) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(o)) if (v) q.set(k, String(v));
    return request<ExamGpaReport>(`/reports/exam-gpa${q.toString() ? `?${q}` : ''}`);
  },

  // ── 身份模拟（2026-09-16）────────────────────────────────────────────
  // 全部接口都要求「已登录 + 系统管理员」；除 unlock 外还要求解锁凭证
  // （凭证缺失时后端返回 **403** 而不是 401，避免被 request() 当成未登录踢回登录页）。
  /** ① 校验二次密码，成功则解锁 10 分钟 */
  impersonateUnlock: (password: string) =>
    request<ImpersonateUnlockResult>('/impersonate/unlock', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),
  /** 主动锁定：清掉解锁凭证，回到密码屏 */
  impersonateLock: () => request<{ ok: true }>('/impersonate/lock', { method: 'POST' }),
  /** ② 账号清单（不含邮箱/手机/密级） */
  impersonateUsers: () => request<ImpersonateListResult>('/impersonate/users'),
  /**
   * ③ 进入模拟：后端会把 Cookie 换成模拟会话。
   * `opts.readOnly` / `opts.modules` 是 Phase 2 的限制项 —— 由服务端在 SessionGuard 里统一拦截。
   */
  impersonateEnter: (openId: string, opts?: { readOnly?: boolean; modules?: string[] }) =>
    request<ImpersonateEnterResult>('/impersonate/enter', {
      method: 'POST',
      body: JSON.stringify({ openId, ...(opts ?? {}) }),
    }),
  /** ⑥ 模块清单（模块白名单的候选项） */
  impersonateModules: () => request<{ key: string; label: string }[]>('/impersonate/modules'),
  /** ⑤ 模拟记录（只读审计，不需要二次密码） */
  impersonateLogs: (opts?: { action?: string; actor?: string; target?: string; from?: string; to?: string }) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(opts ?? {})) if (v) q.set(k, String(v));
    return request<ImpersonateLogResult>(`/impersonate/logs${q.toString() ? `?${q}` : ''}`);
  },
  /** ④ 退出模拟：后端把 Cookie 换回管理员原会话。restored=false 表示原会话已过期 */
  impersonateExit: () =>
    request<{ ok: true; restored: boolean }>('/impersonate/exit', { method: 'POST' }),

  // ── API 令牌管理（2026-09-16）：签发/吊销 CLI、MCP、脚本用的长期凭证 ──────
  // 三层门禁：登录态 → 系统管理员 → 二次密码（与身份模拟同等级）
  apiTokensState: () => request<ApiTokenState>('/api-tokens/state'),
  apiTokensUnlock: (password: string) =>
    request<{ ok: boolean; expiresIn?: number; code?: string; fails?: number; remaining?: number; lockedSeconds?: number }>(
      '/api-tokens/unlock',
      { method: 'POST', body: JSON.stringify({ password }) },
    ),
  apiTokensLock: () => request<{ ok: true }>('/api-tokens/lock', { method: 'POST' }),
  apiTokenModules: () => request<{ key: string; label: string }[]>('/api-tokens/modules'),
  apiTokenUsers: () => request<ApiTokenUserOption[]>('/api-tokens/users'),
  apiTokenList: () => request<ApiTokenListResult>('/api-tokens'),
  /** 签发。返回体里的 token 是**明文，只此一次** —— 页面必须立刻展示并提示保存 */
  apiTokenIssue: (dto: IssueTokenDto) =>
    request<{ id: string; token: string; prefix: string; row: ApiTokenRow }>('/api-tokens', {
      method: 'POST',
      body: JSON.stringify(dto),
    }),
  apiTokenUpdate: (id: string, dto: Partial<IssueTokenDto> & { status?: string }) =>
    request<ApiTokenRow>(`/api-tokens/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(dto),
    }),
  apiTokenRevoke: (id: string, reason = '') =>
    request<{ ok: true }>(`/api-tokens/${encodeURIComponent(id)}/revoke`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  // ── 课程规划 / 学习成果 / 课时教案（教学域第四块，参照 Gibbon v31 的 Planner）────
  // 这 10 张表全部由后端 generic-crud 承载，端点形状完全一致
  // （GET / | POST / | PUT /:id | DELETE /:id | POST /:id/transition），
  // 因此用文件末尾的 crud() 工厂统一生成，不再逐个手写 40 个方法。
  // 调用示例：api.curriculumUnits.list({ pageSize: '100' })
  curriculumUnits: crud('/curriculum/units'),
  curriculumUnitBlocks: crud('/curriculum/unit-blocks'),
  curriculumUnitClasses: crud('/curriculum/unit-classes'),
  curriculumUnitClassBlocks: crud('/curriculum/unit-class-blocks'),
  curriculumUnitOutcomes: crud('/curriculum/unit-outcomes'),
  learningOutcomes: crud('/learning-outcomes/outcomes'),
  lessonEntries: crud('/lesson-plans/lessons'),
  lessonOutcomes: crud('/lesson-plans/lesson-outcomes'),
  homeworkSubmissions: crud('/lesson-plans/homework-submissions'),
  homeworkTrackers: crud('/lesson-plans/homework-tracker'),

  /**
   * 部署环节到课次：把该「单元开课」所属单元的全部环节，按顺序落到该教学班的课次上。
   * replaceExisting 默认 true（先清掉已生成的部署记录再重建）；传 false 只补没部署过的环节。
   */
  deployUnitClass: (id: string, opts: { replaceExisting?: boolean } = {}) =>
    request<DeployUnitClassResult>(`/curriculum/unit-classes/${encodeURIComponent(id)}/deploy`, {
      method: 'POST',
      body: JSON.stringify({ replaceExisting: opts.replaceExisting }),
    }),
  /** 课程规划覆盖率：按教学班汇总单元数 / 状态分布 / 环节部署数与部署到课次的占比 */
  getCurriculumCoverage: (params: { 课程方案?: string; 学年?: string; 教学班?: string } = {}) =>
    request<CurriculumCoverageResult>(`/curriculum/coverage${qs(params)}`),
  /** 重算作业迟交（是否迟交 / 迟交分钟数）。dryRun=true 只回结果不写库 */
  recomputeHomeworkLate: (body: { ids?: string[]; 教学班?: string; dryRun?: boolean } = {}) =>
    request<RecomputeLateResult>('/lesson-plans/homework-submissions/recompute-late', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // ── 行为记录（教学域第三块，参照 GibbonEdu/core v31 的 Behaviour）──────────
  // 记录 / 跟进流水 / 告警 / 信件四个资源的端点形状一致（GET / | POST / | PUT /:id |
  // DELETE /:id | POST /:id/transition），用文件末尾的 crud() 工厂统一生成。
  // 调用示例：api.behaviourRecords.list({ pageSize: '100' })
  behaviourRecords: crud('/behaviour/records'),
  behaviourFollowUps: crud('/behaviour/follow-ups'),
  behaviourAlerts: crud('/behaviour/alerts'),
  behaviourLetters: crud('/behaviour/letters'),

  /**
   * 重算学生告警（由行为记录派生）。
   * 不传 studentId = 全量重算；传了只算该学生。返回 新增/更新/解除 条数。
   */
  recalcBehaviourAlerts: (body: { studentId?: string } = {}) =>
    request<BehaviourRecalcResult>('/behaviour/recalc-alerts', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** 按告警等级生成一封家长通知信件（幂等：同告警同一档不重复生成） */
  generateBehaviourLetter: (body: { alertId: string; studentId?: string; 收件家长?: string }) =>
    request<GenerateBehaviourLetterResult>('/behaviour/letters/generate', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** 某条行为的全部跟进流水（按跟进日期倒序） */
  listBehaviourFollowUps: (recordId: string) =>
    request<BehaviourFollowUpPage>(`/behaviour/records/${encodeURIComponent(recordId)}/follow-ups`),
  /** 行为统计：按班级/年级汇总行为条数、涉及学生数、告警数（按等级） */
  getBehaviourStats: (params: { from?: string; to?: string; 班级?: string; 年级?: string } = {}) =>
    request<BehaviourStatsResult>(`/behaviour/stats${qs(params)}`),

  // ── 考勤分析报表 + 考勤终态审核（2026-09-14）────────────────────────────
  /**
   * 出勤率报表（需 `report:read`）。
   * 口径：只统计「已通过」终态的考勤记录；「计入统计=否」的考勤码整条排除；
   * 方向=在校 计实到，不在校 计未出勤（语义范围=离校 记请假，其余记缺勤）。
   */
  reportAttendance: (params: { from?: string; to?: string; class?: string; grade?: string } = {}) =>
    request<AttendanceReportPayload>(`/reports/attendance${qs(params)}`),
  /** 单条考勤终态审核（审核人取会话用户，前端不传） */
  reviewStudentAttendance: (id: string, data: { status: string; comment?: string }) =>
    request<Record<string, unknown>>(`/student-attendances/${encodeURIComponent(id)}/review`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  /** 批量考勤终态审核 */
  reviewStudentAttendances: (data: { ids: string[]; status: string; comment?: string }) =>
    request<{ ok: number; failed: number; failedIds: string[]; status: string }>(
      '/student-attendances/review-batch',
      { method: 'POST', body: JSON.stringify(data) },
    ),
};

/** 知识库配置「立即收取」的实时进度（与 MailSyncProgress 同范式） */
export interface SourceSyncProgress {
  running: boolean;
  startedAt: number;
  finishedAt?: number;
  fetched: number;
  stored: number;
  created: number;
  sourceName: string;
  error?: string;
  result?: string;
}

/** 部门状态：active 正常 / disabled 已停用 / invalid 已删除（不在树中展示） */
export type DepartmentStatus = 'active' | 'disabled' | 'invalid';

/** 部门节点（已归一化） */
export interface DepartmentNode {
  open_department_id: string;
  name: string;
  parent_department_id: string;
  order: number;
  status: DepartmentStatus;
  leader_user_id: string;
  manager_user_id: string;
  member_count: number;
  synced_at: number;
}

export interface DepartmentListResult {
  items: DepartmentNode[];
  total: number;
  lastSyncedAt: number;
}

/** 部门同步进度（轮询） */
export interface DepartmentSyncProgress {
  running: boolean;
  startedAt: number;
  finishedAt?: number;
  fetched: number;
  stored: number;
  sourceName: string;
  error?: string;
  result?: string;
}

/** 部门成员（「点部门看员工」列表项，来自部门成员快照表） */
export interface DepartmentMember {
  open_id: string;
  name: string;
  en_name: string;
  /** ⚠️ 飞书按部门取人的接口不返回职务/工号，通常为空 */
  job_title: string;
  employee_no: string;
  /** 飞书 user_id（企业内成员编号） */
  user_id: string;
  avatar: string;
  open_department_id: string;
  department_name: string;
  status: 'active' | 'resigned' | 'inactive';
  synced_at: number;
}

export interface DepartmentMemberResult {
  items: DepartmentMember[];
  total: number;
  department_ids: string[];
  synced_at: number;
}

// ── 成绩册（Markbook）类型：与 apps/api/src/markbook/markbook.service.ts 的返回体一一对应 ──
export interface MarkbookClassOption {
  cls: string;
  students: number;
  columns: number;
  entries: number;
}
export interface MarkbookColumn {
  id: string;
  name: string;
  type: string;
  /** 该「考核类型」的颜色（取自考核类型表，用于列头色块；未配置为空串） */
  typeColor: string;
  /** 该列属于哪个科目（文本；空 = 不区分科目。期末总评按它拆科目） */
  subject: string;
  /** 列权重（第一层权重，与「成绩类型权重」相乘） */
  weight: number;
  fullMark: number;
  scaleId: string;
  date: string;
  sort: number;
  status: string;
  studentVisible: string;
  parentVisible: string;
  completeDate: string;
  /** 该列绑定的作业名称（列上的「关联作业」字段，空串 = 未绑定；绑定才能做作业同步） */
  homeworkName: string;
  /** 绑定作业后附带的完成率（只读展示：已完成 / 应完成） */
  homework?: { done: number; total: number; rate: number };
}
export interface MarkbookStudent {
  id: string;
  name: string;
  enName: string;
}
export interface MarkbookCell {
  columnId: string;
  studentId: string;
  score: number | null;
  /** 单元格状态：正常 / 免考 / 缺考（免考不进总评分母，缺考按 0 分进） */
  status: string;
  /** 等级是写入时的快照，等级体系改名不篡改历史 */
  level: string;
  levelOrder: number | null;
  concern: boolean;
  attained: string;
  comment: string;
}
export interface MarkbookSummary {
  studentId: string;
  /** 加权总评（百分制，自归一化） */
  total: number | null;
  level: string;
  levelOrder: number | null;
  concern: boolean;
  targetLevel: string;
  targetOrder: number | null;
  /** true 达标 / false 未达标 / null 无法判定（缺目标或没成绩） */
  attained: boolean | null;
  filled: number;
  weightSum: number;
}
export interface MarkbookLevel {
  id: string;
  scaleId: string;
  label: string;
  /** 序号越小越好（1 = 最好） */
  order: number;
  min: number | null;
  max: number | null;
  concern: boolean;
}
export interface MarkbookGrid {
  cls: string;
  columns: MarkbookColumn[];
  students: MarkbookStudent[];
  cells: MarkbookCell[];
  summary: MarkbookSummary[];
  levels: MarkbookLevel[];
  scales: { id: string; name: string; isDefault: boolean }[];
  typeWeights: { type: string; weight: number }[];
  /** 列 id → 该列绑定作业的完成率（只含已绑定的列） */
  homeworkRates: Record<string, { done: number; total: number; rate: number }>;
}
/** 批量保存的一行（score 传 null/'' 表示清空该格） */
export interface MarkbookSaveRow {
  columnId: string;
  studentId: string;
  /** 原始输入文本：`85` / `85%` / `A` / `*`(免考) / `缺`(缺考) 都支持 */
  score: number | string | null;
  /** 单元格状态（显式传时优先于从 score 解析） */
  status?: string;
  comment?: string;
  visibleStudent?: string;
  visibleParent?: string;
}
// ── 考试与成绩（2026-09-16 参照 RosarioSIS v13 Grades 移植）────────────────
export interface ExamBatch {
  id: string;
  name: string;
  status: string;
  year: string;
  term: string;
  from: string;
  to: string;
}
export interface TermGradeRow {
  studentId: string;
  studentName: string;
  cls: string;
  /** 科目；`__none__` = 未填科目 */
  subject: string;
  total: number | null;
  level: string;
  levelOrder: number | null;
  concern: boolean;
  attained: string;
  count: number;
  weightSum: number;
  excusedCount: number;
  absentCount: number;
  weightedGpa: number | null;
  unweightedGpa: number | null;
  rank: number | null;
  rankTotal: number;
  status: string;
  source: string;
  comment: string;
  commentStatus: string;
  teacher: string;
  detail: string;
  recordId: string;
  action: '新建' | '更新' | '无变化' | '跳过（已确认）';
  oldTotal: number | null;
}
export interface TermGradePreview {
  batchId: string;
  batchName: string;
  batchStatus: string;
  cls: string;
  subject: string;
  subjects: { value: string; label: string; columns: number }[];
  columns: { id: string; name: string; type: string; subject: string; weight: number; fullMark: number }[];
  rows: TermGradeRow[];
  summary: { create: number; update: number; unchanged: number; skipped: number; total: number };
  /** 等级表一个绩点都没配时为 false —— 前端要明说「未配置绩点」，不显示 0.00 */
  gpaConfigured: boolean;
  reason?: string;
}
export interface TermGradeListItem {
  id: string;
  studentId: string;
  studentName: string;
  cls: string;
  subject: string;
  total: number | null;
  level: string;
  rank: number | null;
  rankTotal: number;
  status: string;
  comment: string;
  commentStatus: string;
  excusedCount: number;
  absentCount: number;
}
export interface ExamAnomalyRow {
  entryId: string;
  rule: string;
  message: string;
  deviation: number | null;
  columnId: string;
  columnName: string;
  columnType: string;
  studentId: string;
  studentName: string;
  score: number | null;
  fullMark: number;
  classAvg: number | null;
}
export interface ExamReportCard {
  batchId: string;
  batchName: string;
  batchStatus: string;
  year: string;
  term: string;
  studentId: string;
  studentName: string;
  studentNo: string;
  cls: string;
  grade: string;
  subjects: {
    subject: string;
    total: number | null;
    level: string;
    rank: number | null;
    rankTotal: number;
    attained: string;
    comment: string;
    teacher: string;
    status: string;
  }[];
  gpa: { weighted: number | null; unweighted: number | null };
  rank: number | null;
  rankTotal: number;
  attainedCount: number;
  summaryComment: string;
  summaryStatus: string;
  confirmedAt: string;
}

// ── 身份模拟（2026-09-16）：系统管理员以任意账号身份浏览，排障用 ──────────────
export interface ImpersonateUserRow {
  openId: string;
  name: string;
  teacherType: string;
  campus: string;
  roles: string[];
  status: string;
  /** false = 不可模拟（停用 / 无 Open ID），原因见 reason */
  canEnter: boolean;
  reason: string;
}
export interface ImpersonateListResult {
  users: ImpersonateUserRow[];
  total: number;
  enterable: number;
  disabled: number;
  currentOpenId: string;
}
/**
 * 解锁结果。密码错与被锁定都走 **HTTP 200 + 结构体**（而不是抛异常），
 * 因为页面需要 `remaining` 才能显示「还可以尝试 2 次」。
 */
export type ImpersonateUnlockResult =
  | { ok: true; expiresIn: number }
  | { ok: false; code: 'BAD_PASSWORD'; fails: number; remaining: number }
  | { ok: false; code: 'LOCKED'; lockedSeconds: number };
// ── 考试与成绩 Phase 2（2026-09-16）：口径设置 / 评语库 / 两张报表 / 整班 ZIP ──
export interface ExamGradeSettings {
  roundMode: string;
  excusedMode: string;
  absentMode: string;
  /** GPA 显示小数位 0–3 */
  gpaDecimals: number;
  highFactor: number;
  lowFactor: number;
  swingScore: number;
}

export interface ExamDistReport {
  batches?: { id: string; name: string; status: string; year: string; term: string }[];
  batchId: string;
  batchName: string;
  classes: string[];
  subjects: string[];
  /** 数据范围口径说明（页面「口径」段直接展示） */
  scopeNote?: string;
  reason?: string;
  summary: {
    students: number;
    records: number;
    avg: number | null;
    median: number | null;
    max: number | null;
    min: number | null;
    passRate: number | null;
    attainedRate: number | null;
  };
  bands: { label: string; count: number }[];
  byLevel: { level: string; count: number }[];
  bySubject: { subject: string; count: number; avg: number | null; attainedRate: number | null }[];
  top: { studentId: string; studentName: string; cls: string; subject: string; total: number | null; level: string }[];
  bottom: { studentId: string; studentName: string; cls: string; subject: string; total: number | null; level: string }[];
}

export interface ExamGpaRow {
  studentId: string;
  studentName: string;
  cls: string;
  subjectCount: number;
  gpaSubjectCount: number;
  weightedGpa: number | null;
  unweightedGpa: number | null;
  avgTotal: number | null;
  level: string;
  levelOrder: number | null;
  attainedCount: number;
  subjects: string;
  rank: number | null;
  clsRank: number | null;
  clsTotal: number;
}

export interface ExamGpaReport {
  batches?: { id: string; name: string; status: string; year: string; term: string }[];
  batchId: string;
  batchName: string;
  classes: string[];
  /** 等级表一个绩点都没配时为 false —— 页面要明说「未配置绩点」，不显示 0.00 */
  gpaConfigured: boolean;
  scopeNote?: string;
  reason?: string;
  summary: { students: number; avgGpa: number | null; fullMarks: number };
  distribution: { label: string; count: number }[];
  rows: ExamGpaRow[];
}

export interface ImpersonateLogRow {
  id: string;
  /** 毫秒时间戳 */
  at: number;
  action: string;
  actor: string;
  target: string;
  ip: string;
  detail: string;
}
export interface ImpersonateLogResult {
  rows: ImpersonateLogRow[];
  total: number;
  actions: string[];
}

// ── API 令牌（CLI / MCP 接入，2026-09-16）────────────────────────────
export interface ApiTokenRow {
  id: string;
  name: string;
  /** 密钥前缀（前 16 字符，用于辨认；不含明文） */
  prefix: string;
  userOpenId: string;
  userName: string;
  usage: string;
  readOnly: boolean;
  modules: string[];
  status: string;
  /** 毫秒时间戳；0 = 不过期（服务端默认会给一年） */
  expiresAt: number;
  ipWhitelist: string[];
  /** 次/分钟，0 = 不限 */
  rateLimit: number;
  logAll: boolean;
  lastUsedAt: number;
  usedCount: number;
  remark: string;
  /** 已过期 / 已吊销 —— 前端据此置灰 */
  expired: boolean;
}

export interface ApiTokenListResult {
  rows: ApiTokenRow[];
  total: number;
  enabled: number;
  revoked: number;
  /** 可写的令牌数 —— 页面上要显眼，这是风险点 */
  writable: number;
  maxTtlMs: number;
}

export interface ApiTokenState {
  unlocked: boolean;
  expiresIn: number;
  /** 密码来自环境变量还是代码内默认值 —— 页面要如实提示，别让人以为它很安全 */
  passwordSource: 'env' | 'default';
  maxTtlMs: number;
}

export interface ApiTokenUserOption {
  openId: string;
  name: string;
  campus: string;
  roles: string[];
  status: string;
  canUse: boolean;
  reason: string;
}

export interface IssueTokenDto {
  name?: string;
  userOpenId?: string;
  usage?: string;
  readOnly?: boolean;
  modules?: string[];
  expiresAt?: number;
  ipWhitelist?: string;
  rateLimit?: number;
  logAll?: boolean;
  remark?: string;
}

export interface ImpersonateEnterResult {
  ok: true;
  target: { openId: string; name: string; roles: string[]; campus: string };
  expiresIn: number;
}

export interface MarkbookColumnPayload {
  id?: string;
  cls: string;
  name: string;
  type?: string;
  /** 科目（文本，可空；期末总评按它拆分科目） */
  subject?: string;
  weight?: number;
  fullMark?: number;
  scaleId?: string;
  date?: string;
  desc?: string;
  sort?: number;
  status?: string;
  studentVisible?: string;
  parentVisible?: string;
  completeDate?: string;
}

/** 当前用户的得到大脑凭证状态。只有掩码，永不含明文。 */
export interface GetnoteCredential {
  configured: boolean;
  masked: string;
  clientIdMasked: string;
  updatedAt: string;
  verifiedAt: string;
  source: 'manual' | 'oauth' | '';
  /** 服务器是否开启了一键授权；false 时前端隐藏该入口，不误导用户点了报错 */
  oauthEnabled: boolean;
}

/** OAuth 第 1 步结果。qrcode 是 data URI 形态的 PNG，可直接塞进 <img src>。 */
export interface GetnoteOAuthStart {
  userCode: string;
  verificationUri: string;
  qrcode: string;
  expiresIn: number;
  interval: number;
}

export interface GetnoteOAuthPoll {
  status: 'pending' | 'success' | 'expired' | 'rejected';
  credential?: GetnoteCredential;
}

/** 笔记 ↔ 业务实体的关联记录（飞书「笔记关联」映射表一行） */
export interface GetnoteLink {
  /** 映射表 recordId，前端用作 React key */
  id: string;
  noteId: string;
  title: string;
  linkedBy: string;
}

export interface PermissionsPayload {
  roles: string[];
  permissions: string[];
  /** 角色 key → 展示名（label），供前端把存储的 key 解析成可读名称 */
  roleLabels: Record<string, string>;
  matrix: Record<string, string[]>;
  dataLevels: string[];
  myRoles: string[];
  myMaxDataLevel: string;
  myPermissions: string[];
  /** 可见菜单白名单（restricted=false 时不限制） */
  myMenus?: string[];
  myMenuRestricted?: boolean;
}

/** 笔记统计：新增笔记来自笔记快照表，转换次数来自笔记转换记录表 */
export interface NoteStatsPayload {
  from: string;
  to: string;
  /** 快照最后同步时间（null = 还没落过库） */
  syncedAt: number | null;
  summary: { newNotes: number; converts: number; owners: number };
  byOwner: { owner: string; newNotes: number }[];
  bySource: { source: string; count: number }[];
  byModule: { module: string; count: number }[];
  byConverter: { converter: string; count: number }[];
  byDay: { date: string; newNotes: number; converts: number }[];
}

/** 活跃时段统计：登录 = 登录日志，操作 = 审计日志里的写操作（创建/更新/删除） */
export interface ActivityPayload {
  from: string;
  to: string;
  summary: {
    activeUsers: number;
    logins: number;
    actions: number;
    activeDays: number;
    peakHour: number;
  };
  byHour: number[];
  byUser: {
    name: string;
    logins: number;
    actions: number;
    activeDays: number;
    firstAt: number | null;
    lastAt: number | null;
    hours: number[];
    peakHour: number;
  }[];
  byDay: { date: string; logins: number; actions: number }[];
  modules: { module: string; count: number }[];
}

/** 系统监控快照：任一分区采集失败时该分区为 null 或 ok:false，页面降级显示「不可用」 */
export interface SystemStatusPayload {
  collectedAt: string;
  host: {
    hostname: string;
    platform: string;
    cpuModel: string;
    cpuCores: number;
    load1: number;
    load5: number;
    load15: number;
    memTotalText: string;
    memUsedText: string;
    memUsagePercent: number;
    disk: {
      totalText: string;
      usedText: string;
      availableText: string;
      usagePercent: number;
    } | null;
    uptimeText: string;
  } | null;
  app: {
    pid: number;
    nodeVersion: string;
    uptimeText: string;
    startedAt: string;
    rssText: string;
    heapUsedText: string;
    slot: string | null;
    buildId: string | null;
  } | null;
  deps: {
    postgres: { ok: boolean; dbSizeText?: string; tableCount?: number; connections?: number };
    redis: { ok: boolean; keys?: number; memoryText?: string };
  } | null;
  services: { name: string; unit: string; active: 'active' | 'inactive' | 'unknown'; detail?: string }[];
  backups: { ok: boolean; dir: string; items: { name: string; sizeText: string; at: string | null }[] };
  errors: { ok: boolean; unit: string | null; lines: string[] };
}

export interface RoleManagementPayload {
  roles: RoleDef[];
  allPermissions: string[];
  dataLevels: string[];
  /** 新建角色时自动补入「系统角色」字段选项的选项名（仅 createRole 返回；写入 PostgreSQL，不涉及飞书） */
  syncedRoleOptions?: string[];
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

/**
 * 下载成绩单 PDF（服务端 pdfkit 生成，矢量、中文正确、约 30 KB/份）。
 *
 * 文件名走后端 `Content-Disposition` 的 `filename*`（RFC 5987 中文名）；
 * 这里再兜一层解析，取不到就用「成绩单_{学生名}.pdf」。
 */
/**
 * 下载整班成绩单 ZIP（服务端零依赖打包，见 `apps/api/src/exam-grade/zip.ts`）。
 *
 * 与单份 PDF 同一套错误处理：401 跳登录、其它错误尽量把后端的 JSON message 抛出来
 *（「该班级还没有可导出的成绩单」这类话比一个状态码有用得多）。
 */
export async function downloadClassReportCardsZip(
  batchId: string,
  cls: string,
  subject = '',
  filenameHint = '',
): Promise<void> {
  const q = new URLSearchParams({ batchId, cls });
  if (subject) q.set('subject', subject);
  const res = await fetch(`${API_BASE}/exam-grades/report-cards.zip?${q.toString()}`, {
    credentials: 'include',
  });
  if (res.status === 401) {
    if (typeof window !== 'undefined') window.location.href = '/login';
    throw new Error('UNAUTHENTICATED');
  }
  if (!res.ok) {
    let msg = `导出失败 HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { message?: string };
      if (j?.message) msg = j.message;
    } catch {
      /* 非 JSON 响应，保留状态码 */
    }
    throw new Error(msg);
  }
  const cd = res.headers.get('Content-Disposition') || '';
  let filename = `${filenameHint || `成绩单_${cls}`}.zip`;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  const plain = /filename="([^"]+)"/i.exec(cd);
  if (star && star[1]) filename = decodeURIComponent(star[1]);
  else if (plain && plain[1]) filename = plain[1];

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export async function downloadReportCardPdf(studentId: string, batchId: string, studentName = ''): Promise<void> {
  const res = await fetch(
    `${API_BASE}/exam-grades/report-card.pdf?studentId=${encodeURIComponent(studentId)}&batchId=${encodeURIComponent(batchId)}`,
    { credentials: 'include' },
  );
  if (res.status === 401) {
    if (typeof window !== 'undefined') window.location.href = '/login';
    throw new Error('UNAUTHENTICATED');
  }
  if (!res.ok) {
    // 后端在越权 / 找不到时返回 JSON 说明，尽量把它带给用户（而不是一个干巴巴的状态码）
    let msg = `导出失败 HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { message?: string };
      if (j?.message) msg = j.message;
    } catch {
      /* 非 JSON 响应，保留状态码 */
    }
    throw new Error(msg);
  }
  const cd = res.headers.get('Content-Disposition') || '';
  let filename = `成绩单_${studentName || studentId}.pdf`;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  const plain = /filename="([^"]+)"/i.exec(cd);
  if (star && star[1]) filename = decodeURIComponent(star[1]);
  else if (plain && plain[1]) filename = plain[1];

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
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

// ── 课程规划相关的接口类型与工厂（本块为 2026-09-13 新增，只服务 curriculum/lessonPlan/learningOutcomes）──

/**
 * 后端 generic-crud 承载的资源统一的 5 个端点。
 *
 * 定义在文件末尾（`function` 声明会提升，`api` 对象里引用它是安全的）：
 * 放在 API_BASE 附近虽然更好读，但那里是全站公共区域，改动容易与其它人冲突。
 *
 * ⚠️ 没有 statusField 的表（如单元环节、成果关联表）后端不提供 /transition，
 * 页面里不要把它接进 CrudPage 的 api —— 传了也不会报错，但点了会 400。
 */
function crud<T = Record<string, unknown>>(rawPath: string) {
  // ⚠️ 必须补前导斜杠：request() 内部是 fetch(`${API_BASE}${path}`)，而 API_BASE 以
  //    `/api/v1` 结尾 —— 漏了斜杠会拼成 `/api/v1curriculum/units`，后端直接
  //    `Cannot GET /api/v1curriculum/units`（2026-09-13 全站 13 个资源一起 404 的现场）。
  //    这里兜底，调用处也统一写带斜杠的形式。
  const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  return {
    list: (params: Record<string, string | undefined> = {}) => request<Page<T>>(`${path}${qs(params)}`),
    create: (data: Record<string, unknown>) => request<T>(path, { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Record<string, unknown>) =>
      request<T>(`${path}/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(data) }),
    archive: (id: string) => request<{ ok: boolean }>(`${path}/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    transition: (id: string, to: string) =>
      request<T>(`${path}/${encodeURIComponent(id)}/transition`, { method: 'POST', body: JSON.stringify({ to }) }),
  };
}

/** 部署环节到课次的返回（字段名与后端 CurriculumService.deploy 的返回体一致） */
export interface DeployUnitClassResult {
  ok: boolean;
  开课: string;
  开课名称: string;
  单元: string;
  单元名称: string;
  环节数: number;
  可用课次数: number;
  已部署: number;
  已跳过: number;
  课次不足的环节数: number;
  空余课次数: number;
  覆盖重建: boolean;
}

export interface CoverageUnitRow {
  开课: string;
  开课名称: string;
  单元: string;
  单元名称: string;
  开课状态: string;
  开始日期: string;
  结束日期: string;
  环节总数: number;
  已部署环节数: number;
  已完成环节数: number;
  已跳过环节数: number;
}

export interface CurriculumCoverageRow {
  教学班: string;
  教学班名称: string;
  单元总数: number;
  未开始: number;
  进行中: number;
  已完成: number;
  已取消: number;
  环节总数: number;
  已部署环节数: number;
  已部署课次环节数: number;
  /** 0~1 的比值，渲染时乘 100 并保留一位小数 */
  部署率: number;
  未部署环节数: number;
  单元: CoverageUnitRow[];
}

export interface CurriculumCoverageResult {
  items: CurriculumCoverageRow[];
  汇总: {
    教学班数: number;
    单元总数: number;
    未开始: number;
    进行中: number;
    已完成: number;
    已取消: number;
    环节总数: number;
    已部署环节数: number;
    已部署课次环节数: number;
    部署率: number;
  };
  updatedAt: number;
}

export interface RecomputeLateChange {
  id: string;
  作业名称: string;
  原是否迟交: string;
  新是否迟交: string;
  原迟交分钟数: number;
  新迟交分钟数: number;
}

export interface RecomputeLateResult {
  scanned: number;
  changed: number;
  unchanged: number;
  missingTime: number;
  dryRun: boolean;
  changes: RecomputeLateChange[];
  truncated: boolean;
}

/** 行为记录重算告警的返回（字段名与后端 BehaviourService.recalcAlerts 一致） */
export interface BehaviourRecalcResult {
  ok: boolean;
  新增: number;
  更新: number;
  解除: number;
  未变: number;
  扫描学生数: number;
  扫描记录数: number;
  未关联学生的记录: number;
  告警窗口: string[];
  updatedAt: number;
}

export interface GenerateBehaviourLetterResult {
  ok: boolean;
  /** false = 该告警同一档已生成过（幂等命中） */
  created: boolean;
  id: string;
  信件类型: string;
  第几次?: number;
  letter: Record<string, unknown>;
}

export type BehaviourFollowUpPage = Page<Record<string, unknown>>;

/** 行为统计行（班级维度与年级维度共用同一形状） */
export interface BehaviourStatsRow {
  班级: string;
  年级: string;
  行为条数: number;
  正向条数: number;
  负向条数: number;
  涉及学生数: number;
  告警数: number;
  告警人数: number;
  轻度: number;
  中度: number;
  严重: number;
}

export interface BehaviourStatsResult {
  items: BehaviourStatsRow[];
  byGrade: BehaviourStatsRow[];
  汇总: BehaviourStatsRow;
  阈值: { 轻度: number; 中度: number; 严重: number; 条数: number; 短窗口: string };
  updatedAt: number;
}


// ── 考勤分析报表（/reports/attendance）────────────────────────────────────
//
// 口径唯一真源在后端 `apps/api/src/reports/attendance-rate.ts`（纯函数文件）。
// 页面上的「口径说明」段落必须与它一致，改口径时两处一起改。

/** 按班级 / 按年级 的分组行 */
export interface AttendanceBucketRow {
  key: string;
  expected: number;
  present: number;
  rate: number;
  late: number;
  earlyLeave: number;
  leave: number;
  absent: number;
  abnormal: number;
}

/** 学生排行行（带 studentId 便于下钻到学生列表） */
export interface AttendanceStudentRow extends AttendanceBucketRow {
  studentId: string;
  studentName: string;
  grade: string;
  cls: string;
}

/** 趋势点（按日 / 按周共用） */
export interface AttendanceTrendPoint {
  key: string;
  expected: number;
  present: number;
  rate: number;
  late: number;
  leave: number;
  absent: number;
  abnormal: number;
}

export interface AttendanceReportPayload {
  from: string;
  to: string;
  /** 考勤记录超过拉取上限被截断时为 true（页面提示口径不完整） */
  truncated: boolean;
  summary: {
    /** 应出勤人次（= 出勤率分母） */
    expected: number;
    /** 实到（= 出勤率分子） */
    present: number;
    /** 未出勤合计 = 请假 + 缺勤 */
    absentTotal: number;
    leave: number;
    absent: number;
    late: number;
    earlyLeave: number;
    abnormal: number;
    rate: number;
    total: number;
    /** 待审核（含未标注），不进分子分母 */
    pending: number;
    /** 其中「审核状态」为空的条数 */
    pendingUnlabeled: number;
    rejected: number;
    /** 「计入统计=否」被排除的条数 */
    excluded: number;
    /** 码表认不出口径被排除的条数 */
    unknownCode: number;
  };
  byClass: AttendanceBucketRow[];
  byGrade: AttendanceBucketRow[];
  byStudent: AttendanceStudentRow[];
  byDay: AttendanceTrendPoint[];
  byWeek: AttendanceTrendPoint[];
  options: { classes: string[]; grades: string[] };
  codes: { short: string; name: string; direction: string; scope: string; counted: boolean; source: string }[];
  /**
   * 各桶实际出现的「考勤结果」原始值。
   * 下钻只在该桶恰好一个原始值时给链接 —— 列表侧是等值筛选，多个值筛不出来。
   */
  bucketValues: {
    present: string[];
    late: string[];
    earlyLeave: string[];
    leave: string[];
    absent: string[];
    pending: string[];
  };
}

/** 考勤终态审核状态（与后端 reports/attendance-rate.ts 的常量一致） */
export const ATTENDANCE_REVIEW_STATUSES = ['待审核', '已通过', '已驳回'] as const;
export type AttendanceReviewStatus = (typeof ATTENDANCE_REVIEW_STATUSES)[number];
