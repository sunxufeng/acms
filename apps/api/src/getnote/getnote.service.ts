import { Inject, Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import type { BaseClient } from '@acms/base-adapter';
import { TABLES, USER_TABLE, splitNoteTags } from '@acms/contracts';
import { getSqlStore } from '../base.provider.js';
import { toText } from '@acms/base-adapter';
import type {
  SessionUser,
  NoteConvertLogItem,
  NoteConfigMapItem,
  NoteListFilters,
} from '@acms/contracts';
import { BASE_CLIENT } from '../base.provider.js';
import { REDIS } from '../redis.provider.js';
import type { Redis } from 'ioredis';
import { buildFilter } from '../shared/record.util.js';
import {
  getCredentialStatus,
  getCredentialPair,
  mask,
  setCredential,
  deleteCredential,
  type CredentialStatus,
} from './credential.js';
import {
  listEnabledSourceCreds,
  noteInScopedSources,
  resolveUserIdByOpenId,
  sourceVisibleTo,
} from './source-cred.js';

/** 得到大脑（Get笔记）开放平台。所有凭证只发往此地址，不接受任何其他 API 地址。 */
const BASE = 'https://openapi.biji.com';

/**
 * OAuth 设备授权用的应用级 Client ID。
 *
 * ⚠️ 只有**一键授权**这条路需要它，手动填入那条路一个字节都不依赖本变量。
 * 没配时前端自动隐藏「一键授权」按钮，不误导用户点了报错。
 * 这是 OAuth 的固有模型（设备授权需要一个应用身份），不是我们的设计选择。
 */
const OAUTH_CLIENT_ID = () => process.env.GETNOTE_OAUTH_CLIENT_ID ?? '';

/** 设备码有效期兜底（秒）。接口会返回 expires_in，取不到时用这个值。 */
const OAUTH_EXPIRES_FALLBACK = 600;

/**
 * 上游业务错误码 → 本服务对前端的结构化错误。
 *
 * ⚠️ 绝不能把「用户 Key 无效」映射成 401：前端 request() 见到 401 就跳登录页，
 * 用户会以为是登录过期了、反复重登，永远找不到真正的原因。
 */
const UPSTREAM_ERROR: Record<number, { code: string; status: HttpStatus }> = {
  10001: { code: 'GETNOTE_AUTH_FAILED', status: HttpStatus.BAD_REQUEST },
  10004: { code: 'GETNOTE_AUTH_FAILED', status: HttpStatus.BAD_REQUEST },
  10201: { code: 'GETNOTE_NOT_MEMBER', status: HttpStatus.PAYMENT_REQUIRED },
  10202: { code: 'GETNOTE_RATE_LIMITED', status: HttpStatus.TOO_MANY_REQUESTS },
};

function toHttpError(err: { code?: number; message?: string; reason?: string }): HttpException {
  const known = err.code !== undefined ? UPSTREAM_ERROR[err.code] : undefined;
  const msg = err.message || err.reason || '上游返回未知错误';
  if (!known) {
    return new HttpException(
      { code: 'GETNOTE_UPSTREAM_ERROR', upstreamCode: err.code, message: msg },
      HttpStatus.BAD_GATEWAY,
    );
  }
  return new HttpException({ code: known.code, upstreamCode: err.code, message: msg }, known.status);
}

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

/**
 * 笔记标签 → 名称数组 / 类型数组（顺序一一对应）。
 *
 * ⚠️ 落库时两个数组**逗号分隔**存成两个平行字段，下标必须对齐 ——
 * 报表要按「标签名 + 类型」分组（system 标签如「录音卡笔记」每篇都有，要能单独排除），
 * 所以类型不能丢。用逗号而不是顿号：标签名里已知会出现顿号。
 */
function noteTagNames(n: { tags?: GetnoteTag[] }): string[] {
  return (Array.isArray(n.tags) ? n.tags : []).map((x) => String(x?.name ?? '').trim()).filter(Boolean);
}

function noteTagTypes(n: { tags?: GetnoteTag[] }): string[] {
  return (Array.isArray(n.tags) ? n.tags : []).map((x) => String(x?.type ?? '').trim());
}

/** Get笔记 的时间字段可能是 ISO 字符串或秒级时间戳，统一成毫秒；无法解析返回 0 */
function toEpochMs(v: unknown): number {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v > 1e11 ? v : v * 1000;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n > 1e11 ? n : n * 1000;
  }
  const t = new Date(s).getTime();
  return Number.isNaN(t) ? 0 : t;
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
  /**
   * 原始记录（录音类笔记的说话人带时间戳转写全文）。
   * 由后端从 detail 接口的 audio.original / audio.transcript 提取，列表接口不返回 audio，
   * 所以列表行里 rawRecord 恒为空，只有详情/编辑时才填充。content 才是「总结」。
   */
  rawRecord?: string;
  /** 附件（仅 detail 接口返回）。落库只取数量与音频时长，不存 URL（会过期）。 */
  attachments?: { type?: string; url?: string; duration?: number; [k: string]: unknown }[];
  /** 录音卡序列号（仅 detail 接口返回）。 */
  recorder_sn?: string;
  /** 原始接口返回的音频信息（仅 detail 接口返回，列表不返回）。 */
  audio?: {
    original?: string;
    transcript?: string;
    play_url?: string;
    duration?: number;
    [k: string]: unknown;
  };
  /**
   * 归属人姓名。**只有管理员**跨人聚合笔记时才会带；普通用户恒为空
   *（他看到的本来全是自己的，不需要标注）。
   */
  _owner?: string;
  /**
   * 归属人的飞书 openId。与 `_owner` 同时打上，**报表按它归并**（姓名会改名、还会出现
   * 「孙旭峰」「孙旭峰｜Richard」这种同人异写，拿来当分组键必然被拆成两行）。
   */
  _ownerOpenId?: string;
  /** 这条笔记来自哪个知识库配置。同样是管理员视角才有的标注。 */
  _sourceName?: string;
  /**
   * 来源配置的 recordId。详情/详情类操作要靠它反查**正确的那套凭证** ——
   * 管理员跨人聚合能看到别人的笔记，但 detail/tags 这些接口默认走自己的凭证，
   * 拿别人的笔记必然失败。所以必须在列表阶段就把「这篇该用谁的 Key」记下来。
   */
  _sourceRecordId?: string;
}

export interface GetnoteListResult {
  notes: GetnoteNote[];
  has_more?: boolean;
  cursor?: string;
  total?: number;
}

/** 「重新收取」正文的进度（放内存，进程重启即丢；任务本身幂等可重跑） */
export interface RefetchBodiesProgress {
  running: boolean;
  /** 本轮要处理的笔记数 */
  total: number;
  /** 已处理 */
  done: number;
  /** 成功取到正文并落库 */
  stored: number;
  /** 上游返回了但正文为空（如空笔记） */
  skipped: number;
  /** 失败（多为上游权限/限流） */
  failed: number;
  lastNoteId?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 解析管理员快照分页游标 `snap:<offset>`；空值或非法值一律当作从头开始 */
function parseSnapOffset(cursor: string): number {
  const m = String(cursor ?? '').match(/^snap:(\d+)$/);
  return m ? Number(m[1]) : 0;
}

/** 进行中的设备授权。只存内存 —— 重启即失效，用户重新点一次即可，不做持久化。 */
interface PendingAuth {
  code: string;
  interval: number;
  expiresAt: number;
  lastPollAt: number;
}

@Injectable()
export class GetnoteService {
  private readonly logger = new Logger(GetnoteService.name);

  /** openId → 设备授权进度 */
  private readonly pending = new Map<string, PendingAuth>();

  /** openId → 管理员聚合快照。见 listAllForAdmin 里的说明 */
  private readonly adminSnapshots = new Map<string, { at: number; items: GetnoteNote[] }>();
  /** 正在后台刷新快照的 openId，防止同一管理员的并发请求触发多轮重复聚合 */
  private readonly adminSnapshotInflight = new Set<string>();

