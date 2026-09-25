import { Inject, Injectable, Logger, HttpException, HttpStatus, type OnModuleInit } from '@nestjs/common';
import type { BaseClient } from '@acms/base-adapter';
import { TABLES, USER_TABLE, splitNoteTags, NOTE_STATUS_ACTIVE, NOTE_STATUS_ALL, NOTE_STATUS_ARCHIVED, hiddenArchivedCount, isArchivedNote, normalizeNoteStatus, noteStatusMatches, NOTE_ENTITY_TYPE_STUDENT, NOTE_ENTITY_TYPE_TO_PATH, SECTION_LABELS, moduleByPath, modulePermission } from '@acms/contracts';
import { authorize, type Principal } from '@acms/domain';
// 「学生关联笔记」聚合要复用学生全景那套「按学生取记录」的口径（meta.studentMatch / 类型域 / 模块权限）
import { LIFECYCLE_METAS } from '../shared/lifecycle.meta.js';
import { IDP_PLAN_META } from '../idp/idp.meta.js';
import { linkIds } from '../shared/record.util.js';
import {
  buildTypeScopeFilter,
  matchFilter,
  typeAllowedValues,
  type RecordMeta,
} from '../shared/generic-crud.module.js';
import { getSqlStore } from '../base.provider.js';
import { toText } from '@acms/base-adapter';
import type {
  SessionUser,
  NoteConvertLogItem,
  NoteConfigMapItem,
  NoteListFilters,
  StudentNoteLink,
  StudentNoteSource,
  StudentNoteLinksResult,
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
  pickSourceEntry,
  resolveUserIdByOpenId,
  sourceVisibleTo,
  type SourceCredEntry,
} from './source-cred.js';
// 音频落库要把字节流存进全站附件目录（`loc_*` token），复用统一的附件基建
import { FileUploadService } from '../file-upload/file-upload.service.js';
// 音频容器以文件头为准（上游同批录音里 Ogg/Opus 与 MP3 混杂，写死 MIME 会播不出来）
import { sniffAudioFormat } from '../file-storage/audio-format.js';
// 落正文时的字段合并（保住已抓好的音频 —— 走 createWithId 是整体替换，见该文件注释）
import { mergeNoteBodyPayload } from './note-body-merge.js';
// 「笔记状态表」的建表定义（与启动期那份共用同一份字段元数据）
import { ensureNoteStatusTable } from './note-status.schema.js';

/** 得到大脑（Get笔记）开放平台。所有凭证只发往此地址，不接受任何其他 API 地址。 */
const BASE = 'https://openapi.biji.com';

/**
 * 「音频状态」的取值 —— 与正文表 `音频状态` 字段一致。
 *
 * ⚠️ 这是**代码判据**（批量任务据此跳过已完成、只重试失败的），不是给人挑的选项，
 * 所以**不做成字典**：字典是运行时可改的数据，被改坏会让任务反复重跑或全部静默跳过。
 */
const AUDIO_STATE_SAVED = '已保存';
const AUDIO_STATE_NONE = '上游无音频';
const AUDIO_STATE_FAILED = '失败';

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
  // IDP沟通（2026-09-21 新增的学生记录类型）—— 它是**独立的一个实体类型**（不是「日常跟进」），
  // 因为详情页传的 entityType 就是记录自身的类型值，笔记绑定按「实体类型 + 记录 id」存。
  // 有这条映射，打在笔记上的标签才是 `acms:idpComm:recXXX` 这种可读形式；
  // 缺了它也不会报错（`linkTag` 会退化成 `acms:IDP沟通:recXXX`），但外部看标签会比较别扭。
  IDP沟通: 'idpComm',
  // 学生沟通（2026-09-21）：与学生**本人**的沟通，区别于「家校沟通」（与家长）
  学生沟通: 'studentComm',
  // 学生实践（2026-09-26）：围绕实践类安排的沟通记录（注意不是「实践活动」模块，那是另一张表）
  学生实践: 'studentPractice',
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

/** SessionUser → ABAC 主体（`authorize()` 的入参）。与 student-360 里那份保持同一形状 */
function toPrincipal(user: SessionUser): Principal {
  return { roles: user.roles, campuses: user.campuses, maxDataLevel: user.maxDataLevel };
}

/**
 * 业务记录的「标题」——各模块的字段名不同（沟通主题 / 跟进内容 / 评价标题…），
 * 所以按候选列表取第一个非空值，全空时回落到来源标签。
 */
const RECORD_TITLE_FIELDS = [
  '沟通主题',
  '跟进内容',
  '评价标题',
  '活动名称',
  '会议议题',
  '课程名称',
  '标题',
] as const;

function noteRecordTitle(f: Record<string, unknown>, fallback: string): string {
  for (const k of RECORD_TITLE_FIELDS) {
    const v = toText(f[k]);
    if (v) return v;
  }
  return fallback;
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
  /**
   * 笔记状态（`有效` / `归档`）—— **ACMS 侧的业务标记，不来自上游**。
   *
   * 列表接口逐行补（`attachNoteStatus`）；没有状态行（历史笔记）或值未知时补 `有效`。
   * 前端据它渲染标题旁的「已归档」标记、决定「归档 / 激活」按钮显示哪一个，
   * 并在「来源 / 配置名称」那条客户端内存筛选分支里做状态过滤。
   */
  _status?: string;
  /** 归档时间（毫秒）／归档人 —— 只有归档过的笔记才有，行上悬停可看是谁在什么时候归档的 */
  _archivedAt?: number;
  _archivedBy?: string;
  /**
   * 已落库的原始音频元信息。**详情与列表都返回**（列表由 `attachAudioMeta` 批量补）。
   *
   * 列表也要的原因：列表页「操作」列要直接给一个播放 / 停止按钮，
   * 每行为此再打一次详情接口代价太大（一页 20 行 = 20 次上游调用，上游 QPS 只有 2）。
   * 没有音频的行不带这个字段，前端据此不渲染按钮。
   */
  _audio?: {
    token: string;
    name: string;
    size: number;
    type: string;
    durationMs: number;
  } | null;
  /**
   * 「这条笔记**有录音、但音频还没抓下来**」（未抓 / 上次失败）—— 2026-09-22 新增。
   *
   * 为什么要显式标出来：抓取原先只有界面上的按钮，**缺了没有任何提示** ——
   * 这类笔记在列表里跟纯文本笔记长得一模一样（都没有播放按钮），
   * 只能靠人工全库体检才发现（09-19 之后攒了 8 条，是峰哥报障才捞出来的）。
   * 前端据此显示「待抓取」标记，缺口自己就看得见。
   */
  _audioPending?: boolean;
}

export interface GetnoteListResult {
  notes: GetnoteNote[];
  has_more?: boolean;
  cursor?: string;
  total?: number;
  /**
   * 被当前「状态」筛选挡掉的条数（筛选=有效 时即「已归档」的条数）。
   *
   * 用途：列表顶部那条「已隐藏 N 条已归档笔记」的提示 —— 没有它，管理员归档完
   * 会以为笔记丢了（默认视图只看有效）。**只有服务端知道这个数**：前端拿到的
   * 已经是筛过的结果，靠减法永远算不出来。
   */
  archivedHidden?: number;
}

/** 笔记的归属方（谁的知识库配置拉到的它）—— 详情落库与凭证解析共用。 */
export interface SourceOwner {
  name: string;
  sourceName: string;
  ownerOpenId: string;
  /** 来源配置的 recordId；只有「管理员用自己的 Key」这条路为空 */
  recordId?: string;
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

/**
 * 「保存原始音频」的进度（放内存，进程重启即丢；任务本身按笔记幂等可重跑）。
 *
 * 与 `RefetchBodiesProgress` 分开计数，因为语义不同：
 * `stored` = 真下载并落盘了音频；`skipped` = 这条笔记上游**本来就没有音频**（纯文本笔记等），
 * 后者会写进 `音频状态='上游无音频'`，下次批量直接跳过 —— 不算失败。
 */
export interface RefetchAudioProgress {
  running: boolean;
  total: number;
  done: number;
  /** 下载成功并写入附件 */
  stored: number;
  /** 上游无音频（已标记，后续跳过） */
  skipped: number;
  /** 失败（下载 4xx、落盘失败等），下次可重试 */
  failed: number;
  /**
   * 选不到凭证 ⇒ 跳过（**不猜**）。
   *
   * 只在「该笔记没登记来源配置」时出现：手动触发时有兜底（触发者自己的凭证），
   * 定时任务没有触发者 ⇒ 只能用登记好的来源配置，选不到就留痕跳过（2026-09-22）。
   */
  noCred?: number;
  /** 谁触发的：手动按钮 / 每日定时任务 */
  trigger?: 'manual' | 'cron';
  /** 已落盘的字节数（让人看得出进度与磁盘影响） */
  bytes: number;
  lastNoteId?: string;
  /** 最近一次失败的**原因**（如 `权限不足` / `下载音频 HTTP 403`），排查时不用翻日志 */
  lastError?: string;
  /** 最近的失败样本（最多 5 条），便于一次看清是哪个人的哪个源在失败 */
  failedSamples?: Array<{ noteId: string; title: string; reason: string }>;
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
export class GetnoteService implements OnModuleInit {
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
    // 音频落库用：把下载到的字节流写进统一附件目录，拿 `loc_*` token
    private readonly fileUpload: FileUploadService,
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

