import { Inject, Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import type { BaseClient } from '@acms/base-adapter';
import { TABLES } from '@acms/contracts';
import { toText } from '@acms/base-adapter';
import type { SessionUser } from '@acms/contracts';
import { BASE_CLIENT } from '../base.provider.js';
import { buildFilter } from '../shared/record.util.js';
import {
  getCredentialStatus,
  getApiKey,
  setCredential,
  deleteCredential,
  type CredentialStatus,
} from './credential.js';

/** 得到大脑（Get笔记）开放平台。所有凭证只发往此地址，不接受任何其他 API 地址。 */
const BASE = 'https://openapi.biji.com';

/**
 * 业务实体类型 → 标签里的英文标识。
 * 打在笔记上的标签形如 `acms:student:recXXX`，出了 ACMS 也能看出这篇笔记属于谁。
 */
const ENTITY_TAG: Record<string, string> = {
  学生档案: 'student',
  家校沟通: 'homeSchoolComm',
  招生跟进: 'sourceFollowup',
  日常跟进: 'dailyFollowup',
  IDP计划: 'idp',
  学业成绩: 'grade',
  学生考勤: 'attendance',
  实践活动: 'activity',
  阶段评价: 'evaluation',
  校友跟进: 'alumni',
  邮件归档: 'mail',
};

/** 生成关联标签：acms:<英文标识>:<实体ID> */
function linkTag(entityType: string, entityId: string): string {
  return `acms:${ENTITY_TAG[entityType] ?? entityType}:${entityId}`;
}

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

  constructor(@Inject(BASE_CLIENT) private readonly base: BaseClient) {}

  /**
   * 取出当前用户的凭证对。
   *
   * 区分两种「没配好」，前端提示完全不同，不能混为一谈：
   * - **Client ID 没配** → 503。这是运维问题（应用级，全局一份），用户自己解决不了
   * - **用户自己没填 Key** → 412。前置条件未满足，引导他去设置区填自己的 Key
   */
  private credFor(user: SessionUser): { key: string; clientId: string } {
    const clientId = process.env.GETNOTE_CLIENT_ID ?? '';
    if (!clientId)
      throw new HttpException(
        'GETNOTE_CLIENT_ID_NOT_CONFIGURED: 服务器未配置 GETNOTE_CLIENT_ID',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    const key = getApiKey(user.openId);
    if (!key)
      throw new HttpException(
        'GETNOTE_KEY_NOT_SET: 当前用户尚未配置自己的 API Key',
        HttpStatus.PRECONDITION_FAILED,
      );
    return { key, clientId };
  }

  private headers(cred: { key: string; clientId: string }): Record<string, string> {
    return {
      Authorization: cred.key,
      'X-Client-ID': cred.clientId,
      'Content-Type': 'application/json',
    };
  }

  // ── 用户凭证管理（API Key 是用户级的，一人一份） ──────────────────────

  /** 当前用户的凭证状态 + 服务器 Client ID 是否已配。不返回任何明文。 */
  credentialStatus(user: SessionUser): CredentialStatus & { clientIdConfigured: boolean } {
    return {
      ...getCredentialStatus(user.openId),
      clientIdConfigured: Boolean(process.env.GETNOTE_CLIENT_ID),
    };
  }

  /**
   * 保存用户的 API Key —— **存之前先打一次真实请求验活**，验不过就不落库。
   *
   * 官方限制接口仅对 PRO 会员开放，非会员的 Key 调什么都是空，
   * 所以这一步必须拦在前面，否则用户会存一个废 Key 进来，然后对着空白页面报故障。
   */
  async saveCredential(
    user: SessionUser,
    apiKey: string,
  ): Promise<CredentialStatus & { verified: boolean }> {
    const key = String(apiKey ?? '').trim();
    if (!key) throw new HttpException('BAD_REQUEST:apiKey required', HttpStatus.BAD_REQUEST);
    if (!key.startsWith('gk_'))
      throw new HttpException(
        'BAD_REQUEST:apiKey 格式不正确，应以 gk_ 开头',
        HttpStatus.BAD_REQUEST,
      );

    const clientId = process.env.GETNOTE_CLIENT_ID ?? '';
    if (!clientId)
      throw new HttpException(
        'GETNOTE_CLIENT_ID_NOT_CONFIGURED: 服务器未配置 GETNOTE_CLIENT_ID',
        HttpStatus.SERVICE_UNAVAILABLE,
      );

    // 验活：拉一页笔记，能通就说明 Key 有效且账号是会员
    await this.request({ key, clientId }, '/open/api/v1/resource/note/list', {
      query: { cursor: '' },
    });

    return { ...setCredential(user.openId, key, { displayName: user.name }), verified: true };
  }

  clearCredential(user: SessionUser): { ok: boolean } {
    return { ok: deleteCredential(user.openId) };
  }

  /**
   * 统一出口。
   * ⚠️ 不能只看 HTTP 状态码：HTTP 200 也可能是业务失败（success: false）。
   * 10004 未授权 → 401；其余业务错误 → 502（上游问题，不是本服务的问题）。
   */
  private async request<T>(
    cred: { key: string; clientId: string },
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
        headers: this.headers(cred),
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
  async list(user: SessionUser, cursor?: string, q?: string): Promise<GetnoteListResult> {
    const cred = this.credFor(user);
    const key = q?.trim();
    if (key) {
      const items = await this.recall(user, key, 10);
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
    return this.request<GetnoteListResult>(cred, '/open/api/v1/resource/note/list', {
      query: { cursor },
    });
  }

  /** 笔记详情。⚠️ 数据在 data.note 下，不是 data 直接取。 */
  async detail(user: SessionUser, id: string, imageQuality?: string): Promise<GetnoteNote> {
    const data = await this.request<{ note: GetnoteNote }>(
      this.credFor(user),
      '/open/api/v1/resource/note/detail',
      { query: { id, image_quality: imageQuality } },
    );
    return data?.note ?? {};
  }

  /** 新建文本笔记（同步返回 note_id）。链接/图片笔记是异步任务，本模块暂不支持。 */
  create(
    user: SessionUser,
    body: {
      title?: string;
      content?: string;
      tags?: string[];
      topic_id?: string;
      parent_id?: string;
      client_request_id?: string;
    },
  ): Promise<{ note_id?: string; title?: string }> {
    return this.request<{ note_id?: string; title?: string }>(
      this.credFor(user),
      '/open/api/v1/resource/note/save',
      { method: 'POST', body: { note_type: 'plain_text', ...body } },
    );
  }

  /**
   * 更新笔记。
   * ⚠️ title/content/tags 至少要传一个，且仅支持 plain_text 类型。
   * ⚠️ tags 是**替换**语义（不传则保持原样，传了就整体覆盖）。
   */
  update(
    user: SessionUser,
    body: { note_id: string; title?: string; content?: string; tags?: string[] },
  ): Promise<unknown> {
    return this.request(this.credFor(user), '/open/api/v1/resource/note/update', {
      method: 'POST',
      body,
    });
  }

  /** 删除笔记（移入回收站）。调用方必须先向用户二次确认。 */
  remove(user: SessionUser, noteId: string): Promise<unknown> {
    return this.request(this.credFor(user), '/open/api/v1/resource/note/delete', {
      method: 'POST',
      body: { note_id: noteId },
    });
  }

  /** 全局语义搜索。结果在 data.results 下，取不到再回退到顶层 results。 */
  async recall(user: SessionUser, query: string, topK = 5): Promise<GetnoteRecallItem[]> {
    const k = Math.min(Math.max(Number(topK) || 5, 1), 10);
    const data = await this.request<{ results?: GetnoteRecallItem[] } & GetnoteRecallItem[]>(
      this.credFor(user),
      '/open/api/v1/resource/recall',
      { method: 'POST', body: { query, top_k: k } },
    );
    return (data as { results?: GetnoteRecallItem[] })?.results ?? (data as GetnoteRecallItem[]) ?? [];
  }

  /** 添加标签。返回该笔记的完整标签列表（含 tag id，删标签时要用到）。 */
  addTags(
    user: SessionUser,
    noteId: string,
    tags: string[],
  ): Promise<{ note_id?: string; tags?: GetnoteTag[] }> {
    return this.request(this.credFor(user), '/open/api/v1/resource/note/tags/add', {
      method: 'POST',
      body: { note_id: noteId, tags },
    });
  }

  /**
   * 删除标签。
   * ⚠️ 传的是 tag_id（不是标签名），来自 addTags 返回值或 detail 的 tags[].id。
   * ⚠️ system 类型标签不允许删除，调了会报错。
   */
  removeTag(user: SessionUser, noteId: string, tagId: string): Promise<unknown> {
    return this.request(this.credFor(user), '/open/api/v1/resource/note/tags/delete', {
      method: 'POST',
      body: { note_id: noteId, tag_id: tagId },
    });
  }

  // ── 笔记 ↔ 业务实体 关联（标签 + 映射表双写） ──────────────────────────

  /** 某个业务实体当前关联的笔记。buildFilter 多条件为 AND，查询前会先做服务端过滤。 */
  async listLinks(entityType: string, entityId: string) {
    const res = await this.base.search(TABLES.noteLink.tableId, {
      pageSize: 200,
      filter: buildFilter([
        { field: '实体类型', value: [entityType] },
        { field: '实体ID', value: [entityId] },
      ]),
    });
    // ⚠️ 飞书文本字段返回的是富文本数组 [{text,...}]，直接 String() 会得到 "[object Object]"
    return res.items.map((r) => ({
      id: r.recordId,
      noteId: toText(r.fields['笔记ID']) ?? '',
      title: toText(r.fields['笔记标题']) ?? '',
      linkedBy: toText(r.fields['关联人']) ?? '',
    }));
  }

  /**
   * 全量覆盖式写入关联（传空数组即清空）。
   * 与邮件归档「手动关联学生」同一范式：UI 上是 chip 增删，后端只认最终名单。
   *
   * ⚠️ 同时维护两侧：
   *   - 飞书映射表 —— 便于 ACMS 内查询、统计、跨实体检索
   *   - 笔记标签   —— 便于在 Get笔记 App 里直接看出这篇笔记属于谁
   * 标签是写在**远端笔记**上的外部数据，失败只记日志、不阻断关联本身。
   */
  async replaceLinks(
    user: SessionUser,
    entityType: string,
    entityId: string,
    entityName: string,
    links: { noteId: string; title?: string }[],
  ) {
    const tableId = TABLES.noteLink.tableId;
    const cur = await this.base.search(tableId, {
      pageSize: 200,
      filter: buildFilter([
        { field: '实体类型', value: [entityType] },
        { field: '实体ID', value: [entityId] },
      ]),
    });

    const before = new Map<string, string>(); // noteId → 映射表 recordId
    // ⚠️ 这里同样必须用 toText：key 若是 "[object Object]"，去重会失效
    //    —— 表现为反复保存产生重复记录，且删不掉旧记录。
    for (const r of cur.items) before.set(toText(r.fields['笔记ID']) ?? '', r.recordId);
    const after = new Set(links.map((l) => String(l.noteId)));

    // 1) 解除：删映射 + 去标签
    for (const [noteId, recId] of before) {
      if (after.has(noteId)) continue;
      await this.base.delete(tableId, recId);
      await this.removeLinkTag(user, noteId, entityType, entityId);
    }

    // 2) 新增：写映射 + 打标签
    for (const l of links) {
      const noteId = String(l.noteId);
      if (before.has(noteId)) continue;
      await this.base.create(tableId, {
        笔记ID: noteId,
        笔记标题: l.title ?? '',
        实体类型: entityType,
        实体ID: entityId,
        实体名称: entityName ?? '',
        关联人: user.name ?? '',
        关联时间: Date.now(),
      });
      await this.addLinkTag(user, noteId, entityType, entityId);
    }

    return { linked: links.length };
  }

  /** 新建笔记并立刻关联到业务实体：创建时带上关联标签，再写一条映射记录 */
  async createAndLink(
    user: SessionUser,
    body: {
      title?: string;
      content?: string;
      tags?: string[];
      entityType: string;
      entityId: string;
      entityName?: string;
    },
  ) {
    const created = await this.create(user, {
      title: body.title,
      content: body.content,
      tags: [...(body.tags ?? []), linkTag(body.entityType, body.entityId)],
    });
    const noteId = String(created?.note_id ?? '');
    if (noteId) {
      await this.base.create(TABLES.noteLink.tableId, {
        笔记ID: noteId,
        笔记标题: body.title ?? '',
        实体类型: body.entityType,
        实体ID: body.entityId,
        实体名称: body.entityName ?? '',
        关联人: user.name ?? '',
        关联时间: Date.now(),
      });
    }
    return { ...created, noteId };
  }

  private async addLinkTag(
    user: SessionUser,
    noteId: string,
    entityType: string,
    entityId: string,
  ): Promise<void> {
    try {
      await this.addTags(user, noteId, [linkTag(entityType, entityId)]);
    } catch (e) {
      this.logger.warn(`给笔记 ${noteId} 打关联标签失败（不影响关联本身）: ${(e as Error).message}`);
    }
  }

  /** 去标签必须先查到 tag_id（删除接口按 id 删，不认标签名） */
  private async removeLinkTag(
    user: SessionUser,
    noteId: string,
    entityType: string,
    entityId: string,
  ): Promise<void> {
    try {
      const want = linkTag(entityType, entityId);
      const note = await this.detail(user, noteId);
      const hit = (note.tags ?? []).find((t) => t.name === want);
      if (hit?.id) await this.removeTag(user, noteId, hit.id);
    } catch (e) {
      this.logger.warn(`移除笔记 ${noteId} 关联标签失败（不影响关联本身）: ${(e as Error).message}`);
    }
  }
}