  constructor(
    @Inject(BASE_CLIENT) private readonly base: BaseClient,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /**
   * 取出当前用户的凭证对。Client ID 与 API Key **都来自用户自己**，不读 .env。
   *
   * 未配好统一返回 412（前置条件未满足）：这完全是用户侧能自己解决的事，
   * 不该出现「请联系管理员」这种他无能为力的提示。
   */
  /**
   * 当前用户用于「我的笔记」的凭证对。
   *
   * 优先用本人向导页填的 user 凭证（getnote-credentials.json）；若该用户没有、
   * 但在「知识库配置」自建了来源（归属人ID = 本人 openId），则复用那套凭证 ——
   * 否则普通老师配了来源后打开「我的笔记」仍卡在向导页（两套存储之前不同步）。
   * ⚠️ 精确按「归属人」匹配，绝不会读到别人的来源凭证（隐私）。
   */
  private async credFor(user: SessionUser): Promise<{ key: string; clientId: string }> {
    const own = getCredentialPair(user.openId);
    if (own?.key && own.clientId) return own;

    const fromSource = await this.userSourceCred(user.openId);
    if (fromSource) return fromSource;

    throw new HttpException(
      { code: 'GETNOTE_CREDENTIAL_MISSING', message: '尚未连接得到大脑账号' },
      HttpStatus.PRECONDITION_FAILED,
    );
  }

  /** 在「知识库配置」表里找「归属人ID = openId」且带有效凭证的启用来源 */
  private async userSourceCred(openId: string): Promise<{ key: string; clientId: string } | null> {
    const entries = await listEnabledSourceCreds(this.base, TABLES.getnoteSource.tableId, {
      maxPages: 5,
    });
    const hit = entries.find((e) => e.ownerOpenId === openId && e.cred);
    return hit?.cred ?? null;
  }

  private headers(cred: { key: string; clientId: string }): Record<string, string> {
    return {
      Authorization: cred.key,
      'X-Client-ID': cred.clientId,
      'Content-Type': 'application/json',
    };
  }

  // ── 用户凭证管理（Client ID 与 API Key 都是每人一份） ─────────────────

  /**
   * 当前用户的凭证状态。不返回任何明文/密文，只给掩码。
   * `oauthEnabled` 决定前端是否显示「一键授权」入口。
   */
  async credentialStatus(user: SessionUser): Promise<CredentialStatus & { oauthEnabled: boolean }> {
    const base = getCredentialStatus(user.openId);
    if (base.configured) {
      return { ...base, oauthEnabled: Boolean(OAUTH_CLIENT_ID()) };
    }
    // 回退：用户在「知识库配置」自建的来源也视为已连接，避免卡在向导页
    const hit = await this.userSourceCred(user.openId);
    return {
      configured: Boolean(hit),
      masked: hit ? mask(hit.key) : '',
      clientIdMasked: hit ? mask(hit.clientId) : '',
      updatedAt: '',
      verifiedAt: '',
      source: '',
      oauthEnabled: Boolean(OAUTH_CLIENT_ID()),
    };
  }

  /**
   * 保存用户凭证 —— **存之前先打一次真实请求验活**，验不过就不落库。
   *
   * 官方限制接口仅对 PRO 会员开放，非会员的 Key 调什么都是空，所以这一步必须拦在
   * 前面，否则用户会存一个废 Key 进来，然后对着空白页面以为系统坏了。
   */
  async saveCredential(
    user: SessionUser,
    apiKey: string,
    clientId: string,
    source: 'manual' | 'oauth' = 'manual',
  ): Promise<CredentialStatus & { verified: boolean }> {
    const key = String(apiKey ?? '').trim();
    const cid = String(clientId ?? '').trim();
    if (!key)
      throw new HttpException(
        { code: 'GETNOTE_BAD_INPUT', field: 'apiKey', message: 'API Key 不能为空' },
        HttpStatus.BAD_REQUEST,
      );
    if (!key.startsWith('gk_'))
      throw new HttpException(
        { code: 'GETNOTE_BAD_INPUT', field: 'apiKey', message: 'API Key 格式不正确，应以 gk_ 开头' },
        HttpStatus.BAD_REQUEST,
      );
    if (!cid.startsWith('cli_'))
      throw new HttpException(
        { code: 'GETNOTE_BAD_INPUT', field: 'clientId', message: 'Client ID 格式不正确，应以 cli_ 开头' },
        HttpStatus.BAD_REQUEST,
      );

    // 验活：拉一页笔记，能通就说明这一对凭证有效且账号是会员
    await this.request({ key, clientId: cid }, '/open/api/v1/resource/note/list', {
      query: { cursor: '' },
    });

    return {
      ...setCredential(user.openId, key, cid, { displayName: user.name, source }),
      verified: true,
    };
  }

  clearCredential(user: SessionUser): { ok: boolean } {
    return { ok: deleteCredential(user.openId) };
  }

  // ── 上游限流保护（2026-09-09） ──────────────────────────────────────
  /**
   * ⚠️ 为什么必须有这一段：
   * 官方限流是 **QPS 2**（按 API Key 计）。而自动同步（SourcesService.syncOne）是
   * 连续翻页拉笔记的，且多个配置会被同一个 15 分钟调度同时触发 —— 实测第 3 页就撞
   * `10202 qps_bucket_exceeded`，异常一路抛到 runSync，整次同步判「失败」，已拉到的
   * 内容全部作废。用户看到的就是「第一次收取就失败：请求频率超限，请稍后重试」。
   *
   * 两道防线：
   * 1. **全局串行节流** —— 所有凭证、所有接口共用一个队列，请求间隔 ≥ MIN_INTERVAL_MS。
   *    取 700ms（≈1.4 QPS）而非 500ms，是因为并发场景（多配置同时同步）下要留余量。
   * 2. **10202 退避重试** —— 万一仍撞墙，按 1s/2s/4s 退避重试，而不是整次同步判死。
   */
  private static readonly MIN_INTERVAL_MS = 700;
  private static readonly MAX_RETRY = 3;
  private static lastRequestAt = 0;
  private static queue: Promise<unknown> = Promise.resolve();

  /** 全局排队：保证任意两次上游请求间隔 ≥ MIN_INTERVAL_MS（并发调用也不会一起放行） */
  private static throttle(): Promise<void> {
    const tick = async (): Promise<void> => {
      const wait = GetnoteService.MIN_INTERVAL_MS - (Date.now() - GetnoteService.lastRequestAt);
      if (wait > 0) await sleep(wait);
      GetnoteService.lastRequestAt = Date.now();
    };
    const next = GetnoteService.queue.then(tick, tick);
    // 队列本身不能因为单次失败而断掉，否则后续请求全部卡死
    GetnoteService.queue = next.catch(() => undefined);
    return next;
  }

  /** 是否命中上游频率限制（10202 → GETNOTE_RATE_LIMITED / 429） */
  private isRateLimited(e: unknown): boolean {
    const ex = e as HttpException | undefined;
    if (!ex || typeof ex.getStatus !== 'function') return false;
    if (ex.getStatus() !== HttpStatus.TOO_MANY_REQUESTS) return false;
    return (ex.getResponse() as { code?: string } | undefined)?.code === 'GETNOTE_RATE_LIMITED';
  }

  /** 统一出口：节流 + 10202 退避重试 + 单次请求。 */
  private async request<T>(
    cred: { key: string; clientId: string },
    path: string,
    opts: { method?: string; body?: unknown; query?: Record<string, string | undefined> } = {},
  ): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= GetnoteService.MAX_RETRY; attempt++) {
      await GetnoteService.throttle();
      try {
        return await this.requestOnce<T>(cred, path, opts);
      } catch (e) {
        lastErr = e;
        if (!this.isRateLimited(e) || attempt === GetnoteService.MAX_RETRY) throw e;
        const backoff = 1000 * 2 ** attempt;
        this.logger.warn(`Get笔记 命中限流，${backoff}ms 后重试（第 ${attempt + 1} 次） ${path}`);
        await sleep(backoff);
      }
    }
    throw lastErr;
  }