    // 可见的知识库配置（关联用户含我 或 归属人是我）——与列表同一判据，见 myVisibleSourceCreds
    const visible = await this.myVisibleSourceCreds(user);
    if (visible[0]?.cred) return visible[0].cred;

    throw new HttpException(
      { code: 'GETNOTE_CREDENTIAL_MISSING', message: '尚未连接得到大脑账号' },
      HttpStatus.PRECONDITION_FAILED,
    );
  }

  /**
   * 我**可见**、且带有效凭证的启用配置。
   *
   * 🔴 判据必须与列表同源（`sourceVisibleTo` = 「关联用户含我」**或**「归属人ID === 我」）。
   *    2026-09-21 踩到：凭证状态与 `credFor` 原先只认 `ownerOpenId === 我`
   *    （`userSourceCred`），而列表认两样 ⇒ 出现「**能被关联到配置、列表本来读得到，
   *    却在向导页被要求自己去配凭证**」——赵光宇｜Michael 的「Michael Get Note」配置
   *    归属人是孙旭峰、只把他列在「关联用户」里，于是他一进「我的笔记」就卡住。
   *    两条判据不一致，症状必然是「有人能看、有人被拦」。
   */
  private async myVisibleSourceCreds(
    user: SessionUser,
  ): Promise<Array<SourceCredEntry & { cred: { key: string; clientId: string } }>> {
    const entries = await listEnabledSourceCreds(this.base, TABLES.getnoteSource.tableId, {
      maxPages: 5,
    });
    const myId = await resolveUserIdByOpenId(this.base, USER_TABLE.tableId, user.openId ?? '');
    // 类型收窄写在断言里：只留下「可见且凭证解得出」的条目，调用方不必再判 null
    return entries.filter(
      (e): e is SourceCredEntry & { cred: { key: string; clientId: string } } =>
        Boolean(e.cred) && sourceVisibleTo(e, user, myId),
    );
  }

  /**
   * 这篇笔记该用哪套可见配置（非管理员）。
   *
   * 只有一份可见配置时直接用（绝大多数情况）；有多份才去查「笔记归属映射」
   * （记录 id = 笔记 ID，主键直取，不打上游）。
   *
   * 🔴 返回**整条配置 entry**，而不只是 `cred`（2026-09-22 改）。
   *    调用方 `detail()` 还要拿它把「来源配置 / 来源配置ID / 归属人 / 归属人ID」
   *    写进正文表：原先只回 cred ⇒ 非管理员落正文时 `owner` 恒为 null ⇒
   *    `fetchNoteDetail` 的 `_sourceName/_sourceRecordId` 一个都不写 ⇒
   *    管理员代抓音频时 `pickSourceEntry` 匹配不上 ⇒ 回落成管理员自己的凭证 ⇒
   *    上游一律 `10008 权限不足`（2026-09-22「我的笔记」8 条缺音频就是这个链条）。
   */
  private async visibleEntryForNote(
    user: SessionUser,
    noteId: string,
  ): Promise<(SourceCredEntry & { cred: { key: string; clientId: string } }) | null> {
    const visible = await this.myVisibleSourceCreds(user);
    const first = visible[0];
    if (!first) return null;
    if (visible.length === 1) return first;
    try {
      const sql = getSqlStore();
      const rec = sql ? await sql.get(TABLES.noteConfigMap.tableId, String(noteId)) : null;
      const cfgId = String((rec?.fields as Record<string, unknown> | undefined)?.['配置ID'] ?? '').trim();
      const hit = cfgId ? visible.find((e) => e.recordId === cfgId) : undefined;
      return hit ?? first;
    } catch (e) {
      this.logger.warn(`查笔记归属失败（回退第一份可见配置）：${(e as Error).message.slice(0, 80)}`);
      return first;
    }
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
    /**
     * 回退：**能被关联到某条知识库配置**时也算已连接。
     *
     * 🔴 判据必须与「我的笔记」列表同源（`sourceVisibleTo`），不能只认「归属人是我」：
     *    2026-09-21 赵光宇｜Michael 报「配置好了 Michael Get Note，登录后还是让我配」——
     *    那条配置的**归属人是孙旭峰**、只把他列在「关联用户」里；列表路径本来读得到，
     *    却因为这里判据更严而卡在向导页。两条判据不一致 = 必然有人被拦。
     */
    const visible = await this.myVisibleSourceCreds(user);
    const hit = visible[0];
    return {
      configured: Boolean(hit?.cred),
      masked: hit?.cred ? mask(hit.cred.key) : '',
      clientIdMasked: hit?.cred ? mask(hit.cred.clientId) : '',
      updatedAt: '',
      verifiedAt: '',
      source: '',
      oauthEnabled: Boolean(OAUTH_CLIENT_ID()),
      // 让前端能说清「用哪条配置接入的」，而不是让人以为「没配也能用」是巧合
      ...(hit ? { viaSource: hit.sourceName, viaSourceCount: visible.length } : {}),
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
  /** 「保存原始音频」任务的进度（与正文收取分开，可同时跑） */
  private readonly audioJobs = new Map<string, RefetchAudioProgress>();
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
    /** 状态映射（noteId → 状态），由 `list()` 读一次贯穿整条链路 —— 别在这里再读一次库 */
    statusMap: Map<string, { status: string; archivedAt: number; archivedBy: string }> = new Map(),
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
    const poolByOthers = keyword
      ? filteredPool.filter(
          (n) =>
            String(n.title ?? '').toLowerCase().includes(keyword) ||
            String(n.content ?? '').toLowerCase().includes(keyword),
        )
      : filteredPool;

    // 状态筛选单独一步（`splitByStatus`）：前缀筛选都过完之后再按状态切一刀，
    // 顺带算出「被状态挡掉多少条」给列表顶部的提示用。
    const { kept: pool, hidden } = this.splitByStatus(poolByOthers, filters.status, statusMap);

    return this.slicePool(pool, cursor, size, hidden);
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
    /**
     * 状态映射**先读一次**，然后贯穿「筛选 → 统计被挡掉几条 → 切片 → 逐行标注」。
     *
     * 为什么必须在最前面读：状态筛选要在切片之前做（否则 total / hasMore 都按未筛选的池子算），
     * 而筛选时要判的是整个池子 —— 所以只能在这里读一次全表（表很小，见 loadNoteStatusMap）。
     */
    const statusMap = await this.loadNoteStatusMap();
    const res = await this.listNotes(user, cursor, q, size, filters, statusMap);
    // 列表行补 `_audio`：列表页操作列要直接给「播放 / 停止」按钮。
    // 放这里统一做，三条返回路径（管理员快照 / 按可见配置收窄 / 上游直查）都能覆盖到。
    // 同时补 `_status`：前端据此画「已归档」标记、决定「归档 / 激活」按钮显示哪一个。
    const withAudio = await this.attachAudioMeta(res.notes ?? []);
    return { ...res, notes: await this.attachNoteStatus(withAudio, statusMap) };
  }

  /** 笔记状态（没有状态行 ⇒ 有效）。筛选与标注共用同一份判据，避免两处口径漂移。 */
  private statusOfNote(
    n: GetnoteNote,
    map: Map<string, { status: string; archivedAt: number; archivedBy: string }>,
  ): string {
    return map.get(String(n.note_id ?? n.id ?? '').trim())?.status ?? NOTE_STATUS_ACTIVE;
  }

  /**
   * 按状态切一刀，并**成对返回**「留下的」与「被挡掉的条数」。
   *
   * 成对返回的理由：列表顶部要显示「已隐藏 N 条已归档笔记」，而这个 N 只能在
   * 「其它筛选都过完、状态这一刀还没切」的那一刻算出来；拆成两次调用就必然有人写歪。
   *
   * ⚠️ 判据用 contracts 的 `noteStatusMatches`：**历史笔记没有状态行，也必须是「有效」**。
   *    这里若写成 `status === NOTE_STATUS_ACTIVE`，历史笔记会被全部挡掉
   *    —— 界面症状是「筛了『有效』一条都不剩」。
   */
  private splitByStatus(
    items: GetnoteNote[],
    want: string | undefined,
    map: Map<string, { status: string; archivedAt: number; archivedBy: string }>,
  ): { kept: GetnoteNote[]; hidden: number } {
    if (!want || want === NOTE_STATUS_ALL) return { kept: items, hidden: 0 };
    const kept = items.filter((n) => noteStatusMatches(this.statusOfNote(n, map), want));
    // hidden 只数**归档**的（`hiddenArchivedCount`，与前端同一份）——
    // 「挡掉的条数」在「归档」视图下是**有效**笔记的条数，拿它去填
    // 「已隐藏 N 条已归档笔记」就是数字对、话错（2026-09-21 自查发现）。
    return { kept, hidden: hiddenArchivedCount(items.map((n) => this.statusOfNote(n, map)), want) };
  }

  /**
   * 内存分页（管理员快照与「按可见配置收窄」两条路径共用）。
   *
   * ⚠️ 快照过期后翻页的处理：快照过期时会**重新拉取**一次，重建出来的列表可能已经变了
   * （有人新增/删除笔记）。这时还拿着上一次的 `snap:<offset>` 去切片，offset 可能越过
   * 新列表末尾 → 返回空数组，用户看到「明明有数据却是空的」且不知道该刷新。
   * 所以越界（且列表非空）时回退到第一页，宁可让他觉得「跳回开头」也好过白屏。
   */
  private slicePool(
    pool: GetnoteNote[],
    cursor: string,
    size: number,
    archivedHidden = 0,
  ): GetnoteListResult {
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
      ...(archivedHidden > 0 ? { archivedHidden } : {}),
    };
  }

