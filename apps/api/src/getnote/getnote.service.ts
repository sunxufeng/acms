import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';

/** 得到大脑（Get笔记）开放平台。所有凭证只发往此地址，不接受任何其他 API 地址。 */
const BASE = 'https://openapi.biji.com';

export interface GetnoteTag {
  id?: string;
  name?: string;
  type?: 'ai' | 'manual' | 'system';
}

export interface GetnoteNote {
  /** 笔记 ID，字符串形态（int64 已在本模块转成字符串，全程不要转 Number） */
  note_id?: string;
  id?: string;
  title?: string;
  content?: string;
  note_type?: string;
  source?: string;
  tags?: GetnoteTag[];
  topics?: { id?: string; name?: string }[];
  is_child_note?: boolean;
  children_count?: number;
  parent_id?: string;
  created_at?: string;
  updated_at?: string;
}

export interface GetnoteListResult {
  notes: GetnoteNote[];
  has_more?: boolean;
  cursor?: string;
  total?: number;
}

export interface GetnoteRecallItem {
  note_id?: string;
  note_type?: string;
  title?: string;
  content?: string;
  created_at?: string;
  page_no?: number;
}

/**
 * 把 JSON 字符串字面量内部的**裸控制字符**转义掉。
 *
 * Get笔记 的 `content` 字段是 markdown 原文，里面可能含未转义的换行符
 * （API 文档明确警告过），直接 JSON.parse 会抛 SyntaxError。
 * 逐字符扫描，只在 inStr 状态下处理，避免误伤 JSON 结构本身的换行。
 */