  /**
   * 单次请求（不含限流/重试）。
   * ⚠️ 不能只看 HTTP 状态码：HTTP 200 也可能是业务失败（success: false）。
   * 业务错误码经 toHttpError() 翻成结构化错误（见 UPSTREAM_ERROR 表）。
   */
  private async requestOnce<T>(
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
      throw toHttpError(err);
    }
    return json.data as T;
  }

  // ── OAuth 设备授权（可选路径，需要 .env 配 GETNOTE_OAUTH_CLIENT_ID） ────

  /**
   * 第 1 步：向开放平台换取设备码。
   *
   * 返回的 `code`（一次性设备码）**只留在服务端内存**，不下发给浏览器 ——
   * 否则等于把应用身份和授权凭据一起暴露在前端。
   */
  async startOAuth(user: SessionUser): Promise<{
    userCode: string;
    verificationUri: string;
    qrcode: string;
    expiresIn: number;
    interval: number;
  }> {
    const clientId = OAUTH_CLIENT_ID();
    if (!clientId)
      throw new HttpException(
        {
          code: 'GETNOTE_OAUTH_NOT_CONFIGURED',
          message: '服务器未开启一键授权，请改用手动填入',
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );

    const res = await fetch(`${BASE}/open/api/v1/oauth/device/code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId }),
    });
    const text = await res.text();
    const json = safeParse(text) as {
      success?: boolean;
      data?: {
        code?: string;
        device_code?: string;
        user_code?: string;
        verification_uri?: string;
        verification_uri_qrcode?: string;
        expires_in?: number;
        interval?: number;
      };
      error?: { code?: number; message?: string; reason?: string };
    };
    if (!json.success) throw toHttpError(json.error ?? {});

    const d = json.data ?? {};
    const code = d.code ?? d.device_code ?? '';
    if (!code || !d.user_code)
      throw new HttpException(
        { code: 'GETNOTE_OAUTH_BAD_RESPONSE', message: '开放平台未返回设备码' },
        HttpStatus.BAD_GATEWAY,
      );

    const interval = Math.max(Number(d.interval) || 5, 3);
    const expiresIn = Number(d.expires_in) || OAUTH_EXPIRES_FALLBACK;
    this.pending.set(user.openId, {
      code,
      interval,
      expiresAt: Date.now() + expiresIn * 1000,
      lastPollAt: 0,
    });

    return {
      userCode: d.user_code,
      verificationUri: d.verification_uri ?? '',
      // 接口直接返回 data URI 形态的 PNG，前端 <img src> 可直接渲染
      qrcode: d.verification_uri_qrcode ?? '',
      expiresIn,
      interval,
    };
  }

  /**
   * 第 2 步：前端定时轮询，直到用户完成授权 / 拒绝 / 超时。
   * 每次调用最多打一次上游接口，不阻塞 —— 节奏完全由前端 interval 控制。
   *
   * ⚠️ 限流保护：距上次实打实请求不足 interval 秒时直接回 pending，
   * 防止前端定时器被改快或手抖连点把 5000 次/天的额度刷穿。
   */
  async pollOAuth(user: SessionUser): Promise<{
    status: 'pending' | 'success' | 'expired' | 'rejected';
    credential?: CredentialStatus;
  }> {
    const p = this.pending.get(user.openId);
    if (!p) return { status: 'expired' };

    if (Date.now() >= p.expiresAt) {
      this.pending.delete(user.openId);
      return { status: 'expired' };
    }
    if (Date.now() - p.lastPollAt < p.interval * 1000) return { status: 'pending' };

    p.lastPollAt = Date.now();
    const clientId = OAUTH_CLIENT_ID();
    let json: {
      success?: boolean;
      data?: { api_key?: string; client_id?: string; msg?: string };
      error?: { code?: number; message?: string; reason?: string };
    };
    try {
      const res = await fetch(`${BASE}/open/api/v1/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grant_type: 'device_code', client_id: clientId, code: p.code }),
      });
      json = safeParse(await res.text()) as typeof json;
    } catch (e) {
      // 网络抖动不该判成授权失败，让前端下一轮继续试
      this.logger.warn(`OAuth 轮询请求失败（下一轮重试）: ${(e as Error).message}`);
      return { status: 'pending' };
    }

    if (!json.success) {
      const code = json.error?.code;
      // 限流：本轮不算数，把节流窗口推后，下一轮再试
      if (code === 10202) {
        p.lastPollAt = Date.now() - p.interval * 1000 + 3000;
        return { status: 'pending' };
      }
      throw toHttpError(json.error ?? {});
    }

    const d = json.data ?? {};
    // 上游用 data.msg 表达「还没完成」，而不是 success:false —— 两种都要认
    if (d.msg === 'authorization_pending') return { status: 'pending' };
    if (d.msg === 'expired_token') {
      this.pending.delete(user.openId);
      return { status: 'expired' };
    }
    if (d.msg === 'rejected') {
      this.pending.delete(user.openId);
      return { status: 'rejected' };
    }

    const apiKey = d.api_key ?? '';
    const cid = d.client_id ?? clientId;
    if (!apiKey) return { status: 'pending' };

    // 授权完成：同样先验活再落库，与非会员的降级提示保持同一套逻辑
    await this.request({ key: apiKey, clientId: cid }, '/open/api/v1/resource/note/list', {
      query: { cursor: '' },
    });
    this.pending.delete(user.openId);
    const credential = setCredential(user.openId, apiKey, cid, {
      displayName: user.name,
      source: 'oauth',
    });
    return { status: 'success', credential };
  }

  cancelOAuth(user: SessionUser): { ok: boolean } {
    return { ok: this.pending.delete(user.openId) };
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
  /** 全站统一的「系统管理员」判定（与 homepage-config / user 等模块同一写法） */
  private isAdmin(user: SessionUser): boolean {
    return Boolean(user?.roles?.includes('系统管理员'));
  }

  // ── 管理员视角：跨所有「启用的知识库配置」聚合笔记 ────────────────────
  //
  // 为什么不能简单 foreach 上游 cursor：
  //   每个配置一套凭证，上游 cursor 是** per-key **的 —— 多源各拉一页后游标互不相认，
  //   合并结果根本没法用一个 cursor 继续翻。所以这里改成「全量拉齐 → 服务端快照 →
  //   偏移量分页」，pageToken 形如 `snap:<offset>`。
  //
  // ⚠️ 为什么必须有快照(TTL 60 秒)：
  //   Get笔记 限流是**按 API Key 算**的（QPS 2 / 每天 5000）。不缓存的话，
  //   管理员每翻一页就要把 N 个配置全打一遍 → 翻 10 页就是 10N 次请求，
  //   配置一多必撞限流。缓存后只有首次（与过期后）才打上游。
  //   代价：新笔记最多延迟 60 秒出现在管理员列表里 —— 这是明确的取舍。

  /**
   * 管理员聚合快照有效期。
   * ⚠️ 2026-09-09 从 60s 提到 10 分钟：60s 意味着只要隔一分钟再进页面就要重跑一次
   * 全量聚合（实测 5.7s，笔记越多越慢），管理员体感就是「我的笔记很卡」。
   * 配合下面的「过期先返回旧快照 + 后台刷新」，用户不再为刷新买单。
   */
  private static readonly ADMIN_SNAPSHOT_TTL = 600_000;
  /** 上次落库时间：用于节流，避免管理员每次刷笔记页都写一遍库 */
  private lastSnapshotPersistAt = 0;
  /** 笔记正文表是否已确保创建（建表只做一次） */
  private noteBodyReady = false;
  private noteSnapshotReady = false;
  /** 「重新收取正文」的任务进度，按 openId 隔离 */
  private readonly refetchJobs = new Map<string, RefetchBodiesProgress>();
  /** 单个配置最多拉多少页（每页 100 条），防止某个源数据巨量拖垮整次聚合 */
  private static readonly ADMIN_MAX_PAGES_PER_SOURCE = 10;
  /** 源之间的节流间隔。Get笔记 QPS 2，串行 + 250ms 留足余量 */
  private static readonly ADMIN_SOURCE_INTERVAL = 250;
  /**
   * 快照在 Redis 里的存活时间（比内存 TTL 长得多）。
   *
   * ⚠️ 存在的意义是**扛住进程重启**：快照只放内存时，服务一重启就归零，
   * 下一个进来的管理员要同步等一轮全量聚合（实测 5.7s）。而重启并不罕见 ——
   * 2026-09-09 就因 IMAP 未捕获的 error 事件把进程打崩过（已修），
   * 那次崩溃的直接投诉就是「我的笔记第一次进来很慢」。
   * 落 Redis 后，重启完第一次访问就能立刻拿到上一轮的快照，再后台刷新。
   */
  private static readonly ADMIN_SNAPSHOT_REDIS_TTL_SEC = 3600;

  /**
   * 拉齐「这个人能看到的所有笔记」：自己的凭证 + 启用配置的凭证。
   *
   * 去重规则：按 note_id 去重，**自己的凭证优先** —— 自己的那篇归属应该显示自己，
   * 而不是恰好重复同步过它的某个配置。
   *
   * @param onlyRecordIds 只处理这些配置（`recordId`）。非管理员路径必须传 ——
   *   否则每进一次「我的笔记」都要把**全部**启用源的笔记拉一遍（实测 12 个源 24 秒，
   *   而且会打光所有同事的上游额度：官方 QPS 2 / 每天 5000 次是按 Key 算的）。
   *   不传 = 全量（管理员聚合与后台同步用）。
   *   ⚠️ 白名单**不作用于「本人凭证」那一路** —— 那一路只含调用者自己的数据，天然可见。
   */
  private async collectAllNotes(
    user: SessionUser,
    onlyRecordIds?: string[],
  ): Promise<GetnoteNote[]> {
    const entries = await listEnabledSourceCreds(this.base, TABLES.getnoteSource.tableId, {
      maxPages: 5,
    });

    // 组装「数据源」列表：自己的凭证放第一个（去重时优先保留）
    const sources: Array<{
      cred: { key: string; clientId: string };
      ownerName: string;
      ownerOpenId: string;
      sourceName: string;
      /** 自己的那份凭证没有对应配置，记空串 */
      recordId: string;
    }> = [];
    const seenKey = new Set<string>();

    const own = getCredentialPair(user.openId);
    if (own?.key && own.clientId) {
      // 管理员的本人笔记走这一路（凭证来自「向导页」填的个人 Key）。
      //
      // ⚠️ 这一路的 sourceName 早先写死为空，导致**管理员自己的笔记在报表里全归到「未标注」**：
      // 他明明在「知识库配置」里建了来源（如「Richard Sun Get Note」），却因为 getCredentialPair
      // 只返回 { key, clientId }、不带名称，加上后面的 seenKey 去重又把配置表那条跳过，
      // 名字永远用不上（2026-09-13 实测：孙旭峰 17 篇 vs 未标注 17 篇，完全重合）。
      //
      // 现在从配置表里取**同一个账号**那条的「配置名称」套上：
      // 只有 Key 完全相同（同一对凭证）才套用 —— 若 Key 不同，说明是两份不同凭证、
      // 笔记来自不同账号，借用名字会造成张冠李戴，此时保持为空。
      const mine = entries.find(
        (e) =>
          e.ownerOpenId === user.openId &&
          e.cred?.key === own.key &&
          // plainText(配置名称) 为空时 sourceName 会回落成 recordId，那不是「名称」，
          // 套上去等于把 rec_xxx 当配置名显示，不如留空。
          Boolean(e.sourceName) &&
          !e.sourceName.startsWith('rec'),
      );
      sources.push({
        cred: own,
        ownerName: user.name ?? '',
        ownerOpenId: user.openId,
        sourceName: mine?.sourceName ?? '',
        // recordId 故意留空：详情/标签等接口拿它反查「这篇该用哪套凭证」，
        // 本路本来就是用本人凭证，留空即表示「用你自己的 Key 即可」。
        recordId: '',
      });
      seenKey.add(own.key);
    }

    for (const e of entries) {
      if (!e.cred) continue;
      // 白名单过滤放在 seenKey 之前：白名单外的源连「占位」都不该做，
      // 否则它会把 key 记进 seenKey，导致同 key 的白名单源被误跳。
      if (onlyRecordIds && !onlyRecordIds.includes(e.recordId)) continue;
      // 同一个 Key 可能对应多个配置（或多配置共用一份凭证）—— 只拉一次，避免白白消耗限流额度
      if (seenKey.has(e.cred.key)) continue;
      seenKey.add(e.cred.key);
      sources.push({
        cred: e.cred,
        ownerName: e.ownerName,
        ownerOpenId: e.ownerOpenId,
        sourceName: e.sourceName,
        recordId: e.recordId,
      });
    }

    const merged: GetnoteNote[] = [];
    const seenNote = new Set<string>();

    for (let i = 0; i < sources.length; i++) {
      const s = sources[i];
      if (!s) continue;
      if (i > 0) await sleep(GetnoteService.ADMIN_SOURCE_INTERVAL);
      try {
        let cursor = '';
        for (let p = 0; p < GetnoteService.ADMIN_MAX_PAGES_PER_SOURCE; p++) {
          const r = await this.request<GetnoteListResult>(
            s.cred,
            '/open/api/v1/resource/note/list',
            { query: { cursor, page_size: '100' } },
          );
          for (const n of r.notes ?? []) {
            const id = String(n.note_id ?? n.id ?? '').trim();
            if (!id || seenNote.has(id)) continue;
            seenNote.add(id);
            merged.push({
              ...n,
              _owner: s.ownerName,
              // 报表按 openId 归并（姓名会改名、还会同人异写），所以聚合时就得打上
              _ownerOpenId: s.ownerOpenId,
              _sourceName: s.sourceName,
              _sourceRecordId: s.recordId,
            });
          }
          cursor = String(r.cursor ?? '');
          if (!r.has_more || !cursor) break;
        }
      } catch (err) {
        // ⚠️ 单个源失败（Key 失效、限流、网络）绝不能拖垮整次聚合 ——
        // 记日志后继续下一个源，管理员仍能看到其余人的笔记。
        this.logger.warn(
          `管理员聚合：跳过源 ${s.sourceName || s.ownerName || s.ownerOpenId}（${(err as Error).message.slice(0, 80)}）`,
        );
      }
    }

    merged.sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
    return merged;
  }

  /**
   * 管理员的列表实现：快照式分页。
   *
   * ⚠️ 带 q 时与非管理员走的是**不同机制**：非管理员用上游语义搜索（recall，只看自己的
   * Key）；管理员在已拉齐的快照里做标题/内容包含匹配 —— 这样他才能搜到所有人的笔记，
   * 而不用为每个源都额外打一次语义搜索接口（那会把限流额度瞬间打光）。
   */
  private async listAllForAdmin(
    user: SessionUser,
    cursor: string,
    q: string,
    size: number,
    filters: NoteListFilters = {},
  ): Promise<GetnoteListResult> {
    const key = user.openId;
    const now = Date.now();
    let snap = this.adminSnapshots.get(key);

    if (!snap) {
      // 内存里没有：可能是首次进入，也可能是**进程刚重启**（内存快照随进程一起没了）。
      // 先到 Redis 找上一轮的快照 —— 找到就立刻返回，用户不必干等一轮全量聚合。
      const restored = await this.restoreAdminSnapshot(key);
      if (restored && restored.items.length > 0) {
        snap = restored;
        this.adminSnapshots.set(key, snap);
        this.logger.log(
          `管理员笔记快照从 Redis 恢复：${restored.items.length} 条（已避免一次冷启动等待）`,
        );
        // 恢复的数据可能已经旧了，顺手在后台刷新一轮
        void this.refreshAdminSnapshot(key, user);
      } else {
        // 真·首次：Redis 里也没有，只能同步等一次全量聚合。
        const t0 = Date.now();
        const items = await this.collectAllNotes(user);
        snap = { at: Date.now(), items };
        this.adminSnapshots.set(key, snap);
        void this.persistAdminSnapshot(key, items);
        void this.persistNoteSnapshot(items);
        this.logger.log(`管理员笔记快照首次构建：${items.length} 条，耗时 ${Date.now() - t0}ms`);
      }
    } else if (now - snap.at > GetnoteService.ADMIN_SNAPSHOT_TTL) {
      // ⚠️ 过期但手上还有旧数据：先把旧的返回，后台异步刷新。
      // 此前这里是 `await collectAllNotes()` —— 快照一过期，用户每次进页面都要干等
      // 一轮全量聚合（实测 5.7s，笔记越多越慢，官方 QPS 2 的节流是硬成本）。
      // 改成 stale-while-revalidate 后，用户永远不必为刷新买单。
      void this.refreshAdminSnapshot(key, user);
    }

    // 命中缓存也要补库：否则「快照一直有效 ⇒ 永远不落库」，报表会长期空着。
    // 节流：距上次落库超过 10 分钟才写一次，避免频繁写库与无谓开销。
    if (snap && Date.now() - this.lastSnapshotPersistAt > 10 * 60 * 1000) {
      this.lastSnapshotPersistAt = Date.now();
      void this.persistNoteSnapshot(snap.items);
    }

    // 顺手回收其他管理员的过期快照：只按 openId 存，管理员多了不清理会一直占内存
    // （单份快照是完整笔记列表，N 个人就是 N 份全量）。
    for (const [k, v] of this.adminSnapshots) {
      if (k !== key && now - v.at > GetnoteService.ADMIN_SNAPSHOT_TTL) {
        this.adminSnapshots.delete(k);
      }
    }

    const snapshot = snap;

    const keyword = q?.trim().toLowerCase();
    // ⚠️ 筛选必须在**切片之前**做：否则 total 与 hasMore 都是按未筛选的池子算的，
    //    前端会显示「共 509 条」却只有几条能翻出来（分页条与内容对不上）。
    //    管理员路径本来就是「内存快照 + 内存分页」，加筛选不需要动数据、也不需要打上游。
    const filteredPool = this.applyNoteFilters(snapshot.items, filters);
    const pool = keyword
      ? filteredPool.filter(
          (n) =>
            String(n.title ?? '').toLowerCase().includes(keyword) ||
            String(n.content ?? '').toLowerCase().includes(keyword),
        )
      : filteredPool;

    // ⚠️ 快照过期后翻页的处理：
    // 上面那段在过期时会**重新拉取**一次，重建出来的列表可能已经变了（有人新增/删除笔记）。
    // 这时还拿着上一次的 snap:<offset> 去切片，offset 可能越过新列表末尾 → 返回空数组。
    // 用户会看到「明明有数据却是空的」，且不知道该刷新，体验上等同于系统坏了。
    // 所以越界（且列表非空）时回退到第一页，宁可让他觉得「跳回开头」也好过白屏。
    const requested = parseSnapOffset(cursor);
    const offset = requested > 0 && requested >= pool.length ? 0 : requested;
    const slice = pool.slice(offset, offset + size);
    const nextOffset = offset + slice.length;
    const hasMore = nextOffset < pool.length;

    return {
      notes: slice,
      has_more: hasMore,
      cursor: hasMore ? `snap:${nextOffset}` : undefined,
      total: pool.length,
    };
  }

  /** 快照在 Redis 中的 key。按 openId 隔离，与内存快照一一对应。 */
  private snapshotRedisKey(openId: string): string {
    return `getnote:admin_snapshot:${openId}`;
  }

  /**
   * 把快照写进 Redis，供**进程重启后**立即恢复。
   * 失败不影响主流程（Redis 挂了就退化回「纯内存快照」的旧行为）。
   */
  private async persistAdminSnapshot(key: string, items: GetnoteNote[]): Promise<void> {
    try {
      await this.redis.set(
        this.snapshotRedisKey(key),
        JSON.stringify({ at: Date.now(), items }),
        'EX',
        GetnoteService.ADMIN_SNAPSHOT_REDIS_TTL_SEC,
      );
    } catch (e) {
      this.logger.warn(
        `管理员笔记快照写入 Redis 失败（不影响使用）：${(e as Error).message.slice(0, 80)}`,
      );
    }
  }

  /** 进程重启后从 Redis 恢复快照；没有则返回 null。 */
  private async restoreAdminSnapshot(
    key: string,
  ): Promise<{ at: number; items: GetnoteNote[] } | null> {
    try {
      const raw = await this.redis.get(this.snapshotRedisKey(key));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { at?: number; items?: GetnoteNote[] };
      if (!Array.isArray(parsed.items)) return null;
      return { at: Number(parsed.at) || 0, items: parsed.items };
    } catch (e) {
      // Redis 不可用或数据损坏都不能让列表接口挂掉 —— 退化成重建快照
      this.logger.warn(
        `管理员笔记快照从 Redis 恢复失败（将重建）：${(e as Error).message.slice(0, 80)}`,
      );
      return null;
    }
  }

  /** 后台重建管理员笔记快照。同一管理员并发请求只会触发一轮聚合。 */
  /**
   * 把管理员聚合到的笔记落一份到自建 SQL 表，供「笔记统计报表」使用。
   *
   * 为什么需要：笔记本体在 Get笔记 外部 API，只拉不存、限流 QPS 2 ——
   * 直接查上游做「某段时间新增多少笔记」既慢又不可回溯。
   * ⚠️ 这里**不额外消耗上游额度**：复用已经拉到的管理员快照，fire-and-forget 写入，
   * 失败只记日志，绝不影响笔记列表本身的返回。
   */
  private async persistNoteSnapshot(items: GetnoteNote[]): Promise<void> {
    const sql = getSqlStore();
    if (!sql || items.length === 0) return;
    const tableId = TABLES.noteSnapshot.tableId;
    try {
      await this.ensureNoteSnapshotTable();
      // 先拿现有 id 集合：已存在的走 update，新的走 createWithId（用笔记 ID 当主键）
      const existing = new Set<string>();
      let token: string | undefined;
      for (let i = 0; i < 20; i += 1) {
        const page = await sql.search(tableId, { pageSize: 500, ...(token ? { pageToken: token } : {}) });
        for (const r of page.items ?? []) {
          // ⚠️ 同上：search 返回的是 recordId。恒空会让「已存在走 update」永远不成立，
          // 全部落到 createWithId（它是 upsert，所以结果仍然正确，只是绕了路）。
          const rr = r as unknown as { recordId?: string; id?: string };
          existing.add(String(rr.recordId ?? rr.id ?? ''));
        }
        if (!page.hasMore || !page.pageToken) break;
        token = page.pageToken;
      }
      for (const n of items) {
        const id = String(n.note_id ?? n.id ?? '');
        if (!id) continue;
        const fields = {
          笔记ID: id,
          标题: String(n.title ?? ''),
          归属人: String(n._owner ?? ''),
          归属人ID: String(n._ownerOpenId ?? ''),
          来源配置: String(n._sourceName ?? ''),
          来源配置ID: String(n._sourceRecordId ?? ''),
          笔记类型: String(n.note_type ?? ''),
          来源: String(n.source ?? ''),
          标签: noteTagNames(n).join(','),
          标签类型: noteTagTypes(n).join(','),
          // 列表接口本身就返回 content（智能总结）⇒ 顺手落库**零额外上游额度**。
          // 注意只存总结、不存正文：原始记录要打详情接口，由「重新收取」负责。
          总结: String(n.content ?? ''),
          子笔记数: Number(n.children_count ?? 0) || 0,
          笔记创建时间: toEpochMs(n.created_at),
          笔记更新时间: toEpochMs(n.updated_at),
          同步时间: Date.now(),
        };
        if (existing.has(id)) await sql.update(tableId, id, fields);
        else await sql.createWithId(tableId, id, fields);
      }
      this.logger.log(`笔记快照落库完成：${items.length} 条`);
    } catch (e) {
      this.logger.error(`笔记快照落库失败：${(e as Error).message.slice(0, 160)}`);
    }
  }

  /**
   * 主动把管理员视角的笔记同步到快照表（供笔记统计报表用）。
   *
   * 为什么需要这个方法：落库原本挂在「重新聚合笔记」之后，而聚合结果有内存/Redis 快照，
   * 管理员日常打开笔记页往往直接命中缓存、根本不会重新拉取 ⇒ 快照表可能永远是空的
   *（2026-09-11 实测就是这样）。所以必须给一个确定的触发入口。
   *
   * ⚠️ 会真实拉取一次上游（受 QPS 2 节流），所以不是高频操作：给报表页「立即同步」按钮用。
   */
  async syncSnapshot(user: SessionUser): Promise<{ ok: boolean; count: number; message?: string }> {
    try {
      const items = await this.collectAllNotes(user);
      // 顺带刷新内存与 Redis 快照，避免下次进列表还拿到旧的
      this.adminSnapshots.set(user.openId, { at: Date.now(), items });
      void this.persistAdminSnapshot(user.openId, items);
      await this.persistNoteSnapshot(items);
      this.lastSnapshotPersistAt = Date.now();
      return { ok: true, count: items.length };
    } catch (e) {
      const msg = (e as Error).message.slice(0, 160);
      this.logger.warn(`笔记快照同步失败：${msg}`);
      return { ok: false, count: 0, message: msg };
    }
  }

  private async refreshAdminSnapshot(key: string, user: SessionUser): Promise<void> {
    if (this.adminSnapshotInflight.has(key)) return;
    this.adminSnapshotInflight.add(key);
    const t0 = Date.now();
    try {
      const items = await this.collectAllNotes(user);
      this.adminSnapshots.set(key, { at: Date.now(), items });
      void this.persistAdminSnapshot(key, items);
      void this.persistNoteSnapshot(items);
      this.logger.log(`管理员笔记快照后台刷新完成：${items.length} 条，耗时 ${Date.now() - t0}ms`);
    } catch (e) {
      // 刷新失败时保留旧快照继续可用，不打断用户当前浏览
      this.logger.warn(`管理员笔记快照后台刷新失败（沿用旧快照）：${(e as Error).message.slice(0, 120)}`);
    } finally {
      this.adminSnapshotInflight.delete(key);
    }
  }

  async list(
    user: SessionUser,
    cursor?: string,
    q?: string,
    size = 20,
    filters: NoteListFilters = {},
  ): Promise<GetnoteListResult> {
    // 管理员：跨所有启用配置聚合（走快照分页，不用上游 cursor）
    if (this.isAdmin(user))
      return this.listAllForAdmin(user, cursor ?? '', q ?? '', size, filters);

    // 非管理员：**被关联到知识库配置时**，只看到这些配置的笔记 —— 与管理员同一条
    // 数据来源（每条配置用自己的凭证去拉），只是配置集合被收窄到「我能看到的那几条」。
    // 一条都没被关联的，回落到「只用自己的凭证」的旧行为。
    const scoped = await this.linkedSourceIds(user);
    if (scoped.length)
      return this.listScopedBySources(user, scoped, cursor ?? '', q ?? '', size, filters);

    // 非管理员只用自己的 Key 直接翻上游游标，size 由上游决定（这里用不到）
    void size;
    const cred = await this.credFor(user);
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

  /**
   * 当前用户**可见**的知识库配置 recordId 集合（非管理员用）。
   *
   * 判据复用 `sourceVisibleTo()` —— 与「知识库配置」列表用的是同一份规则，
   * 不能在这里再写一套（写两处必然漂移：一处放行一处拦截，就是越权或"看不到自己的配置"）。
   * 返回空数组 = 没被关联任何配置 ⇒ 调用方回落到「只用自己的凭证」。
   */
  private async linkedSourceIds(user: SessionUser): Promise<string[]> {
    const entries = await listEnabledSourceCreds(this.base, TABLES.getnoteSource.tableId, {
      maxPages: 5,
    });
    const myId = await resolveUserIdByOpenId(this.base, USER_TABLE.tableId, user.openId ?? '');
    return entries.filter((e) => sourceVisibleTo(e, user, myId)).map((e) => e.recordId);
  }

  /**
   * 「我的笔记」的结构化筛选：来源 / 配置名称 / 归属人 / 标签（2026-09-17 峰哥要求）。
   *
   * 为什么在内存里做：
   *   - 管理员路径本来就是「内存快照（`adminSnapshots`，含 tags）+ 内存分页」，
   *     在这里加筛选**不需要任何数据迁移**，也不用再去打上游（QPS 2，几百条要几分钟）；
   *   - 非管理员路径同样是「聚合后内存分页」（`listScopedBySources`）。
   *   换句话说：数据本来就在手里，缺的只是过滤那一步。
   *
   * ⚠️ 必须按 `splitNoteTags()` 的口径判「来源」与「标签」—— 前端列表也是用它拆的
   *    （`packages/contracts/src/getnote.ts`）。两边各写一份必然漂移，
   *    症状是「列里明明显示来源=得到大脑，按得到大脑筛却筛不到」。
   *
   * 匹配语义（与前端筛选控件一一对应）：
   *   - 来源 / 配置名称 / 归属人：**精确匹配**（都是枚举值或人名，模糊会误命中）
   *   - 标签：**模糊包含**（一条笔记带多个标签，用等值必然全筛空）
   */
  private applyNoteFilters(items: GetnoteNote[], f: NoteListFilters): GetnoteNote[] {
    const source = f.source?.trim();
    const configName = f.configName?.trim();
    const owner = f.owner?.trim();
    const tag = f.tag?.trim().toLowerCase();
    if (!source && !configName && !owner && !tag) return items;

    return items.filter((n) => {
      if (source && splitNoteTags(n.tags).source !== source) return false;
      if (configName && String(n._sourceName ?? '').trim() !== configName) return false;
      if (owner && String(n._owner ?? '').trim() !== owner) return false;
      if (tag && !splitNoteTags(n.tags).tags.some((x) => x.toLowerCase().includes(tag))) return false;
      return true;
    });
  }

  /**
   * 按「可见配置集合」收窄的笔记列表（非管理员）。
   *
   * 做法是**复用管理员的聚合**（`collectAllNotes` 本来就是「每条配置用自己的凭证去拉」，
   * 与调用者是谁无关），再按 `_sourceRecordId` 过滤出我可见的那些。
   *
   * ⚠️ 刻意**不**用管理员那套内存/Redis 快照：非管理员能看到的配置很少，
   * 每次现拉即可；共用快照反而会把「别人的笔记」缓进同一个快照，是越权隐患。
   */
  private async listScopedBySources(
    user: SessionUser,
    sourceIds: string[],
    cursor: string,
    q: string,
    size: number,
    filters: NoteListFilters = {},
  ): Promise<GetnoteListResult> {
    // 只拉「我可见的那些源」——不限定的话要把全部启用源都打一遍（12 个源约 24 秒，
    // 还会消耗所有同事的上游额度）。
    const all = await this.collectAllNotes(user, sourceIds);
    // 🔴 判据是纯函数 `noteInScopedSources`（`source-cred.ts`）——**空 recordId 也必须放行**，
    //    那是「本人凭证」那一路（只含调用者自己的笔记）。把它丢掉会让「向导页填过个人凭证 +
    //    又有关联配置」的用户列表恒为空，而管理员看起来一切正常。
    //    2026-09-17 刘佳音｜Joy 报障（15 条一条不显示）即此因，细节见该函数的注释。
    const mine = all.filter((n) => noteInScopedSources(n, sourceIds));

    const keyword = q.trim().toLowerCase();
    // 结构化筛选（来源 / 配置名称 / 归属人 / 标签）先过一遍，关键字检索再叠加
    const scopedPool = this.applyNoteFilters(mine, filters);
    const pool = keyword
      ? scopedPool.filter(
          (n) =>
            String(n.title ?? '').toLowerCase().includes(keyword) ||
            String(n.content ?? '').toLowerCase().includes(keyword),
        )
      : scopedPool;

    const requested = parseSnapOffset(cursor);
    const offset = requested > 0 && requested >= pool.length ? 0 : requested;
    const slice = pool.slice(offset, offset + size);
    const nextOffset = offset + slice.length;
    const hasMore = nextOffset < pool.length;
    return {
      notes: slice,
      has_more: hasMore,
      cursor: hasMore ? `snap:${nextOffset}` : undefined,
      total: pool.length,
    };
  }

  /**
   * 笔记详情。⚠️ 数据在 data.note 下，不是 data 直接取。
   *
   * 管理员分支：先用列表快照里记下的 `_sourceRecordId` 反查出**那条配置自己的凭证**，
   * 再去拉详情 —— 否则管理员点开别人的笔记必然失败（自己的 Key 下没有那条笔记）。
   */
  async detail(user: SessionUser, id: string, imageQuality?: string): Promise<GetnoteNote> {
    let cred = await this.credFor(user);
    let owner: { name: string; sourceName: string; ownerOpenId: string } | null = null;

    if (this.isAdmin(user)) {
      const found = await this.adminCredForNote(user, id);
      if (found) {
        cred = found.cred;
        owner = {
          name: found.ownerName,
          sourceName: found.sourceName,
          ownerOpenId: found.ownerOpenId,
        };
      }
    }

    const data = await this.request<{ note: GetnoteNote }>(
      cred,
      '/open/api/v1/resource/note/detail',
      { query: { id, image_quality: imageQuality } },
    );
    const note = data?.note ?? {};
    const audio = note.audio;
    // 原始记录：录音类笔记在 audio.original（实测录音笔为原始转写全文）；
    // transcript 在实测中为空，作为兜底保留。两者都无则空字符串。
    const rawRecord =
      (typeof audio?.original === 'string' && audio.original.trim()) ||
      (typeof audio?.transcript === 'string' && audio.transcript.trim()) ||
      '';
    const full: GetnoteNote = {
      ...note,
      rawRecord,
      ...(owner
        ? { _owner: owner.name, _ownerOpenId: owner.ownerOpenId, _sourceName: owner.sourceName }
        : {}),
    };
    // 顺手落一份正文（fire-and-forget）：**不额外消耗上游额度**，就是把这次已经拉到的正文存下来。
    // 这样「看过一遍」的笔记下次就能从本地读，也让「重新收取」不必从头抓。
    // 失败只记日志 —— 正文落库绝不能影响「打开一篇笔记」这个主流程。
    void this.persistNoteBody(full);
    return full;
  }

  /**
   * 把一篇笔记的正文（总结 + 原始记录）落库。幂等 upsert，主键 = 笔记 ID。
   *
   * `content` 是「智能总结」（章节概要 / 金句 / 待办也在这里面），
   * `rawRecord` 是「原始记录」（录音类的说话人带时间戳转写全文）。
   * 两者都存，且分开存 —— 业务侧「转换为业务记录」时要分别映射到「沟通总结 / 沟通明细」。
   */
  private async persistNoteBody(n: GetnoteNote): Promise<void> {
    const sql = getSqlStore();
    if (!sql) return;
    const id = String(n.note_id ?? n.id ?? '').trim();
    if (!id) return;
    try {
      await this.ensureNoteBodyTable();
      const summary = String(n.content ?? '');
      const detail = String(n.rawRecord ?? '');
      const tagNames = noteTagNames(n);
      const tagTypes = noteTagTypes(n);
      await sql.createWithId(TABLES.noteBody.tableId, id, {
        笔记ID: id,
        标题: String(n.title ?? ''),
        归属人: String(n._owner ?? ''),
        归属人ID: String(n._ownerOpenId ?? ''),
        来源配置: String(n._sourceName ?? ''),
        来源配置ID: String(n._sourceRecordId ?? ''),
        笔记类型: String(n.note_type ?? ''),
        来源: String(n.source ?? ''),
        标签: tagNames.join(','),
        标签类型: tagTypes.join(','),
        总结: summary,
        原始记录: detail,
        总结字数: summary.length,
        明细字数: detail.length,
        子笔记数: Number(n.children_count ?? 0) || 0,
        录音时长: Number(n.audio?.duration ?? 0) || 0,
        附件数: Array.isArray(n.attachments) ? n.attachments.length : 0,
        录音卡SN: String(n.recorder_sn ?? ''),
        笔记创建时间: toEpochMs(n.created_at),
        笔记更新时间: toEpochMs(n.updated_at),
        正文抓取时间: Date.now(),
      });
    } catch (e) {
      this.logger.warn(`笔记正文落库失败（不影响读取）：${(e as Error).message.slice(0, 160)}`);
    }
  }

  /**
   * 建「笔记正文表」（幂等）。
   *
   * 🔴 必须传字段元数据 —— 不传的话 `acms_fields` 里没有定义，
   * 读出来日期是毫秒时间戳、数字是字符串（仓库里这个坑踩过多次，
   * 隔壁快照表就是没传，`acms_fields` 至今 0 条）。
   */
  private async ensureNoteBodyTable(): Promise<void> {
    if (this.noteBodyReady) return;
    const sql = getSqlStore();
    if (!sql) return;
    const T = { TEXT: 1, NUMBER: 2, DATE: 5 } as const;
    await sql.ensureTable(TABLES.noteBody.tableId, '笔记正文表', [
      { name: '笔记ID', type: T.TEXT },
      { name: '标题', type: T.TEXT },
      { name: '归属人', type: T.TEXT },
      { name: '归属人ID', type: T.TEXT },
      { name: '来源配置', type: T.TEXT },
      { name: '来源配置ID', type: T.TEXT },
      { name: '笔记类型', type: T.TEXT },
      { name: '来源', type: T.TEXT },
      { name: '标签', type: T.TEXT },
      { name: '标签类型', type: T.TEXT },
      { name: '总结', type: T.TEXT },
      { name: '原始记录', type: T.TEXT },
      { name: '总结字数', type: T.NUMBER },
      { name: '明细字数', type: T.NUMBER },
      { name: '子笔记数', type: T.NUMBER },
      { name: '录音时长', type: T.NUMBER },
      { name: '附件数', type: T.NUMBER },
      { name: '录音卡SN', type: T.TEXT },
      // 同快照表：日期字段声明成 DATE 会被格式化成 "YYYY-MM-DD"，
      // 而这里存的是元秒时间戳、上层也是按毫秒处理 ⇒ 用 NUMBER 避免精度被抹
      { name: '笔记创建时间', type: T.NUMBER },
      { name: '笔记更新时间', type: T.NUMBER },
      { name: '正文抓取时间', type: T.NUMBER },
    ]);
    this.noteBodyReady = true;
    this.logger.log('笔记正文表已就绪');
  }

  /**
   * 建「笔记快照表」的**字段元数据**（幂等）。
   *
   * ⚠️ 这张表 2026-09-11 建的时候 `ensureTable(..., [])` **没传 fields** ——
   * 结果 `acms_fields` 里一条元数据都没有：日期读出来是毫秒时间戳、数字读出来是字符串。
   * 现在补上；`ensureTable` 对字段是 upsert，**对已存在的表也生效**，所以老数据无需迁移。
   */
  private async ensureNoteSnapshotTable(): Promise<void> {
    if (this.noteSnapshotReady) return;
    const sql = getSqlStore();
    if (!sql) return;
    const T = { TEXT: 1, NUMBER: 2, DATE: 5 } as const;
    await sql.ensureTable(TABLES.noteSnapshot.tableId, '笔记快照表', [
      { name: '笔记ID', type: T.TEXT },
      { name: '标题', type: T.TEXT },
      { name: '归属人', type: T.TEXT },
      { name: '归属人ID', type: T.TEXT },
      { name: '来源配置', type: T.TEXT },
      { name: '来源配置ID', type: T.TEXT },
      { name: '笔记类型', type: T.TEXT },
      { name: '来源', type: T.TEXT },
      { name: '标签', type: T.TEXT },
      { name: '标签类型', type: T.TEXT },
      { name: '总结', type: T.TEXT },
      { name: '子笔记数', type: T.NUMBER },
      // ⚠️ 三个时间字段声明成 **NUMBER 而不是 DATE**（2026-09-17 踩过）：
      //    `formatReadValue()` 遇到 type=5 会把值格式化成 "YYYY-MM-DD" 字符串，
      //    而本表的消费者（笔记统计报表）是按**毫秒**比区间、按天分桶的 ——
      //    声明成 DATE 后读出来变成「只有日期」，30 天窗口的笔记数会从 345 变 336
      //    （当天的时分被抹掉、跨天边界漂移）。NUMBER 读出来就是原始毫秒，零精度损失。
      { name: '笔记创建时间', type: T.NUMBER },
      { name: '笔记更新时间', type: T.NUMBER },
      { name: '同步时间', type: T.NUMBER },
    ]);
    this.noteSnapshotReady = true;
    this.logger.log('笔记快照表字段元数据已就绪');
  }

  /**
   * 「重新收取」正文：把指定配置（不传 = 当前用户可见的全部配置）下的笔记正文批量拉一遍并落库。
   *
   * 为什么必须异步：上游限速 QPS 2，一条 0.6 秒 —— 几百条要几分钟，
   * 同步等会被 nginx 掐成 504（知识库配置的「立即收取」当初就是这么改成异步的）。
   * 进度放内存，进程重启即丢，但重跑幂等（按笔记 ID upsert），可接受。
   */
  async startRefetchBodies(
    user: SessionUser,
    sourceRecordId?: string,
  ): Promise<RefetchBodiesProgress> {
    const key = `bodies:${user.openId}`;
    if (this.refetchJobs.get(key)?.running) return this.refetchJobs.get(key)!;
    const job: RefetchBodiesProgress = {
      running: true,
      total: 0,
      done: 0,
      stored: 0,
      skipped: 0,
      failed: 0,
      startedAt: Date.now(),
    };
    this.refetchJobs.set(key, job);
    void this.runRefetchBodies(user, sourceRecordId, job).catch((e) => {
      job.running = false;
      job.error = (e as Error).message.slice(0, 200);
    });
    return job;
  }

  async refetchBodiesStatus(user: SessionUser): Promise<RefetchBodiesProgress> {
    return (
      this.refetchJobs.get(`bodies:${user.openId}`) ?? {
        running: false,
        total: 0,
        done: 0,
        stored: 0,
        skipped: 0,
        failed: 0,
      }
    );
  }

  private async runRefetchBodies(
    user: SessionUser,
    sourceRecordId: string | undefined,
    job: RefetchBodiesProgress,
  ): Promise<void> {
    // 1) 取笔记清单：管理员走聚合快照，普通用户走自己的上游列表
    const notes = this.isAdmin(user)
      ? await this.collectAllNotes(user)
      : ((
          await this.request<GetnoteListResult>(
            await this.credFor(user),
            '/open/api/v1/resource/note/list',
            { query: {} },
          )
        ).notes ?? []);
    const target = sourceRecordId
      ? notes.filter((n) => String(n._sourceRecordId ?? '') === sourceRecordId)
      : notes;
    job.total = target.length;
    if (!target.length) {
      job.running = false;
      return;
    }

    // 2) 逐条拉详情并落库。串行 + 0.6s 间隔，压住上游 QPS 2。
    for (const n of target) {
      const id = String(n.note_id ?? n.id ?? '');
      if (!id) continue;
      try {
        const full = await this.detail(user, id);
        const hasBody = Boolean(String(full.content ?? '').length || String(full.rawRecord ?? '').length);
        if (hasBody) job.stored += 1;
        else job.skipped += 1;
      } catch (e) {
        job.failed += 1;
        this.logger.warn(`重新收取失败 ${id}：${(e as Error).message.slice(0, 120)}`);
      }
      job.done += 1;
      job.lastNoteId = id;
      await new Promise((r) => setTimeout(r, 600));
    }
    job.running = false;
    job.finishedAt = Date.now();
    this.logger.log(
      `重新收取完成：共 ${job.total}，成功 ${job.stored}，空正文 ${job.skipped}，失败 ${job.failed}`,
    );
  }

  /**
   * 找出某篇笔记该用哪套凭证打开（仅管理员）。
   *
   * 依据是列表快照里的 `_sourceRecordId`：不用逐个 Key 去试（那会把限流额度打光），
   * 而是直接从配置表里取出那条配置自己的凭证。
   * 返回 null 表示这篇不在任何配置下 —— 那就是管理员自己的笔记，用自己的 Key 即可。
   */
  private async adminCredForNote(
    user: SessionUser,
    noteId: string,
  ): Promise<{
    cred: { key: string; clientId: string };
    ownerName: string;
    sourceName: string;
    ownerOpenId: string;
  } | null> {
    const snap = this.adminSnapshots.get(user.openId);
    const meta = snap?.items.find((n) => String(n.note_id ?? n.id ?? '') === String(noteId));
    const recordId = meta?._sourceRecordId;
    if (!recordId) return null; // 管理员自己的笔记（列表里 sourceName 为空）

    const entries = await listEnabledSourceCreds(this.base, TABLES.getnoteSource.tableId, {
      maxPages: 5,
    });
    const hit = entries.find((e) => e.recordId === recordId);
    if (!hit?.cred) return null;
    return {
      cred: hit.cred,
      ownerName: hit.ownerName,
      ownerOpenId: hit.ownerOpenId,
      sourceName: hit.sourceName,
    };
  }

  /** 新建文本笔记（同步返回 note_id）。链接/图片笔记是异步任务，本模块暂不支持。 */
  async create(
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
      await this.credFor(user),
      '/open/api/v1/resource/note/save',
      { method: 'POST', body: { note_type: 'plain_text', ...body } },
    );
  }

  /**
   * 更新笔记。
   * ⚠️ title/content/tags 至少要传一个，且仅支持 plain_text 类型。
   * ⚠️ tags 是**替换**语义（不传则保持原样，传了就整体覆盖）。
   */
  async update(
    user: SessionUser,
    body: { note_id: string; title?: string; content?: string; tags?: string[] },
  ): Promise<unknown> {
    return this.request(await this.credFor(user), '/open/api/v1/resource/note/update', {
      method: 'POST',
      body,
    });
  }

  /** 删除笔记（移入回收站）。调用方必须先向用户二次确认。 */
  async remove(user: SessionUser, noteId: string): Promise<unknown> {
    return this.request(await this.credFor(user), '/open/api/v1/resource/note/delete', {
      method: 'POST',
      body: { note_id: noteId },
    });
  }

  // ── 给 SourcesService 调用的「凭证对」入口 ────────────────────────────
  // 知识库配置表里的凭证是**配置项自己的**（不是当前会话用户的），
  // 所以这里直接接受 cred，不走 credFor()。

  /**
   * 验证一对凭证是否有效（打一次真实的 list 接口）。
   * 失败会抛出结构化 HttpException（带 code / upstreamCode），调用方据此判断原因。
   * 给 SourcesService.testSource() 用：用户点"测试配置"时立刻验活。
   */
  async probeCredentials(apiKey: string, clientId: string): Promise<unknown> {
    return this.request(
      { key: String(apiKey ?? '').trim(), clientId: String(clientId ?? '').trim() },
      '/open/api/v1/resource/note/list',
      { query: { cursor: '' } },
    );
  }

  /**
   * 用指定凭证拉一页笔记（给 SourcesService.syncOne() 同步用）。
   * pageSize 默认 50，避免单次拉太多；上限 100。
   */
  listWithCred(
    cred: { key: string; clientId: string },
    cursor: string,
    q?: string,
    pageSize?: number,
  ): Promise<GetnoteListResult> {
    const size = Math.min(Math.max(Number(pageSize) || 50, 1), 100);
    return this.request<GetnoteListResult>(cred, '/open/api/v1/resource/note/list', {
      query: { cursor, q, page_size: String(size) },
    });
  }

  /** 全局语义搜索。结果在 data.results 下，取不到再回退到顶层 results。 */
  async recall(user: SessionUser, query: string, topK = 5): Promise<GetnoteRecallItem[]> {
    const k = Math.min(Math.max(Number(topK) || 5, 1), 10);
    const data = await this.request<{ results?: GetnoteRecallItem[] } & GetnoteRecallItem[]>(
      await this.credFor(user),
      '/open/api/v1/resource/recall',
      { method: 'POST', body: { query, top_k: k } },
    );
    return (data as { results?: GetnoteRecallItem[] })?.results ?? (data as GetnoteRecallItem[]) ?? [];
  }

  /** 添加标签。返回该笔记的完整标签列表（含 tag id，删标签时要用到）。 */
  async addTags(
    user: SessionUser,
    noteId: string,
    tags: string[],
  ): Promise<{ note_id?: string; tags?: GetnoteTag[] }> {
    return this.request(await this.credFor(user), '/open/api/v1/resource/note/tags/add', {
      method: 'POST',
      body: { note_id: noteId, tags },
    });
  }

  /**
   * 删除标签。
   * ⚠️ 传的是 tag_id（不是标签名），来自 addTags 返回值或 detail 的 tags[].id。
   * ⚠️ system 类型标签不允许删除，调了会报错。
   */
  async removeTag(user: SessionUser, noteId: string, tagId: string): Promise<unknown> {
    return this.request(await this.credFor(user), '/open/api/v1/resource/note/tags/delete', {
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

  // ── 笔记转换留痕 ──────────────────────────────────────────────────
  //
  // ⚠️ 留痕**不写在 Get笔记 标签上**：上游硬限制单篇笔记最多 5 个标签
  //   （报错 `tags length must be less than 5`），而 system + ai 标签常已占掉 4 个，
  //   留痕只剩 1 个位 —— 一篇笔记只能成功留痕一个模块，之后转其他模块全部静默失败。
  //   所以留痕落在 ACMS 自己的「笔记转换记录」表：次数可无限累加，还能记住
  //   「转成了哪条业务记录」。

  /**
   * 记一次转换。同一笔记 + 同一模块累加次数，返回最新次数。
   *
   * 返回的 `logId` 要给目标页保存成功后回填「转成了哪条记录」用。
   */
  async logConvert(
    user: SessionUser,
    input: { noteId: string; noteTitle?: string; moduleKey: string; moduleLabel: string },
  ): Promise<{ logId: string; count: number }> {
    const tableId = TABLES.noteConvertLog.tableId;
    const noteId = String(input?.noteId ?? '');
    const moduleKey = String(input?.moduleKey ?? '');
    if (!noteId || !moduleKey)
      throw new HttpException('BAD_REQUEST:noteId/moduleKey required', HttpStatus.BAD_REQUEST);

    const res = await this.base.search(tableId, {
      pageSize: 20,
      filter: buildFilter([
        { field: '笔记ID', value: [noteId] },
        { field: '模块KEY', value: [moduleKey] },
      ]),
    });
    // ⚠️ 文本字段读回来是富文本数组，必须 toText；直接 String() 会得到 "[object Object]"
    const hit = res.items.find(
      (r) => toText(r.fields['笔记ID']) === noteId && toText(r.fields['模块KEY']) === moduleKey,
    );

    const now = Date.now();
    if (hit) {
      const prev = Number(hit.fields['转换次数'] ?? 0) || 0;
      const count = prev + 1;
      await this.base.update(tableId, hit.recordId, {
        转换次数: count,
        转换时间: now,
        转换人: user?.name ?? '',
        笔记标题: input.noteTitle || toText(hit.fields['笔记标题']) || '',
      });
      return { logId: hit.recordId, count };
    }

    const logId = await this.base.create(tableId, {
      笔记标题: input.noteTitle ?? '',
      笔记ID: noteId,
      目标模块: input.moduleLabel ?? '',
      模块KEY: moduleKey,
      转换次数: 1,
      转换时间: now,
      转换人: user?.name ?? '',
      目标记录ID: '',
    });
    return { logId, count: 1 };
  }

  /**
   * 批量查若干笔记的转换留痕，返回 noteId → 留痕列表。
   *
   * 一次拉全表再内存过滤：飞书服务端过滤只支持单值，逐笔记查会把请求数放大成 N 倍；
   * 而转换记录表增长缓慢（每篇笔记 × 每个模块才一行），全表拉取更划算。
   */
  async listConverts(
    user: SessionUser,
    noteIds: string[],
  ): Promise<Record<string, NoteConvertLogItem[]>> {
    void user; // 留痕是全局可见的，不按人过滤
    const tableId = TABLES.noteConvertLog.tableId;
    const want = new Set((noteIds ?? []).map((v) => String(v)).filter(Boolean));
    const out: Record<string, NoteConvertLogItem[]> = {};
    if (!want.size) return out;

    let pageToken: string | undefined;
    for (let i = 0; i < 5; i++) {
      const res = await this.base.search(tableId, { pageSize: 200, pageToken });
      for (const r of res.items) {
        const noteId = toText(r.fields['笔记ID']) ?? '';
        if (!want.has(noteId)) continue;
        if (!out[noteId]) out[noteId] = [];
        out[noteId].push({
          logId: r.recordId,
          moduleKey: toText(r.fields['模块KEY']) ?? '',
          moduleLabel: toText(r.fields['目标模块']) ?? '',
          count: Number(r.fields['转换次数'] ?? 1) || 1,
          at: r.fields['转换时间'] as string | number | undefined,
          by: toText(r.fields['转换人']) ?? '',
          targetRecordId: toText(r.fields['目标记录ID']) ?? '',
        });
      }
      if (!res.hasMore || !res.pageToken) break;
      pageToken = res.pageToken;
    }
    return out;
  }

  /**
   * 回填「转成了哪条业务记录」—— 转换流程的最后一步。
   * 目标页保存成功后才拿得到记录 id，所以只能事后回写。
   * 回填失败不影响业务记录本身（它已经存下来了）。
   */
  async linkConvert(
    user: SessionUser,
    logId: string,
    targetRecordId: string,
  ): Promise<{ ok: boolean }> {
    void user;
    const id = String(logId ?? '');
    const recId = String(targetRecordId ?? '');
    if (!id || !recId)
      throw new HttpException(
        'BAD_REQUEST:logId/targetRecordId required',
        HttpStatus.BAD_REQUEST,
      );
    await this.base.update(TABLES.noteConvertLog.tableId, id, { 目标记录ID: recId });
    return { ok: true };
  }

  /**
   * 批量查若干笔记「属于哪个知识库配置」，返回 noteId → 配置信息。
   *
   * 为什么需要这张表：Get笔记 的 note 对象里**没有任何字段**能标识归属 ——
   * 实测 source 全是 "app"（平台自己的来源标识，指手机 App 录音）、note_type 全是
   * recorder_audio、tags 里也没有配置名。归属只能由 ACMS 侧记录：
   * 自动同步时 SourcesService.processNote 写入，历史笔记用回填脚本补。
   *
   * 一次拉全表再内存过滤（同 listConverts）：飞书服务端过滤只支持单值，
   * 逐笔记查会把请求数放大 N 倍，而映射表每篇笔记才一行，全表更划算。
   */
  async listConfigMap(
    user: SessionUser,
    noteIds: string[],
  ): Promise<Record<string, NoteConfigMapItem>> {
    const isAdmin = this.isAdmin(user);
    const myOpenId = user?.openId ?? '';
    const tableId = TABLES.noteConfigMap.tableId;
    const want = new Set((noteIds ?? []).map((v) => String(v)).filter(Boolean));
    const out: Record<string, NoteConfigMapItem> = {};
    if (!want.size) return out;

    // 同一 noteId 可能有多条映射（两个配置用了同一份 API Key 时就会这样）。
    // 裁决优先级：① 归属是自己的优先；② 其次更新时间新的胜。
    // 不裁决的话后读到的直接覆盖先读到的，配置名称会随机串。
    const ownerOf = new Map<string, string>();
    const updatedOf = new Map<string, number>();

    let pageToken: string | undefined;
    for (let i = 0; i < 5; i++) {
      const res = await this.base.search(tableId, { pageSize: 200, pageToken });
      for (const r of res.items) {
        const noteId = toText(r.fields['笔记ID']) ?? '';
        if (!noteId || !want.has(noteId)) continue;

        const ownerOpenId = toText(r.fields['归属人ID']) ?? '';
        // 行级隔离：非管理员看不到别人归属的映射（管理员例外）
        if (!isAdmin && ownerOpenId !== myOpenId) continue;

        const ts = Number(r.fields['更新时间'] ?? 0) || 0;
        const prevOwner = ownerOf.get(noteId);
        if (prevOwner !== undefined) {
          const prevIsMine = prevOwner === myOpenId;
          const curIsMine = ownerOpenId === myOpenId;
          if (prevIsMine && !curIsMine) continue;
          if (prevIsMine === curIsMine && ts <= (updatedOf.get(noteId) ?? 0)) continue;
        }

        out[noteId] = {
          configId: toText(r.fields['配置ID']) ?? '',
          configName: toText(r.fields['配置名称']) ?? '',
        };
        ownerOf.set(noteId, ownerOpenId);
        updatedOf.set(noteId, ts);
      }
      if (!res.hasMore || !res.pageToken) break;
      pageToken = res.pageToken;
    }
    return out;
  }
}