  /**
   * 给列表行批量补 `_audio` 标记。
   *
   * 数据源是**正文表**（`音频附件` / `音频时长`），不是上游 —— 只查本地主键，
   * 一页 20 行就是 20 次 `SELECT ... WHERE id=$1`，不消耗上游额度、不受 QPS 2 限制。
   * 逐条查而不是 `search` 全表：正文表带整篇总结（几千字），全表扫描的传输量
   * 比 20 次主键查询大两个数量级。
   *
   * 查不到 / 出错一律视为「这条没有音频」，**不让它影响列表主流程**。
   */
  private async attachAudioMeta(notes: GetnoteNote[]): Promise<GetnoteNote[]> {
    if (!notes.length) return notes;
    if (!getSqlStore()) return notes;
    /**
     * ⚠️ 用 `noteAudioFlags` 而不是 `noteAudioMeta`：一次查询同时拿「有没有音频」
     * 和「是不是等着抓」。后者正是「列表里看不出缺了什么」的解药（2026-09-22）。
     */
    const flags = await Promise.all(
      notes.map((n) => {
        const id = String(n.note_id ?? '').trim();
        if (!id) return Promise.resolve(null);
        return this.noteAudioFlags(id).catch(() => null);
      }),
    );
    return notes.map((n, i) => {
      const f = flags[i];
      if (!f || (!f.meta && !f.pending)) return n;
      return Object.assign({}, n, {
        ...(f.meta ? { _audio: f.meta } : {}),
        ...(f.pending ? { _audioPending: true } : {}),
      });
    });
  }