function escapeRawControlChars(text: string): string {
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i += 1) {
    // 用 charAt 而非 text[i]：项目开了 noUncheckedIndexedAccess，下标访问类型是 string | undefined
    const c = text.charAt(i);
    if (esc) {
      out += c;
      esc = false;
      continue;
    }
    if (c === '\\') {
      out += c;
      esc = true;
      continue;
    }
    if (c === '"') {
      out += c;
      inStr = !inStr;
      continue;
    }
    if (inStr && c.charCodeAt(0) < 0x20) {
      if (c === '\n') out += '\\n';
      else if (c === '\r') out += '\\r';
      else if (c === '\t') out += '\\t';
      else out += `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * int64 安全解析。
 *
 * ⚠️ 笔记 ID 是 int64（如 1896830231705320746），远超 JS 的 Number.MAX_SAFE_INTEGER，
 * 直接 JSON.parse 会**静默丢精度**（末几位变成 0，且不报错），之后拿这个 ID 去查
 * 详情/删除就会命中错误的笔记。所以 parse 之前先把 ≥16 位的数字转成字符串。
 */
function safeParse(text: string): unknown {
  const cleaned = escapeRawControlChars(text)
    .replace(/"(id|note_id|parent_id|follow_id|live_id|next_cursor)"\s*:\s*(-?\d{16,})/g, '"$1":"$2"')
    .replace(/([:[,]\s*)(-?\d{16,})(?=\s*[,}\]])/g, '$1"$2"');
  return JSON.parse(cleaned);
}

@Injectable()
export class GetnoteService {
  private readonly logger = new Logger(GetnoteService.name);

  /** 凭证是否已配置（前端据此提示「尚未授权」而不是报一堆错） */
  isConfigured(): boolean {
    return Boolean(process.env.GETNOTE_API_KEY && process.env.GETNOTE_CLIENT_ID);
  }

  private headers(): Record<string, string> {
    const key = process.env.GETNOTE_API_KEY;
    const clientId = process.env.GETNOTE_CLIENT_ID;
    if (!key || !clientId) {
      throw new HttpException(
        'GETNOTE_NOT_CONFIGURED: 尚未配置 GETNOTE_API_KEY / GETNOTE_CLIENT_ID',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return { Authorization: key, 'X-Client-ID': clientId, 'Content-Type': 'application/json' };
  }

  /**
   * 统一出口。
   * ⚠️ 不能只看 HTTP 状态码：HTTP 200 也可能是业务失败（success: false）。
   * 10004 未授权 → 401；其余业务错误 → 502（上游问题，不是本服务的问题）。
   */
  private async request<T>(
    path: string,
    opts: { method?: string; body?: unknown; query?: Record<string, string | undefined> } = {},
  ): Promise<T> {
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== '') url.searchParams.set(k, v);
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method: opts.method ?? 'GET',
        headers: this.headers(),
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
    } catch (e) {
      this.logger.error(`Get笔记 请求失败 ${opts.method ?? 'GET'} ${path}: ${(e as Error).message}`);
      throw new HttpException('GETNOTE_UNREACHABLE', HttpStatus.BAD_GATEWAY);
    }

    const text = await res.text();
    let json: { success?: boolean; data?: T; error?: { code?: number; message?: string; reason?: string } };
    try {
      json = safeParse(text) as typeof json;
    } catch {
      this.logger.error(`Get笔记 响应无法解析 ${path}: ${text.slice(0, 200)}`);
      throw new HttpException('GETNOTE_BAD_RESPONSE', HttpStatus.BAD_GATEWAY);
    }

    if (!json.success) {
      const err = json.error ?? {};
      this.logger.warn(`Get笔记 业务错误 ${err.code ?? '?'} ${err.reason ?? ''}: ${err.message ?? ''}`);
      throw new HttpException(
        `GETNOTE_${err.reason ?? 'ERROR'}:${err.message ?? ''}`,
        err.code === 10004 ? HttpStatus.UNAUTHORIZED : HttpStatus.BAD_GATEWAY,
      );
    }
    return json.data as T;
  }

  /**
   * 笔记列表。cursor 由上一页响应原样带回即可，不需要任何转换。
   *
   * 传了关键字 `q` 则改走**语义搜索**：Get笔记 的列表接口不支持关键字过滤，
   * 而 CrudPage 的搜索框只会把词放进 `q` 参数。这里把 q 转接给 /recall，
   * 让用户「在搜索框里输词」等价于「语义召回相关笔记」。
   *
   * ⚠️ 语义搜索返回的是**内容片段**不是全文，且上限 10 条（top_k 最大值），
   * 因此这里固定不分页（has_more=false、无 cursor），交给 CrudPage 的前端切片兜底。
   */
  async list(cursor?: string, q?: string): Promise<GetnoteListResult> {
    const key = q?.trim();
    if (key) {
      const items = await this.recall(key, 10);
      return {
        notes: items.map((r) => ({
          note_id: r.note_id,
          title: r.title,
          content: r.content,
          note_type: r.note_type,
          created_at: r.created_at,
        })),
        has_more: false,
        cursor: undefined,
        total: items.length,
      };
    }
    return this.request<GetnoteListResult>('/open/api/v1/resource/note/list', { query: { cursor } });
  }

  /** 笔记详情。⚠️ 数据在 data.note 下，不是 data 直接取。 */
  async detail(id: string, imageQuality?: string): Promise<GetnoteNote> {
    const data = await this.request<{ note: GetnoteNote }>('/open/api/v1/resource/note/detail', {
      query: { id, image_quality: imageQuality },
    });
    return data?.note ?? {};
  }

  /** 新建文本笔记（同步返回 note_id）。链接/图片笔记是异步任务，本模块暂不支持。 */
  create(body: {
    title?: string;
    content?: string;
    tags?: string[];
    topic_id?: string;
    parent_id?: string;
    client_request_id?: string;
  }): Promise<{ note_id?: string; title?: string }> {
    return this.request<{ note_id?: string; title?: string }>('/open/api/v1/resource/note/save', {
      method: 'POST',
      body: { note_type: 'plain_text', ...body },
    });
  }

  /**
   * 更新笔记。
   * ⚠️ title/content/tags 至少要传一个，且仅支持 plain_text 类型。
   * ⚠️ tags 是**替换**语义（不传则保持原样，传了就整体覆盖）。
   */
  update(body: { note_id: string; title?: string; content?: string; tags?: string[] }): Promise<unknown> {
    return this.request('/open/api/v1/resource/note/update', { method: 'POST', body });
  }

  /** 删除笔记（移入回收站）。调用方必须先向用户二次确认。 */
  remove(noteId: string): Promise<unknown> {
    return this.request('/open/api/v1/resource/note/delete', { method: 'POST', body: { note_id: noteId } });
  }

  /** 全局语义搜索。结果在 data.results 下，取不到再回退到顶层 results。 */
  async recall(query: string, topK = 5): Promise<GetnoteRecallItem[]> {
    const k = Math.min(Math.max(Number(topK) || 5, 1), 10);
    const data = await this.request<{ results?: GetnoteRecallItem[] } & GetnoteRecallItem[]>(
      '/open/api/v1/resource/recall',
      { method: 'POST', body: { query, top_k: k } },
    );
    return (data as { results?: GetnoteRecallItem[] })?.results ?? (data as GetnoteRecallItem[]) ?? [];
  }

  /** 添加标签。返回该笔记的完整标签列表（含 tag id，删标签时要用到）。 */
  addTags(noteId: string, tags: string[]): Promise<{ note_id?: string; tags?: GetnoteTag[] }> {
    return this.request('/open/api/v1/resource/note/tags/add', {
      method: 'POST',
      body: { note_id: noteId, tags },
    });
  }

  /**
   * 删除标签。
   * ⚠️ 传的是 tag_id（不是标签名），来自 addTags 返回值或 detail 的 tags[].id。
   * ⚠️ system 类型标签不允许删除，调了会报错。
   */
  removeTag(noteId: string, tagId: string): Promise<unknown> {
    return this.request('/open/api/v1/resource/note/tags/delete', {
      method: 'POST',
      body: { note_id: noteId, tag_id: tagId },
    });
  }
}