  private async listNotes(
    user: SessionUser,
    cursor?: string,
    q?: string,
    size = 20,
    filters: NoteListFilters = {},
    statusMap: Map<string, { status: string; archivedAt: number; archivedBy: string }> = new Map(),
  ): Promise<GetnoteListResult> {
    // 管理员：跨所有启用配置聚合（走快照分页，不用上游 cursor）
    if (this.isAdmin(user))
      return this.listAllForAdmin(user, cursor ?? '', q ?? '', size, filters, statusMap);

    // 非管理员：**被关联到知识库配置时**，只看到这些配置的笔记 —— 与管理员同一条
    // 数据来源（每条配置用自己的凭证去拉），只是配置集合被收窄到「我能看到的那几条」。
    // 一条都没被关联的，回落到「只用自己的凭证」的旧行为。
    const scoped = await this.linkedSourceIds(user);
    if (scoped.length)
      return this.listScopedBySources(user, scoped, cursor ?? '', q ?? '', size, filters, statusMap);

    /**
     * 只剩「个人凭证」这一路（既不是管理员、也没被关联任何配置）。
     *
     * ⚠️ 2026-09-21 修：带着结构化筛选时**改走内存聚合分页**。
     *    原先这条路是直接翻上游游标（`/resource/note/list`），而**上游不认这些筛选参数**
     *    —— 于是四个筛选（来源/配置名称/归属人/标签）在这条路上是**静默失效**的
     *    （页面上点了没反应，还不报错）。状态是新加的第五个筛选，不能一上线就继承这个毛病：
     *    「默认只看有效」在这种账号上会变成「什么都不筛」，归档的笔记照样列出来。
     *
     *    不带任何筛选时仍然走上游游标（省一次全量拉取）—— 这条路的账号笔记量通常很小，
     *    而带上筛选本来就得先有全量数据才筛得了。
     */
    const key = q?.trim();
    const hasFilter = Boolean(
      filters.source || filters.configName || filters.owner || filters.tag || filters.status,
    );
    if (hasFilter && !key) {
      // `collectAllNotes(user, [])`：白名单为空数组 ⇒ 只聚合「本人凭证」那一路
      // （空数组是**真值**，所以配置源全被跳过；本人凭证那一路不受白名单影响）
      const mine = await this.collectAllNotes(user, []);
      const poolByOthers = this.applyNoteFilters(mine, filters);
      const { kept: pool, hidden } = this.splitByStatus(poolByOthers, filters.status, statusMap);
      return this.slicePool(pool, cursor ?? '', size, hidden);
    }

    // 非管理员只用自己的 Key 直接翻上游游标，size 由上游决定（这里用不到）
    void size;
    const cred = await this.credFor(user);
    if (key) {
      const items = await this.recall(user, key, 10);
      const mapped = items.map((r) => ({
        note_id: r.note_id,
        title: r.title,
        content: r.content,
        note_type: r.note_type,
        created_at: r.created_at,
      }));
      // 语义检索结果同样按状态切一刀：默认视图只看有效，检索不该成为「归档笔记的后门」
      //（管理员那条路的关键字检索已经过同一刀，这里对齐）
      const { kept, hidden } = this.splitByStatus(mapped, filters.status, statusMap);
      return {
        notes: kept,
        has_more: false,
        cursor: undefined,
        total: kept.length,
        ...(hidden > 0 ? { archivedHidden: hidden } : {}),
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
    statusMap: Map<string, { status: string; archivedAt: number; archivedBy: string }> = new Map(),
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
    const poolByOthers = keyword
      ? scopedPool.filter(
          (n) =>
            String(n.title ?? '').toLowerCase().includes(keyword) ||
            String(n.content ?? '').toLowerCase().includes(keyword),
        )
      : scopedPool;

    // 状态最后一刀（与管理员路径同一套函数，口径不许分叉）
    const { kept: pool, hidden } = this.splitByStatus(poolByOthers, filters.status, statusMap);
    return this.slicePool(pool, cursor, size, hidden);
  }

  /**
   * 笔记详情。⚠️ 数据在 data.note 下，不是 data 直接取。
   *
   * 管理员分支：先用列表快照里记下的 `_sourceRecordId` 反查出**那条配置自己的凭证**，
   * 再去拉详情 —— 否则管理员点开别人的笔记必然失败（自己的 Key 下没有那条笔记）。
   */
  async detail(user: SessionUser, id: string, imageQuality?: string): Promise<GetnoteNote> {
    let cred = await this.credFor(user);
    let owner: SourceOwner | null = null;

    if (this.isAdmin(user)) {
      const found = await this.adminCredForNote(user, id);
      if (found) {
        cred = found.cred;
        owner = {
          name: found.ownerName,
          sourceName: found.sourceName,
          ownerOpenId: found.ownerOpenId,
          recordId: found.recordId,
        };
      }
    } else {
      /**
       * 非管理员：优先用**这篇笔记所属的那条可见配置**的凭证。
       *
       * 为什么不能一律用 `credFor`（= 自己那份凭证 / 第一份可见配置）：
       * 被关联到别人建的配置时（2026-09-21 赵光宇｜Michael 的「Michael Get Note」
       * 归属人是孙旭峰），笔记是用**那条配置的 Key** 拉来的，用别的 Key 拉详情必然查不到。
       *
       * 🔴 命中的**整条配置**还要带下去当 owner（2026-09-22 修）：`fetchNoteDetail`
       *    只在 owner 非空时才写 `_sourceName/_sourceRecordId/_owner/_ownerOpenId`，
       *    而这两组字段正是后续「管理员代抓音频」选凭证的唯一依据
       *    （`pickSourceEntry`）。原先这里只取 cred ⇒ 普通用户看过的笔记落库后
       *    来源配置恒为空 ⇒ 代抓必失败 ⇒ 只能人工逐条补，且「我的笔记」里的
       *    来源/配置名/归属人三个筛选对这批笔记静默失效。
       */
      const hit = await this.visibleEntryForNote(user, id);
      if (hit) {
        cred = hit.cred;
        owner = {
          name: hit.ownerName,
          sourceName: hit.sourceName,
          ownerOpenId: hit.ownerOpenId,
          recordId: hit.recordId,
        };
      }
    }

    const full = await this.fetchNoteDetail(cred, id, imageQuality, owner);
    // 顺手落一份正文（fire-and-forget）：**不额外消耗上游额度**，就是把这次已经拉到的正文存下来。
    // 这样「看过一遍」的笔记下次就能从本地读，也让「重新收取」不必从头抓。
    // 失败只记日志 —— 正文落库绝不能影响「打开一篇笔记」这个主流程。
    void this.persistNoteBody(full);

    // 附上「音频是否已落库」的标记：前端据此决定要不要渲染播放器。
    // 真正播放走 `/getnote/notes/:id/audio`，那个接口会再做一次笔记级可见性校验。
    // ⚠️ 变量名不能叫 `audio` —— 上面已有 `const audio = note.audio`（上游的逐字稿对象）。
    // 同时给「有录音但还没抓下来」的行打标记（2026-09-22）：详情里也让人一眼看出缺没缺。
    const audioFlags = await this.noteAudioFlags(id).catch(() => ({ meta: null, pending: false }));
    return Object.assign(full, {
      _audio: audioFlags.meta,
      ...(audioFlags.pending ? { _audioPending: true } : {}),
    });
  }

  /**
   * 用**指定凭证**拉一篇笔记详情，组装成统一的 note 对象。
   *
   * 为什么要单抽一层：「保存原始音频」要在一个循环里逐条打详情，
   * 而 `detail()` 的凭证解析依赖 `adminCredForNote()` —— 它的首选依据是
   * **内存里的列表快照**（`adminSnapshots`）。批量任务不会先打开列表页，
   * 快照是空的 ⇒ 静默回退成管理员自己的凭证 ⇒ 别人的笔记一律被上游判
   * `10008 权限不足`（2026-09-18 试点 5 条里错 4 条，全是别人的笔记）。
   * ⇒ 批量场景必须由调用方**自己把凭证解析好**再传进来。
   */
  private async fetchNoteDetail(
    cred: { key: string; clientId: string },
    id: string,
    imageQuality?: string,
    owner?: SourceOwner | null,
  ): Promise<GetnoteNote> {
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
    return {
      ...note,
      rawRecord,
      ...(owner
        ? {
            _owner: owner.name,
            _ownerOpenId: owner.ownerOpenId,
            _sourceName: owner.sourceName,
            // 🔴 这里必须带上 recordId，它是正文表 / 快照表「来源配置ID」的唯一来源。
            //    原来漏了这一项 ⇒ 正文表 568 行的「来源配置ID」**全为空**，
            //    而凭证解析又要靠它（形成死结：没 ID 就选不到凭证，选不到凭证就补不上 ID）。
            //    2026-09-18 修。
            ...(owner.recordId ? { _sourceRecordId: owner.recordId } : {}),
          }
        : {}),
    };
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
      // 🔴 先读旧行、把音频字段保住再整体替换 —— 下面用的是 `createWithId`
      //    （SQL 侧 `data = EXCLUDED.data`，**整体替换不是合并**），而本 payload 不含音频字段。
      //    漏掉这一步的后果：「打开一篇笔记」这条最热路径会顺手把已抓好的音频清空
      //    （2026-09-18 实测：全量抓完 533 条后点开十几篇验证，21 条音频被打回未抓取，
      //    表现为播放接口 404 AUDIO_NOT_FOUND）。规则见 `note-body-merge.ts`。
      const prev = await sql.get(TABLES.noteBody.tableId, id).catch(() => null);
      const payload = mergeNoteBodyPayload(
        (prev?.fields ?? {}) as Record<string, unknown>,
        {
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
        },
      );
      await sql.createWithId(TABLES.noteBody.tableId, id, payload);
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
    // FILE = 17（附件）：音频用附件字段承载，复用全站附件渲染与 `/files/:token` 下载链路
    const T = { TEXT: 1, NUMBER: 2, DATE: 5, FILE: 17 } as const;
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
      // ── 原始音频（2026-09-17 新增，方案 A：扩容后把音频落本地附件目录）──
      //
      // 为什么能落：详情接口的 `attachments[]` 里有 `{type:'audio', url, duration}`，
      // 那个 url 是得到 CDN 的**签名直链（约 5 天过期）**，所以只能「拉到就当场下载」，
      // 不能把链接存下来当长期引用 —— 这里存的是下载后的本地附件 token（`loc_*`，永不过期）。
      { name: '音频附件', type: T.FILE },
      // 毫秒（上游 attachments[].duration 就是这个单位）。
      // ⚠️ 别跟上面那个「录音时长」混了：那个字段历史抓取有误、几百条全是 0，本字段是新抓的准值。
      { name: '音频时长', type: T.NUMBER },
      // 未抓取 / 已保存 / 上游无音频 / 失败 —— 批量任务据此跳过已完成、只重试失败的。
      // 用 TEXT 而非单选：状态是**代码判据**（不是给人挑的选项），做成字典会有被改坏的风险。
      { name: '音频状态', type: T.TEXT },
      { name: '音频抓取时间', type: T.NUMBER },
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

  // ── 笔记状态（有效 / 归档）────────────────────────────────────────────
  //
  // ACMS 侧的业务标记：上游 note 对象没有可写的自定义字段，所以状态落在自建表
  // 「笔记状态表」（记录 id = 笔记 ID）。
  //
  // 🔴 三条口径（都在 `packages/contracts/src/getnote.ts`，前后端共用同一份）：
  //   1. **没有行 = 有效** ⇒ 历史笔记零回填；
  //   2. 只有明确「归档」才算归档，其余（空 / 未知）一律算有效；
  //   3. 状态筛选必须走 `noteStatusMatches()`，别在别处手写 `=== '有效'`。

  /**
   * 建「笔记状态表」：定义与字段元数据在 `note-status.schema.ts`（与启动期那份**同一份**，
   * 两处各写一套必然漂移）。这里只是懒建兜底 —— 启动建表失败 / 进程未重启时照样能用。
   */
  private async ensureNoteStatusTable(): Promise<void> {
    await ensureNoteStatusTable();
  }

  /**
   * 一次性读回**全部**状态行（笔记 ID → 状态）。
   *
   * 为什么整表读而不是按 id 逐个查：状态筛选必须在**切片之前**做（否则 total / hasMore
   * 都按未筛选的池子算，会出现「共 509 条却只翻得出几条」），而筛选时要判的是**整个池子**
   * （管理员池子 500+ 条）—— 逐 id 查就是 500 次往返。
   *
   * 代价可以接受：这张表**只会为「被归档过」的笔记生长**（没归档过的笔记没有行），
   * 现实量级是几条到几十条，一页（500）就拉完了。出错一律按「全部有效」处理，
   * 绝不能因为状态表出问题就把整个列表打空。
   */
  private async loadNoteStatusMap(): Promise<Map<string, { status: string; archivedAt: number; archivedBy: string }>> {
    const out = new Map<string, { status: string; archivedAt: number; archivedBy: string }>();
    const sql = getSqlStore();
    if (!sql) return out;
    try {
      await this.ensureNoteStatusTable();
      const tableId = TABLES.noteStatus.tableId;
      let token: string | undefined;
      for (let i = 0; i < 10; i += 1) {
        const page = await sql.search(tableId, { pageSize: 500, ...(token ? { pageToken: token } : {}) });
        for (const r of page.items ?? []) {
          // ⚠️ search 返回的 id 字段是 recordId（不是 id）；两者都取，避免恒空
          const rr = r as unknown as { recordId?: string; id?: string };
          const id = String(rr.recordId ?? rr.id ?? '').trim();
          if (!id) continue;
          out.set(id, {
            status: normalizeNoteStatus(r.fields?.['状态']),
            archivedAt: Number(r.fields?.['归档时间'] ?? 0) || 0,
            archivedBy: String(toText(r.fields?.['归档人']) ?? '').trim(),
          });
        }
        if (!page.hasMore || !page.pageToken) break;
        token = page.pageToken;
      }
    } catch (e) {
      this.logger.warn(`读取笔记状态失败（按「全部有效」继续）：${(e as Error).message.slice(0, 120)}`);
      return new Map();
    }
    return out;
  }

  /**
   * 给列表行批量补 `_status`（以及归档人/时间）。
   *
   * 放在 `list()` 里统一做，三条取数路径（管理员快照 / 按可见配置收窄 / 上游直查）都覆盖到
   * —— 与 `attachAudioMeta` 同一处收口。**不能只让详情接口返回状态**：那样列表既筛不了、
   * 也画不出「已归档」标记。
   */
  private async attachNoteStatus(
    notes: GetnoteNote[],
    statusMap?: Map<string, { status: string; archivedAt: number; archivedBy: string }>,
  ): Promise<GetnoteNote[]> {
    if (!notes.length) return notes;
    const map = statusMap ?? (await this.loadNoteStatusMap());
    return notes.map((n) => {
      const hit = map.get(String(n.note_id ?? n.id ?? '').trim());
      return {
        ...n,
        // 没有行 ⇒ 有效（历史笔记的兜底就在这里）
        _status: hit?.status ?? NOTE_STATUS_ACTIVE,
        ...(hit?.archivedAt ? { _archivedAt: hit.archivedAt } : {}),
        ...(hit?.archivedBy ? { _archivedBy: hit.archivedBy } : {}),
      };
    });
  }

  /**
   * 归档 / 激活一条笔记（**幂等**：重复点不出错，已是目标状态就原样返回）。
   *
   * 归档只写 ACMS 这张表 —— 不会动 Get笔记 里的笔记（上游是别人的数据，
   * 用户在手机 App 里看它跟原来一样）。所以「归档」的语义是**本系统内收起**，不是删除；
   * 真要删是 `DELETE /getnote/notes/:id`（进上游回收站），两者互不影响。
   */
  async setNoteStatus(
    user: SessionUser,
    noteId: string,
    status: string,
    title?: string,
  ): Promise<{ noteId: string; status: string; changed: boolean; archivedAt?: number; archivedBy?: string }> {
    const id = String(noteId ?? '').trim();
    if (!id) throw new HttpException('BAD_REQUEST:noteId required', HttpStatus.BAD_REQUEST);
    const want = normalizeNoteStatus(status);
    const sql = getSqlStore();
    if (!sql) throw new HttpException('DB_UNAVAILABLE', HttpStatus.SERVICE_UNAVAILABLE);
    await this.ensureNoteStatusTable();
    const tableId = TABLES.noteStatus.tableId;

    const readOne = async (): Promise<{ exists: boolean; status: string }> => {
      try {
        // 记录 id 就是笔记 ID ⇒ 直接主键取，不走 filter（关联/文本字段的等值 filter 不可靠）
        const rec = await sql.get(tableId, id);
        if (!rec) return { exists: false, status: NOTE_STATUS_ACTIVE };
        return { exists: true, status: normalizeNoteStatus((rec.fields ?? {})['状态']) };
      } catch {
        // 读失败按「没有状态行」处理（= 有效）：宁可多写一次，也不要因为读失败把状态判反
        return { exists: false, status: NOTE_STATUS_ACTIVE };
      }
    };

    const before = await readOne();
    // 幂等：已经是目标状态 ⇒ 不写库、不改时间戳（否则「归档时间」会被反复刷新）。
    // ⚠️ 「激活一条从没归档过的笔记」也走这里：**没有状态行 = 有效** ——
    //    这时若照样写一行，就会给每篇被误点的笔记留一条只有状态=有效的垃圾行。
    if ((!before.exists && want === NOTE_STATUS_ACTIVE) || (before.exists && before.status === want)) {
      const map = await this.loadNoteStatusMap();
      const hit = map.get(id);
      return { noteId: id, status: want, changed: false, archivedAt: hit?.archivedAt, archivedBy: hit?.archivedBy };
    }

    const now = Date.now();
    const fields: Record<string, unknown> = {
      笔记ID: id,
      标题: String(title ?? '').trim(),
      状态: want,
      ...(want === NOTE_STATUS_ARCHIVED
        ? { 归档时间: now, 归档人: user?.name ?? '', 归档人ID: user?.openId ?? '' }
        : { 激活时间: now, 激活人: user?.name ?? '' }),
    };
    // ⚠️ 写库必须分「首次 createWithId / 已有 update」：`createWithId` 是**整体替换**，
    //    对已存在的行用它会把上次的归档时间冲掉（激活后再归档，历史就没了）。
    if (before.exists) await sql.update(tableId, id, fields);
    else await sql.createWithId(tableId, id, fields);

    return {
      noteId: id,
      status: want,
      changed: true,
      ...(want === NOTE_STATUS_ARCHIVED ? { archivedAt: now, archivedBy: user?.name ?? '' } : {}),
    };
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

  // ── 原始音频落库（2026-09-17，方案 A）────────────────────────────────
  //
  // 背景：笔记详情接口的 `attachments[]` 里有 `{type:'audio', url, duration}`，
  // 但那个 url 是得到 CDN 的**签名直链、约 5 天过期** ⇒ 想把音频长期留在 ACMS，
  // 只能「拉到就当场下载」。这里把字节流写进全站附件目录（拿 `loc_*` token，永不过期），
  // 并在正文表记录状态。
  //
  // 为什么异步 + 进度轮询：上游 QPS 2、每条 0.6s，几百条要几分钟，
  // 同步等会被 nginx 掐成 504（与「重新收取正文」同一个理由）。
  // 幂等：按 `音频状态` 跳过已保存与「上游无音频」，可随时中断重跑。

  /** 启动「保存原始音频」。已保存 / 已知无音频的会跳过；`limit` 用于先小批量试点。 */
  async startRefetchAudio(
    user: SessionUser,
    opts: { limit?: number } = {},
  ): Promise<RefetchAudioProgress> {
    // 🔴 必须限管理员，不能只看前端藏了按钮 —— 接口是能直连的。
    //    这个任务的候选集是**整张正文表**（不过行人级范围），且会用**别人的配置凭证**
    //    去打上游 —— 普通用户触发等于借服务端之手把全所录音拉进库、还占用磁盘。
    //    （播放侧另有一道 `noteAudio()` 的可见性校验，但那管不住「下载」这一步。）
    if (!this.isAdmin(user)) {
      throw new HttpException('仅系统管理员可执行该操作', HttpStatus.FORBIDDEN);
    }
    const key = `audio:${user.openId}`;
    const cur = this.audioJobs.get(key);
    if (cur?.running) return cur;
    const job: RefetchAudioProgress = {
      running: true,
      total: 0,
      done: 0,
      stored: 0,
      skipped: 0,
      failed: 0,
      bytes: 0,
      trigger: 'manual',
      startedAt: Date.now(),
    };
    this.audioJobs.set(key, job);
    void this.runRefetchAudio(user, opts, job).catch((e) => {
      job.running = false;
      job.error = (e as Error).message.slice(0, 200);
    });
    return job;
  }

  /**
   * 每日定时抓取新笔记的原始音频（2026-09-22 新增，峰哥确认）。
   *
   * ── 为什么必须有它 ────────────────────────────────────────────────
   * 音频抓取原先**只有界面上那个按钮**。2026-09-18 全量抓过一轮（564 条）之后连着
   * 4 天没人再点，于是 09-19 之后同步进来的 8 条笔记一直没音频 ——
   * 界面上连播放按钮都不出现，而**没有任何地方会告诉你缺了**，
   * 最后是峰哥报「还是有记录没法播放」才被翻出来。
   *
   * 与手动入口共用同一套执行逻辑（`runRefetchAudio`），差别只有一个：
   * 定时任务没有「触发者」⇒ 没有兜底凭证 ⇒ 选不到来源配置的笔记**跳过并留痕**，
   * 绝不用别人的凭证去猜（猜错只会换来一串「权限不足」，还看不到真正缺的是什么）。
   */
  async runScheduledAudioRefetch(): Promise<RefetchAudioProgress> {
    const key = 'audio:__cron__';
    const cur = this.audioJobs.get(key);
    if (cur?.running) return cur;
    const job: RefetchAudioProgress = {
      running: true,
      total: 0,
      done: 0,
      stored: 0,
      skipped: 0,
      failed: 0,
      bytes: 0,
      noCred: 0,
      trigger: 'cron',
      startedAt: Date.now(),
    };
    this.audioJobs.set(key, job);
    this.logger.log('每日音频抓取开始');
    void this.runRefetchAudio(null, {}, job)
      .then(() =>
        this.logger.log(
          `每日音频抓取完成：候选 ${job.total}，成功 ${job.stored}，无音频 ${job.skipped}，` +
            `失败 ${job.failed}，选不到凭证 ${job.noCred ?? 0}，共 ${(job.bytes / 1048576).toFixed(1)} MB`,
        ),
      )
      .catch((e) => {
        job.running = false;
        job.error = (e as Error).message.slice(0, 200);
        this.logger.warn(`每日音频抓取异常：${job.error}`);
      });
    return job;
  }

  /**
   * 北京时间的「今天是哪天 + 现在几点几分」。
   *
   * 显式指定 `Asia/Shanghai`，**不依赖服务器时区** —— 服务器若是 UTC，
   * `new Date().getHours()` 算出来的「06:30」实际是北京时间 14:30。
   */
  private static beijingClock(): { day: string; minutes: number } {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date());
    const pick = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    return {
      day: `${pick('year')}-${pick('month')}-${pick('day')}`,
      minutes: Number(pick('hour')) * 60 + Number(pick('minute')),
    };
  }

  /**
   * 起「每日 06:30 抓音频」的定时器。
   *
   * 🔴 为什么不是 `setInterval(24h)` 一把梭（项目里 `weiling.service` 是那么写的）：
   *    蓝绿部署**每次都会重启进程**，24 小时计时随之清零 —— 部署一勤，这个定时
   *    可能**永远等不到那一刻**（09-18 之后攒出 8 条缺口的同期，正好每天在部署）。
   *    ⇒ 改成「每小时醒一次，看今天到点没到点、跑没跑过」：
   *      判据是**日期 + 时刻**，与进程活了多久无关。部署再频繁也不会漏。
   *    进程重启只丢「今天跑过没」这个内存标记 ⇒ 最坏是多跑一次，
   *    而任务本身按 `音频状态` 幂等（第二次全是「已保存 ⇒ 跳过」）。
   */
  private startAudioCron(): void {
    if (String(process.env.GETNOTE_AUDIO_CRON ?? '').trim().toLowerCase() === 'off') {
      this.logger.log('GETNOTE_AUDIO_CRON=off，跳过每日音频抓取定时器');
      return;
    }
    const tick = () => {
      const { day, minutes } = GetnoteService.beijingClock();
      if (this.audioCronDay === day) return; // 今天已经跑过
      if (minutes < 6 * 60 + 30) return; // 还没到 06:30
      this.audioCronDay = day;
      void this.runScheduledAudioRefetch();
    };
    // 启动后 3 分钟先查一次（让其它模块就绪；也覆盖「今天该跑但进程是刚起来的」），之后每小时一次
    setTimeout(tick, 3 * 60 * 1000).unref?.();
    setInterval(tick, 60 * 60 * 1000).unref?.();
  }

  /** 「今天已跑过」的日期（北京时间 `YYYY-MM-DD`），进程内即可 —— 见 `startAudioCron` 的说明 */
  private audioCronDay = '';

  async onModuleInit(): Promise<void> {
    this.startAudioCron();
  }

  async refetchAudioStatus(user: SessionUser): Promise<RefetchAudioProgress> {
    return (
      this.audioJobs.get(`audio:${user.openId}`) ?? {
        running: false,
        total: 0,
        done: 0,
        stored: 0,
        skipped: 0,
        failed: 0,
        bytes: 0,
      }
    );
  }

  private async runRefetchAudio(
    /**
     * 触发者。**允许为 null** —— 每日定时任务没有「某个人」在触发（2026-09-22 加）。
     * 为 null 时没有兜底凭证：选不到来源配置的笔记**跳过并留痕**，绝不拿别人的凭证去猜。
     */
    user: SessionUser | null,
    opts: { limit?: number },
    job: RefetchAudioProgress,
  ): Promise<void> {
    await this.ensureNoteBodyTable();

    // ① 候选 = 正文表里「还没保存过音频、且看起来有音频」的笔记。
    //    顺手把「这篇该用谁的凭证」和标题一起记下 —— 下一段要用来解析凭证，
    //    以及失败时能打印出人看得懂的名字（而不是一串 note_id）。
    const pending: Array<{ id: string; title: string; srcId: string; srcName: string }> = [];
    let pageToken: string | undefined;
    for (let i = 0; i < 30; i++) {
      const res = await this.base.search(TABLES.noteBody.tableId, { pageSize: 500, pageToken });
      for (const r of res.items ?? []) {
        const f = (r.fields ?? {}) as Record<string, unknown>;
        const state = String(f['音频状态'] ?? '').trim();
        if (state === AUDIO_STATE_SAVED || state === AUDIO_STATE_NONE) continue;
        // 有附件的才可能有音频；纯文本笔记直接跳过（省上游额度）
        const hint = Number(f['附件数'] ?? 0) > 0 || String(f['录音卡SN'] ?? '').trim() !== '';
        if (!hint) continue;
        const id = String(f['笔记ID'] ?? '').trim() || String(r.recordId ?? '');
        if (!id) continue;
        pending.push({
          id,
          title: String(f['标题'] ?? '').slice(0, 40),
          srcId: String(f['来源配置ID'] ?? '').trim(),
          srcName: String(f['来源配置'] ?? '').trim(),
        });
      }
      if (!res.hasMore || !res.pageToken) break;
      pageToken = res.pageToken;
    }
    if (opts.limit && opts.limit > 0) pending.length = Math.min(pending.length, opts.limit);
    job.total = pending.length;
    if (!pending.length) {
      job.running = false;
      job.finishedAt = Date.now();
      return;
    }

    // ② 凭证解析 —— 批量任务必须**自己**解析，不能交给 `detail()`：
    //    后者靠内存里的列表快照（`adminSnapshots`）判断该用谁的 Key，而批量任务
    //    不会先打开列表页 ⇒ 快照为空 ⇒ 静默回退成管理员自己的凭证 ⇒
    //    别人的笔记全部被上游判 `10008 权限不足`（2026-09-18 试点 5 条错 4 条，
    //    错的全是别人的笔记、对的恰好是管理员自己的）。
    //    这里一次性读齐启用配置，用纯函数 `pickSourceEntry` 做两级匹配（可回归测试）。
    const entries = await listEnabledSourceCreds(this.base, TABLES.getnoteSource.tableId, {
      maxPages: 5,
    });
    // 兜底凭证 = 触发者自己的（手动按钮那条路）。定时任务没有触发者 ⇒ null。
    const myOwnCred = user ? await this.credFor(user).catch(() => null) : null;

    // ③ 逐条：拉详情拿直链 → 当场下载 → 落附件 → 写回状态
    for (const item of pending) {
      const hit = pickSourceEntry(entries, { sourceRecordId: item.srcId, sourceName: item.srcName });
      const cred = hit?.cred ?? myOwnCred;
      /**
       * 选不到凭证 ⇒ **跳过**，不猜（2026-09-22）。
       * 不猜的理由：拿错人的凭证打上游只会换来「权限不足」，而那条笔记的来源配置
       * 依旧空着 —— 既没修好、还把失败样本刷满。留痕交给上层（`job.noCred` + 日志），
       * 根因由「落正文时写全来源字段」解决（`detail()` 已修）。
       */
      if (!cred) {
        job.noCred = (job.noCred ?? 0) + 1;
        job.done += 1;
        this.logger.warn(`跳过音频抓取（选不到凭证，来源配置为空）：${item.title || item.id}`);
        continue;
      }
      const owner: SourceOwner | null = hit
        ? {
            name: hit.ownerName,
            sourceName: hit.sourceName,
            ownerOpenId: hit.ownerOpenId,
            recordId: hit.recordId,
          }
        : null;
      try {
        const r = await this.grabNoteAudio(cred, owner, item.id);
        if (r.kind === 'stored') {
          job.stored += 1;
          job.bytes += r.bytes;
        } else {
          job.skipped += 1;
        }
      } catch (e) {
        const reason = (e as Error).message.slice(0, 140);
        job.failed += 1;
        job.lastError = reason;
        job.failedSamples = [...(job.failedSamples ?? []), { noteId: item.id, title: item.title, reason }].slice(-5);
        await this.markAudioState(item.id, AUDIO_STATE_FAILED).catch(() => undefined);
        this.logger.warn(`保存音频失败 ${item.title || item.id}：${reason}`);
      }
      job.done += 1;
      job.lastNoteId = item.id;
      await new Promise((r) => setTimeout(r, 600));
    }
    job.running = false;
    job.finishedAt = Date.now();
    this.logger.log(
      `保存音频完成：共 ${job.total}，成功 ${job.stored}，无音频 ${job.skipped}，失败 ${job.failed}，共 ${(job.bytes / 1048576).toFixed(1)} MB`,
    );
  }

  /**
   * 单条：拉详情 → 下载音频 → 落附件目录 → 写回正文表。
   *
   * 🔴 顺序不能反：`persistNoteBody` 走的是 `createWithId`（SQL 侧 `data = EXCLUDED.data`，
   *   **整体替换**），会清掉音频字段；音频字段必须用 `sql.update`（`data || jsonb` 合并）
   *   在它**之后**写。顺带这也把正文表的「来源配置ID」补齐了。
   */
  private async grabNoteAudio(
    cred: { key: string; clientId: string },
    owner: SourceOwner | null,
    noteId: string,
  ): Promise<{ kind: 'stored'; bytes: number } | { kind: 'none' }> {
    const full = await this.fetchNoteDetail(cred, noteId, undefined, owner);
    // 先落正文（同时修正归属/来源配置ID），再写音频字段
    await this.persistNoteBody(full);

    const atts = (Array.isArray(full.attachments) ? full.attachments : []) as Array<{
      type?: string;
      url?: string;
      duration?: number;
    }>;
    const audio = atts.find((a) => String(a?.type ?? '') === 'audio' && String(a?.url ?? '').trim());
    if (!audio?.url) {
      await this.markAudioState(noteId, AUDIO_STATE_NONE);
      return { kind: 'none' };
    }

    const res = await fetch(audio.url);
    if (!res.ok) throw new Error(`下载音频 HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error('音频内容为空');

    // 🔴 容器以**文件头**为准，不能想当然写死 ogg：上游同一批录音里既有 Ogg/Opus
    //    也有 MP3（实测 554 个里 40 个是 MP3）。写死 MIME 的后果是那批文件带着
    //    错误名片入库，浏览器按 audio/ogg 解 MP3 直接播放失败（2026-09-18 报障）。
    const sniffed = sniffAudioFormat(buf);
    const mime = sniffed?.mime ?? 'audio/ogg';
    const name = `${noteId}.${sniffed?.ext ?? 'ogg'}`;
    const { file_token } = await this.fileUpload.uploadFile(buf, name, mime);

    const sql = getSqlStore();
    if (!sql) throw new Error('SQL 模式未启用');
    // ⚠️ 用 `update`（SQL 侧是 `data || jsonb` 合并）而**不是** createWithId ——
    //    后者是整体替换，会把总结 / 原始记录 / 标题全清空。
    await sql.update(TABLES.noteBody.tableId, noteId, {
      音频附件: [{ file_token, name, size: buf.length, type: mime }],
      音频时长: Number(audio.duration ?? 0) || 0,
      音频状态: AUDIO_STATE_SAVED,
      音频抓取时间: Date.now(),
    });
    return { kind: 'stored', bytes: buf.length };
  }

  /** 只改「音频状态」（失败 / 上游无音频时用） */
  private async markAudioState(noteId: string, state: string): Promise<void> {
    const sql = getSqlStore();
    if (!sql) return;
    await sql.update(TABLES.noteBody.tableId, noteId, {
      音频状态: state,
      音频抓取时间: Date.now(),
    });
  }

  /**
   * 读某篇笔记的音频状态：**一次主键查询**同时给出「已落库的元信息」与「是不是等着抓」。
   *
   * 为什么合成一次：两者读的是正文表**同一行**，拆成两次查询就是双倍主键查询
   * （列表一页 20 行 = 40 次，而正文表带整篇总结、单行不小）。
   *
   * ⚠️ **不做权限校验** —— 只给 `detail()` / `attachAudioMeta()` 打标记用
   * （列表与详情本身已过鉴权）。对外播放必须走 `noteAudio()`，那里才有可见性校验。
   */
  private async noteAudioFlags(noteId: string): Promise<{
    meta: {
      token: string;
      name: string;
      size: number;
      type: string;
      durationMs: number;
    } | null;
    pending: boolean;
  }> {
    const sql = getSqlStore();
    const none = { meta: null, pending: false };
    if (!sql) return none;
    const rec = await sql.get(TABLES.noteBody.tableId, noteId);
    if (!rec) return none;
    const f = (rec.fields ?? {}) as Record<string, unknown>;
    const arr = (Array.isArray(f['音频附件']) ? f['音频附件'] : []) as Array<{
      file_token?: string;
      name?: string;
      size?: number;
      type?: string;
    }>;
    const token = String(arr[0]?.file_token ?? '').trim();
    const state = String(f['音频状态'] ?? '').trim();
    /** 「有录音迹象」：上游返回过附件，或这条本来就是录音卡录的 */
    const looksRecorded =
      Number(f['附件数'] ?? 0) > 0 || String(f['录音卡SN'] ?? '').trim() !== '';
    /**
     * 待抓 = 有录音迹象、但音频没入库，且**不是**「上游本来就没音频」。
     * 后者再抓也是白跑（`音频状态='上游无音频'` 是已经确认过的结论）。
     */
    const pending = !token && looksRecorded && state !== AUDIO_STATE_NONE;
    return {
      meta: token
        ? {
            token,
            name: String(arr[0]?.name ?? `${noteId}.ogg`),
            // size / type 是「转出到业务记录」时构造附件对象要用的（附件字段的存储结构就是
            // `[{file_token,name,size,type}]`），列表行不再多余回查一次。
            size: Number(arr[0]?.size ?? 0) || 0,
            type: String(arr[0]?.type ?? 'audio/ogg'),
            durationMs: Number(f['音频时长'] ?? 0) || 0,
          }
        : null,
      pending,
    };
  }

  /**
   * 读某篇笔记已落库的音频元信息（只要元信息时用它，等价于 `noteAudioFlags().meta`）。
   *
   * ⚠️ **不做权限校验** —— 只给 `detail()` 用来给前端打「有没有音频」的标记
   * （详情本身已经过鉴权）。对外播放必须走 `noteAudio()`，那里才有可见性校验。
   */
  private async noteAudioMeta(noteId: string): Promise<{
    token: string;
    name: string;
    size: number;
    type: string;
    durationMs: number;
  } | null> {
    return (await this.noteAudioFlags(noteId)).meta;
  }

  /**
   * 取某篇笔记**已落库**的音频（供播放接口）。
   *
   * 🔴 这里带**可见性校验**：录音是私密内容，不能像普通附件那样「登录即可下载」。
   *   - 管理员：全可见
   *   - 普通用户：该笔记 `归属人ID` 必须等于本人，**或**落在我可见的知识库配置所属人名下
   *     （口径与笔记列表一致：能看这个配置 ⇒ 就能听它的录音）
   * 不合规一律返回 null，由调用方给 404（不泄露「存在但无权」）。
   */
  async noteAudio(
    user: SessionUser,
    noteId: string,
  ): Promise<{ token: string; name: string } | null> {
    const sql = getSqlStore();
    if (!sql) return null;
    const rec = await sql.get(TABLES.noteBody.tableId, noteId);
    if (!rec) return null;
    const f = (rec.fields ?? {}) as Record<string, unknown>;
    const arr = (Array.isArray(f['音频附件']) ? f['音频附件'] : []) as Array<{
      file_token?: string;
      name?: string;
    }>;
    const token = String(arr[0]?.file_token ?? '').trim();
    if (!token) return null;

    if (!this.isAdmin(user)) {
      const ownerId = String(f['归属人ID'] ?? '').trim();
      const myOpenId = String(user.openId ?? '').trim();
      let ok = ownerId !== '' && ownerId === myOpenId;
      if (!ok && ownerId) {
        const scoped = await this.linkedSourceIds(user);
        if (scoped.length) {
          const entries = await listEnabledSourceCreds(this.base, TABLES.getnoteSource.tableId, {
            maxPages: 5,
          });
          ok = entries.some((e) => scoped.includes(e.recordId) && e.ownerOpenId === ownerId);
        }
      }
      if (!ok) return null;
    }
    return { token, name: String(arr[0]?.name ?? `${noteId}.ogg`) };
  }

  /**
   * 找出某篇笔记该用哪套凭证打开（仅管理员）。
   *
   * 两级依据，顺序不能反：
   *   ① 内存里的列表快照（`adminSnapshots`）—— 管理员刚看过列表时最快，且带 tags；
   *   ② **正文表里落库的「来源配置ID」** —— 快照是易失的（进程重启 / 没打开过列表就没了），
   *      缺了它的后果很严重：会静默回退成管理员自己的凭证 ⇒ 别人的笔记被上游判
   *      `10008 权限不足`（2026-09-18 实测）。落库的 ID 是持久的，必须兜住。
   *
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
    recordId: string;
  } | null> {
    const snap = this.adminSnapshots.get(user.openId);
    const meta = snap?.items.find((n) => String(n.note_id ?? n.id ?? '') === String(noteId));
    let recordId = String(meta?._sourceRecordId ?? '').trim();

    // ② 快照缺失 ⇒ 退到持久化的正文表（这正是「来源配置ID」字段存在的意义）
    if (!recordId) recordId = await this.noteBodySourceRecordId(noteId);
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
      recordId,
    };
  }

  /** 读正文表某篇笔记的「来源配置ID」（持久化的凭证依据）。读不到一律返回空串。 */
  private async noteBodySourceRecordId(noteId: string): Promise<string> {
    const sql = getSqlStore();
    if (!sql) return '';
    try {
      const rec = await sql.get(TABLES.noteBody.tableId, noteId);
      const f = (rec?.fields ?? {}) as Record<string, unknown>;
      return String(f['来源配置ID'] ?? '').trim();
    } catch {
      return '';
    }
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

  // ── 学生维度聚合：把所有能连到这个学生的笔记一次捞出来 ──────────────────

  /**
   * 某个学生**所有路径**关联到的笔记（2026-09-22 新增）。
   *
   * ## 为什么需要它
   *
   * 学生详情页原来的 `NotePanel` 只查「实体类型 = 学生档案」，而生产实测这种关联 **0 条** ——
   * 真实笔记全挂在**学生记录**（19 条）和**招生跟进**（10 条）上 ⇒ 面板永远显示「暂无关联笔记」，
   * 而用户明明在记录详情页里绑过笔记。
   *
   * ## 取数顺序（先读小表、再逐条定点取，**不拉全表**）
   *
   *  ① 全量读「笔记关联」表 —— 生产目前 35 行，全读无压力；
   *  ② 「实体类型 = 学生档案 且 实体 ID = 该生」= **直接关联**，它是「这个学生本人的笔记」，排最前；
   *  ③ 其余按 `NOTE_ENTITY_TYPE_TO_PATH` 找到归属表，用 `base.get(表, 实体ID)` **逐条定点取**该记录
   *     —— 比「拉全表再内存筛」快一个量级，而且天然兼容历史里写歪的实体类型别名
   *     （`学生记录` / `IDP沟通` / `日常跟进` 指的是同一张表）；
   *  ④ 取回记录后按该表 meta 的 `studentMatch` 判归属（`by:'id'` 走关联字段、`by:'name'` 走姓名文本 ——
   *     招生跟进与三合一记录都是后者）；
   *  ⑤ 🔴 权限：来源模块没有 read 权限的**整块跳过并记入 `hiddenSources`** ——
   *     不跳的话会把「家校沟通」这类别的模块的笔记泄漏给没有权限的人；不记的话用户会以为
   *     这个学生真的只有这几篇。
   */
  async listLinksByStudent(user: SessionUser, studentId: string): Promise<StudentNoteLinksResult> {
    const stu = await this.base.get(TABLES.studentProfile.tableId, studentId);
    if (!stu) throw new HttpException('NOT_FOUND:studentProfile', HttpStatus.NOT_FOUND);
    const studentName = toText(stu.fields['学生姓名']) ?? '';
    const principal = toPrincipal(user);

    // ① 全量读「笔记关联」（小表）
    const rows: {
      entityType: string;
      entityId: string;
      noteId: string;
      title: string;
      linkedBy: string;
      linkedAt: string;
    }[] = [];
    {
      let tok: string | undefined;
      let guard = 0;
      do {
        const res = await this.base.search(TABLES.noteLink.tableId, { pageSize: 200, pageToken: tok });
        for (const r of res.items) {
          const noteId = toText(r.fields['笔记ID']) ?? '';
          if (!noteId) continue; // 关联表里的空行（历史脏数据）直接跳过
          rows.push({
            entityType: toText(r.fields['实体类型']) ?? '',
            entityId: toText(r.fields['实体ID']) ?? '',
            noteId,
            title: toText(r.fields['笔记标题']) ?? '',
            linkedBy: toText(r.fields['关联人']) ?? '',
            linkedAt: toText(r.fields['关联时间']) ?? '',
          });
        }
        tok = res.hasMore ? res.pageToken : undefined;
      } while (tok && guard++ < 50);
    }

    const isDirect = (r: { entityType: string; entityId: string }) =>
      r.entityType === NOTE_ENTITY_TYPE_STUDENT && r.entityId === studentId;

    // ② 直接关联
    const collected: { noteId: string; title: string; src: StudentNoteSource }[] = [];
    for (const r of rows.filter(isDirect)) {
      collected.push({
        noteId: r.noteId,
        title: r.title,
        src: {
          entityType: NOTE_ENTITY_TYPE_STUDENT,
          label: NOTE_ENTITY_TYPE_STUDENT,
          recordId: studentId,
          recordTitle: studentName,
          recordTime: null,
          detailHref: `/students/${studentId}`,
          linkedBy: r.linkedBy,
          linkedAt: r.linkedAt,
          byName: false,
        },
      });
    }

    // ③④⑤ 间接：逐条定点取记录 → 判归属 → 过权限
    const hiddenSources = new Set<string>();
    // ⚠️ 缓存的是**判定结果**而不是「判过没」：同一条记录可以挂多篇笔记，
    //    按「判过就跳过」写会让第 2 篇起全部丢失。
    const srcCache = new Map<string, StudentNoteSource | null>();
    for (const r of rows) {
      if (isDirect(r)) continue;
      const key = `${r.entityType}|${r.entityId}`;
      let src = srcCache.get(key);
      if (src === undefined) {
        src = await this.noteSourceForStudent(
          user,
          principal,
          r.entityType,
          r.entityId,
          studentId,
          studentName,
          hiddenSources,
        );
        srcCache.set(key, src);
      }
      if (!src) continue;
      collected.push({ noteId: r.noteId, title: r.title, src });
    }

    // 合并同一篇笔记的多个来源（同一来源重复出现也去掉）
    const byNote = new Map<string, StudentNoteLink>();
    for (const it of collected) {
      const srcKey = `${it.src.entityType}|${it.src.recordId}`;
      let note = byNote.get(it.noteId);
      if (!note) {
        note = { noteId: it.noteId, title: it.title, sources: [], direct: false };
        byNote.set(it.noteId, note);
      }
      if (!note.title && it.title) note.title = it.title;
      if (it.src.entityType === NOTE_ENTITY_TYPE_STUDENT) note.direct = true;
      if (!note.sources.some((s) => `${s.entityType}|${s.recordId}` === srcKey)) {
        note.sources.push(it.src);
      }
    }

    // 来源标签 → 笔记数（同一篇笔记在同一标签下只算一次）
    const counts: Record<string, number> = {};
    let directCount = 0;
    for (const n of byNote.values()) {
      if (n.direct) directCount += 1;
      for (const label of new Set(n.sources.map((s) => s.label))) {
        counts[label] = (counts[label] ?? 0) + 1;
      }
    }

    const orderOf = (s: StudentNoteSource) => (s.entityType === NOTE_ENTITY_TYPE_STUDENT ? 0 : 1);
    const timeOf = (n: StudentNoteLink) =>
      Math.max(0, ...n.sources.map((s) => s.recordTime ?? 0));
    for (const n of byNote.values()) {
      n.sources.sort((a, b) => orderOf(a) - orderOf(b) || (b.recordTime ?? 0) - (a.recordTime ?? 0));
    }
    const notes = [...byNote.values()].sort(
      (a, b) => Number(b.direct) - Number(a.direct) || timeOf(b) - timeOf(a),
    );

    return {
      studentId,
      studentName,
      notes,
      counts,
      directCount,
      hiddenSources: [...hiddenSources],
    };
  }

  /**
   * 一条「笔记关联」指向的业务记录，是否属于该学生？属于就返回它的来源描述，否则 null。
   *
   * 三件事一起做（顺序不能换，否则会先泄漏再判断）：
   *  ① 类型 → 归属表（`NOTE_ENTITY_TYPE_TO_PATH`），没登记的表直接 null（如会议纪要，结构上无学生字段）；
   *  ② 模块 read 权限 —— 没权限**记入 hiddenSources 后立即返回**，绝不继续往下读记录；
   *  ③ 取记录 → `meta.studentMatch` 判归属 → 类型域权限（学生记录 5 种类型各有权重点）。
   */
  private async noteSourceForStudent(
    user: SessionUser,
    principal: Principal,
    entityType: string,
    entityId: string,
    studentId: string,
    studentName: string,
    hiddenSources: Set<string>,
  ): Promise<StudentNoteSource | null> {
    const meta = this.noteMetaByEntityType(entityType);
    if (!meta) return null;

    const mod = moduleByPath('/' + meta.path);
    const label = SECTION_LABELS[meta.path] ?? meta.path;
    if (mod) {
      const readOk = meta.typeScope
        ? (() => {
            // 类型域模块（学生记录）：只要有**任一类型**的权限就算有权，具体类型在下面再筛
            const allowed = typeAllowedValues(meta, user, 'read');
            return allowed === null || allowed.length > 0;
          })()
        : authorize(principal, modulePermission(mod.key, 'read')).allowed;
      if (!readOk) {
        hiddenSources.add(label);
        return null;
      }
    }

    const rec = await this.base.get(meta.tableId, entityId).catch(() => null);
    if (!rec) return null;
    const f = rec.fields as Record<string, unknown>;

    const sm = meta.studentMatch;
    if (!sm) return null;
    const belong =
      sm.by === 'id'
        ? linkIds(f[sm.field]).includes(studentId)
        : studentName !== '' && (toText(f[sm.field]) ?? '') === studentName;
    if (!belong) return null;

    const typeCond = buildTypeScopeFilter(meta, user);
    if (typeCond === 'none') return null;
    if (typeCond && !matchFilter({ id: entityId, fields: f }, typeCond)) return null;

    const recType = toText(f['记录类型']) ?? '';
    const timeField = meta.sortField ?? meta.dateFields?.[0];
    const t = timeField ? toEpochMs(f[timeField]) : 0;
    return {
      entityType,
      // 三合一记录用**记录自身的类型**当标签（IDP沟通 > 学生记录），比模块名精确
      label: meta.typeScope && recType ? recType : label,
      recordId: entityId,
      recordTitle: noteRecordTitle(f, label),
      recordTime: Number.isFinite(t) && t > 0 ? t : null,
      detailHref: `/${meta.path}/${entityId}`,
      linkedBy: '',
      linkedAt: '',
      byName: sm.by === 'name',
    };
  }

  /** 实体类型 → 该实体所属表的 meta（别名归一：『学生记录』与『IDP沟通』都指向三合一表） */
  private noteMetaByEntityType(entityType: string): RecordMeta | undefined {
    const path = NOTE_ENTITY_TYPE_TO_PATH[entityType];
    if (!path) return undefined;
    const all: RecordMeta[] = [...LIFECYCLE_METAS, IDP_PLAN_META];
    return all.find((m) => m.path === path);
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

    /**
     * 🔴 归档的笔记不许再转换（2026-09-21 峰哥要求）。
     *
     * ⚠️ 这是**服务端闸门**，但要说清它的边界：转换的预填走浏览器本地存储
     *    （`putConvertPayload`），用户完全可以在别处手工把内容抄进业务表单 ——
     *    拦不住。它挡住的是「还在用归档笔记当数据源」这个业务动作本身。
     *
     * 为什么放在**留痕**这一层而不是转换按钮那一层：前端按钮只是给正常人省的，
     *    接口可直连；留痕是所有转换路径的必经点（改过前端也绕不过）。
     * 抛 409 而不是 403：这不是权限不足，是**状态不允许**；且前端要能把它与
     *    「留痕写失败」区分开（后者只出黄条、不阻断），所以给一个专门的错误码前缀。
     */
    {
      const map = await this.loadNoteStatusMap();
      if (isArchivedNote(map.get(noteId)?.status)) {
        throw new HttpException(
          'NOTE_ARCHIVED:该笔记已归档，不能转换；如需转换请先「激活」',
          HttpStatus.CONFLICT,
        );
      }
    }

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
