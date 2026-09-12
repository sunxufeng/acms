import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { createHash, randomBytes } from 'node:crypto';
import { TABLES, USER_TABLE } from '@acms/contracts';
import { getSqlStore } from '../base.provider.js';
import { REDIS } from '../redis.provider.js';
import { encryptSecret, decryptSecret, SECRET_MASK } from '../shared/secret-cipher.js';
import type { ProxyConfig } from './ai-proxy.util.js';
import { currentActor, runAs, systemActor } from '../shared/actor-context.js';

/**
 * AI 路由（从 acapi 多租户网关移植）。
 * ──────────────────────────────────────────────────────────────────
 * 一套自建的大模型调用网关：上游是各家厂商的真实账号，对外发我们自己的密钥。
 *
 * 链路：API 密钥 → 分组 → 模型路由 → 上游账号 → 转发 → 计费落库
 *
 * 与 acapi 原版的差异（移植时有意修的，不是"漏做"）：
 *  1. 限流用 Redis（原版是单进程内存 Map，重启即失效、多副本不共享）
 *  2. 计费用**实际上游模型**的价格（原版用请求的逻辑模型名）
 *  3. 上游失败会按优先级尝试下一个候选（原版首个失败直接报错，没有降级）
 *  4. 客户端 IP 真正落库（原版 res.locals.clientIp 从未赋值，恒为 null）
 *  5. 模型白名单、分组月配额、并发闸门、健康检查**真做**（原版字段存在但从未实现）
 *
 * 只读上游、不改上游数据；凭证 AES-256-GCM 加密落库。
 */

/** 密钥前缀。保留 acapi 的形态便于使用方无感迁移（格式 acapi-sk-<43 字符 base64url>） */
const KEY_PREFIX = 'acapi-sk-';
/** 缺省值：分组上的 RPM / 并发上限为 0 或空时用它兜底 */
const DEFAULT_RPM = 60;
const DEFAULT_CONCURRENCY = 8;
/** 连续失败多少次判定上游异常 */
const UNHEALTHY_AFTER = 3;
/** 收到 429 但没有 reset 头时的兜底冷却（毫秒）。sub2api 默认 5s，上限 2h */
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 5_000;
const MAX_RATE_LIMIT_COOLDOWN_MS = 2 * 60 * 60 * 1000;
/** 收到 529（上游过载）后的冷却：sub2api 用 10 分钟 */
const OVERLOAD_COOLDOWN_MS = 10 * 60 * 1000;
/** 鉴权类错误（401/403）后的临时摘除时长：sub2api 同为 10 分钟 */
const AUTH_COOLDOWN_MS = 10 * 60 * 1000;
/** 单个上游转发的超时（毫秒）。与 acapi 一致：120s */
const UPSTREAM_TIMEOUT_MS = 120_000;
/** 一次请求最多尝试几个上游（按优先级降级） */
const MAX_ATTEMPTS = 3;

export interface AiUsageRecord {
  /** 密钥哈希（= 密钥表主键），用于累加额度 */
  keyId: string;
  keyName: string;
  userId: string;
  groupId: string;
  groupName: string;
  upstreamName: string;
  model: string;
  upstreamModel: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  latencyMs: number;
  status: '成功' | '失败';
  errorMsg: string;
  clientIp: string;
  endpoint: string;
}

export interface RouteTarget {
  upstreamId: string;
  /** 账号级并发上限（0 = 不限）；抢槽失败就换下一个候选 */
  concurrency?: number;
  /** 该账号使用的代理 id（空 = 直连） */
  proxyId?: string;
  upstreamName: string;
  provider: string;
  baseUrl: string;
  authType: string;
  credential: Record<string, string>;
  upstreamModel: string;
  routeId: string;
}

@Injectable()
export class AiRouteService implements OnModuleInit {
  private readonly logger = new Logger(AiRouteService.name);
  private tablesReady = false;

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  // ── 建表 ────────────────────────────────────────────────────────
  async onModuleInit(): Promise<void> {
    try {
      await this.ensureTables();
    } catch (e) {
      // 建表失败不能拖垮整个 API：模块内部会给出更明确的报错
      this.logger.error(`AI 路由建表失败：${(e as Error).message}`);
    }
  }

  async ensureTables(): Promise<void> {
    const sql = getSqlStore();
    if (!sql) return;
    const list: { tableId: string; name: string }[] = [
      TABLES.aiRouteGroup,
      TABLES.aiUpstream,
      TABLES.aiModelRoute,
      TABLES.aiApiKey,
      TABLES.aiUsage,
      TABLES.aiOpLog,
      TABLES.aiProxy,
    ];
    for (const t of list) await sql.ensureTable(t.tableId, t.name, []);
    this.tablesReady = true;
    this.logger.log(`AI 路由表就绪（${list.length} 张）`);
  }

  // ── 通用读写小工具（宽表：id + data jsonb）────────────────────────
  private flat(r: unknown): Record<string, unknown> {
    const rec = r as { fields?: Record<string, unknown>; recordId?: string; id?: string } | null;
    return ((rec?.fields ?? rec) ?? {}) as Record<string, unknown>;
  }

  private rid(r: unknown): string {
    const rec = r as { recordId?: string; id?: string } | null;
    return String(rec?.recordId ?? rec?.id ?? '');
  }

  private async all(tableId: string, limit = 40): Promise<{ id: string; f: Record<string, unknown> }[]> {
    const sql = getSqlStore();
    if (!sql) return [];
    const out: { id: string; f: Record<string, unknown> }[] = [];
    let token: string | undefined;
    for (let p = 0; p < limit; p += 1) {
      const res = await sql.search(tableId, { pageSize: 500, ...(token ? { pageToken: token } : {}) });
      for (const r of res.items ?? []) out.push({ id: this.rid(r), f: this.flat(r) });
      if (!res.hasMore || !res.pageToken) break;
      token = res.pageToken;
    }
    return out;
  }

  private async one(tableId: string, id: string): Promise<Record<string, unknown> | null> {
    const sql = getSqlStore();
    if (!sql) return null;
    const rec = await sql.get(tableId, id);
    return rec ? this.flat(rec) : null;
  }

  // ── 密钥：生成 / 校验 ────────────────────────────────────────────
  /**
   * 生成一枚密钥。**返回值里的明文只出现这一次**，库里只存哈希。
   * 记录 id 直接用哈希 → 主键天然唯一，校验时 O(1) 命中，不需要额外唯一索引。
   */
  async mintKey(input: {
    name: string;
    userId: string;
    groupId: string;
    ipWhitelist?: string[];
    quotaUsd?: number;
    expiresAt?: number;
  }): Promise<{ id: string; key: string; prefix: string }> {
    const sql = getSqlStore();
    if (!sql) throw new Error('未配置数据库连接');
    const secret = randomBytes(32).toString('base64url'); // 256bit 熵
    const plain = KEY_PREFIX + secret;
    const hash = this.hashKey(plain);
    const prefix = plain.slice(0, 16); // 「acapi-sk-」+ 前 4 字符，够辨认、不足以还原
    const fields: Record<string, unknown> = {
      名称: input.name || '未命名密钥',
      密钥前缀: prefix,
      所属用户: input.userId,
      所属分组: input.groupId,
      状态: '启用',
      IP白名单: input.ipWhitelist ?? [],
      配额USD: Number(input.quotaUsd ?? 0),
      已用额度USD: 0,
      本月已用USD: 0,
    };
    if (input.expiresAt) fields['过期时间'] = input.expiresAt;
    await sql.createWithId(TABLES.aiApiKey.tableId, hash, fields);
    await this.writeOpLog('代发密钥', '密钥', input.name || prefix, { groupId: input.groupId, userId: input.userId, prefix });
    return { id: hash, key: plain, prefix };
  }

  hashKey(plain: string): string {
    return createHash('sha256').update(plain.trim()).digest('hex');
  }

  /**
   * 校验密钥（网关入口）。
   * 顺序：格式 → 存在 → 状态 → 过期 → IP 白名单 → 额度。任一不过直接抛，附带厂商风格错误码。
   */
  async verifyKey(plain: string, clientIp: string): Promise<{
    id: string;
    name: string;
    userId: string;
    groupId: string;
    group: Record<string, unknown>;
    ipWhitelist: string[];
    quotaUsd: number;
    quotaUsedUsd: number;
  }> {
    const sql = getSqlStore();
    if (!sql) throw new GatewayError('server_error', '数据库未就绪', 500);
    if (!plain.startsWith(KEY_PREFIX)) throw new GatewayError('invalid_api_key', '密钥格式不正确', 401);
    const hash = this.hashKey(plain);
    const fields = await this.one(TABLES.aiApiKey.tableId, hash);
    if (!fields) throw new GatewayError('invalid_api_key', '密钥不存在或已被删除', 401);

    if (String(fields['状态'] ?? '') !== '启用') throw new GatewayError('key_disabled', '密钥已停用', 403);

    const exp = Number(fields['过期时间'] ?? 0);
    if (exp && Date.now() > exp) {
      // 顺手把状态改成「已过期」——原版也这么做，避免每次都要比时间
      await sql.update(TABLES.aiApiKey.tableId, hash, { 状态: '已过期' }).catch(() => undefined);
      throw new GatewayError('key_expired', '密钥已过期', 403);
    }

    const whitelist = Array.isArray(fields['IP白名单'])
      ? (fields['IP白名单'] as unknown[]).map((x) => String(x)).filter(Boolean)
      : String(fields['IP白名单'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (whitelist.length && !whitelist.some((w) => this.ipMatches(clientIp, w))) {
      throw new GatewayError('ip_forbidden', '当前 IP 不在白名单内', 403);
    }

    const groupId = String(fields['所属分组'] ?? '');
    const group = groupId ? await this.one(TABLES.aiRouteGroup.tableId, groupId) : null;
    if (!group) throw new GatewayError('no_group', '密钥绑定的分组不存在', 503);
    if (String(group['状态'] ?? '') !== '启用') throw new GatewayError('group_disabled', '分组已停用', 403);

    // 额度：key 级（>0 才限制）。分组级月配额在 checkQuota 里单独判。
    const quotaUsd = Number(fields['配额USD'] ?? 0);
    const used = Number(fields['已用额度USD'] ?? 0);
    if (quotaUsd > 0 && used >= quotaUsd) throw new GatewayError('quota_exceeded', '密钥额度已用尽', 429);

    return {
      id: hash,
      name: String(fields['名称'] ?? ''),
      userId: String(fields['所属用户'] ?? ''),
      groupId,
      group,
      ipWhitelist: whitelist,
      quotaUsd,
      quotaUsedUsd: used,
    };
  }

  /** IP 匹配：支持精确、`1.2.3.4/32` 与 CIDR */
  private ipMatches(ip: string, rule: string): boolean {
    if (!rule) return false;
    const clean = ip.replace(/^::ffff:/, '');
    if (rule === clean) return true;
    const [net, bitsRaw] = rule.split('/');
    if (!net || bitsRaw === undefined) return false;
    const bits = Number(bitsRaw);
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
    const toInt = (s: string): number => {
      const parts = s.split('.').map((x) => Number(x));
      if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return -1;
      return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
    };
    const a = toInt(clean);
    const b = toInt(net);
    if (a < 0 || b < 0) return false;
    if (bits === 0) return true;
    const mask = (0xffffffff << (32 - bits)) >>> 0;
    return (a & mask) === (b & mask);
  }

  async revokeKey(id: string, reason = ''): Promise<void> {
    const sql = getSqlStore();
    if (!sql) throw new Error('未配置数据库连接');
    const f = await this.one(TABLES.aiApiKey.tableId, id);
    if (!f) throw new Error('密钥不存在');
    await sql.update(TABLES.aiApiKey.tableId, id, { 状态: '已吊销' });
    await this.writeOpLog('吊销密钥', '密钥', String(f['名称'] ?? ''), { 密钥前缀: f['密钥前缀'], reason });
  }

  /** 查看上游凭证明文（单独接口 + 记日志，列表永远只有掩码） */
  async revealCredential(upstreamId: string): Promise<Record<string, string>> {
    const f = await this.one(TABLES.aiUpstream.tableId, upstreamId);
    if (!f) throw new Error('上游账号不存在');
    const raw = String(f['凭证'] ?? '');
    if (!raw || raw === SECRET_MASK) return {};
    let parsed: Record<string, string> = {};
    try {
      parsed = JSON.parse(decryptSecret(raw)) as Record<string, string>;
    } catch {
      throw new Error('凭证解密失败（可能是加密密钥变更，需要重新录入）');
    }
    await this.writeOpLog('查看上游凭证', '上游账号', String(f['名称'] ?? ''), {});
    return parsed;
  }

  /** 上游凭证在入库前加密（generic-crud 的 secretFields 会调 encryptSecret，这里供专用接口使用） */
  encryptCredential(plain: Record<string, string> | string): string {
    return encryptSecret(typeof plain === 'string' ? plain : JSON.stringify(plain));
  }

  private upstreamCredential(f: Record<string, unknown>): Record<string, string> {
    const raw = String(f['凭证'] ?? '');
    if (!raw) return {};
    if (raw === SECRET_MASK) return {};
    try {
      return JSON.parse(decryptSecret(raw)) as Record<string, string>;
    } catch {
      return {};
    }
  }

  /** 厂商鉴权头：与 acapi 一致（anthropic 用 x-api-key + version，gemini 用 x-goog-api-key） */
  buildAuthHeaders(provider: string, credential: Record<string, string>): Record<string, string> {
    const key = credential['apiKey'] ?? credential['api_key'] ?? credential['key'] ?? credential['token'] ?? '';
    const p = String(provider ?? '').toLowerCase();
    if (p === 'anthropic') return { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
    if (p === 'gemini') return { 'x-goog-api-key': key };
    return { Authorization: `Bearer ${key}` };
  }

  // ── 模型路由 ────────────────────────────────────────────────────
  /**
   * 选上游（对齐 sub2api 的调度链路）。
   *
   * 过滤顺序：模型路由命中 → 账号属于该分组（**多对多**，一个账号可服务多个分组）
   *          → 调度状态机（停用/手动停调/过期/限流冷却/过载冷却/临时摘除/连续失败）
   *          → 利润门（成本倍率不达标的账号不进候选池）→ 分组侧账号类型过滤。
   * 排序：路由优先级（数值小优先）→ 负载率（低优先）→ 同分随机。
   *
   * 返回**已排好序的候选**；并发抢槽由调用方逐个尝试（抢不到就换下一个，不排队）。
   */
  async selectCandidates(model: string, groupId: string, group: Record<string, unknown>): Promise<RouteTarget[]> {
    const now = Date.now();
    const routes = (await this.all(TABLES.aiModelRoute.tableId)).filter(
      (r) => String(r.f['逻辑模型'] ?? '') === model && String(r.f['状态'] ?? '') === '启用',
    );
    if (!routes.length) return [];

    const upstreams = await this.all(TABLES.aiUpstream.tableId);
    const byId = new Map(upstreams.map((u) => [u.id, u]));
    const onlySubscription = String(group['仅允许订阅账号'] ?? '否') === '是';

    const cand: { id: string; f: Record<string, unknown>; prio: number; r: Record<string, unknown> }[] = [];
    const seen = new Set<string>();
    for (const rt of routes) {
      const upId = toList(rt.f['上游账号'])[0] ?? '';
      const up = byId.get(upId);
      if (!up) continue;
      if (seen.has(up.id)) continue;
      // 多分组：账号的「所属分组」是数组，包含当前分组才可用
      if (!toList(up.f['所属分组']).includes(groupId)) continue;
      if (!this.schedulableReason(up.f, now).ok) continue;
      if (!this.profitEligible(group, up.f)) continue;
      // 分组侧账号过滤：只允许订阅类账号（sub2api 的 require_oauth_only）
      if (onlySubscription && String(up.f['鉴权方式'] ?? '') === 'API Key') continue;
      seen.add(up.id);
      cand.push({ id: up.id, f: up.f, prio: Number(rt.f['优先级'] ?? 100), r: rt.f });
    }
    if (!cand.length) return [];

    const conc = await this.currentConcurrency(cand.map((c) => c.id));
    const scored = cand.map((c) => ({
      ...c,
      load: this.loadRate(conc.get(c.id) ?? 0, c.f),
      jitter: Math.random(),
    }));
    scored.sort((a, b) => a.prio - b.prio || a.load - b.load || a.jitter - b.jitter);

    return scored.map(({ id, f, r }) => ({
      routeId: String(r['id'] ?? ''),
      upstreamId: id,
      upstreamName: String(f['名称'] ?? ''),
      provider: String(f['供应商'] ?? 'openai'),
      baseUrl: String(f['BaseURL'] ?? '').replace(/\/+$/, ''),
      authType: String(f['鉴权方式'] ?? 'API Key'),
      credential: this.upstreamCredential(f),
      upstreamModel: String(r['上游模型'] ?? model),
      concurrency: Number(f['并发上限'] ?? 0) || 0,
      proxyId: toList(f['代理'])[0] ?? '',
    }));
  }

  /** 抢账号槽位：false 表示该账号已满，调用方应换下一个候选 */
  async tryAcquireAccount(target: RouteTarget): Promise<boolean> {
    return this.acquireAccountSlot(target.upstreamId, target.concurrency ?? 0);
  }

  async releaseAccount(target: RouteTarget): Promise<void> {
    await this.releaseAccountSlot(target.upstreamId);
  }

 // ── 调度状态机（对齐 sub2api）────────────────────────────────────
  /**
   * 一个账号此刻能不能被调度。
   *
   * 判据（全部满足才可调度）：
   *   状态=启用 ＋ 可调度=是 ＋ 未过期（或过期不自动暂停）＋ 三种冷却都到期 ＋ 未达并发上限
   *
   * 关键设计：限流/过载/临时不可调度**不用人工解锁** —— 网关收到 429/529/401 时写入一个
   * 「解除时间」，这里只比大小。到期自然恢复，避免"摘了忘了放回来"。
   */
  // ── 代理 ────────────────────────────────────────────────────────
  /** 代理配置缓存：60 秒，避免每个请求都查库 */
  private proxyCache = new Map<string, { at: number; cfg: ProxyConfig | null }>();

  /** 取代理配置（密码解密）。找不到/已停用/字段不全 → null（直连） */
  async getProxy(id: string): Promise<ProxyConfig | null> {
    if (!id) return null;
    const hit = this.proxyCache.get(id);
    if (hit && Date.now() - hit.at < 60_000) return hit.cfg;
    const f = await this.one(TABLES.aiProxy.tableId, id);
    const host = String(f?.['主机'] ?? '').trim();
    const port = Number(f?.['端口'] ?? 0);
    if (!f || String(f['状态'] ?? '') !== '启用' || !host || !port) {
      this.proxyCache.set(id, { at: Date.now(), cfg: null });
      return null;
    }
    let password = '';
    const enc = String(f['密码'] ?? '');
    if (enc && enc !== SECRET_MASK) {
      try {
        password = decryptSecret(enc);
      } catch {
        password = '';
      }
    }
    const cfg: ProxyConfig = {
      protocol: String(f['协议'] ?? 'http'),
      host,
      port,
      username: String(f['用户名'] ?? ''),
      password,
    };
    this.proxyCache.set(id, { at: Date.now(), cfg });
    return cfg;
  }

  schedulableReason(f: Record<string, unknown>, now = Date.now()): { ok: boolean; reason: string } {
    if (String(f['状态'] ?? '') !== '启用') return { ok: false, reason: '已停用' };
    if (String(f['可调度'] ?? '是') !== '是') return { ok: false, reason: '手动停止调度' };
    const exp = Number(f['过期时间'] ?? 0);
    if (exp && now > exp && String(f['过期自动暂停'] ?? '是') === '是') {
      return { ok: false, reason: '账号已过期' };
    }
    const rate = Number(f['限流解除时间'] ?? 0);
    if (rate && now < rate) return { ok: false, reason: `限流冷却中（至 ${new Date(rate).toLocaleTimeString('zh-CN')}）` };
    const over = Number(f['过载解除时间'] ?? 0);
    if (over && now < over) return { ok: false, reason: `上游过载冷却中（至 ${new Date(over).toLocaleTimeString('zh-CN')}）` };
    const tmp = Number(f['临时不可调度解除时间'] ?? 0);
    if (tmp && now < tmp) return { ok: false, reason: String(f['临时不可调度原因'] ?? '临时不可调度') };
    if (String(f['健康状态'] ?? '正常') === '异常') return { ok: false, reason: '连续失败已标记异常' };
    return { ok: true, reason: '' };
  }

  /** 429：写限流解除时间。有上游 reset 头就用真实值，否则兜底冷却（不摘账号） */
  async markRateLimited(upstreamId: string, resetAt?: number): Promise<void> {
    const sql = getSqlStore();
    if (!sql || !upstreamId) return;
    const now = Date.now();
    const at = resetAt && resetAt > now ? Math.min(resetAt, now + MAX_RATE_LIMIT_COOLDOWN_MS) : now + DEFAULT_RATE_LIMIT_COOLDOWN_MS;
    await runAs(systemActor('ai-route', '系统 · AI 路由'), () =>
      sql.update(TABLES.aiUpstream.tableId, upstreamId, { 限流解除时间: at, 最后失败信息: '429 限流' }),
    ).catch(() => undefined);
  }

  /** 529：上游过载，冷却 10 分钟 */
  async markOverloaded(upstreamId: string): Promise<void> {
    const sql = getSqlStore();
    if (!sql || !upstreamId) return;
    await runAs(systemActor('ai-route', '系统 · AI 路由'), () =>
      sql.update(TABLES.aiUpstream.tableId, upstreamId, {
        过载解除时间: Date.now() + OVERLOAD_COOLDOWN_MS,
        最后失败信息: '529 上游过载',
      }),
    ).catch(() => undefined);
  }

  /** 401/403：临时摘除（保持启用，等人工修好凭证或刷新 token） */
  async markTempUnschedulable(upstreamId: string, reason: string, ms = AUTH_COOLDOWN_MS): Promise<void> {
    const sql = getSqlStore();
    if (!sql || !upstreamId) return;
    await runAs(systemActor('ai-route', '系统 · AI 路由'), () =>
      sql.update(TABLES.aiUpstream.tableId, upstreamId, {
        临时不可调度解除时间: Date.now() + ms,
        临时不可调度原因: reason.slice(0, 120),
        最后失败信息: reason.slice(0, 200),
      }),
    ).catch(() => undefined);
  }

  /** 重置状态：清掉三种冷却与失败计数（排障用的一键恢复） */
  async resetAccountState(upstreamId: string): Promise<void> {
    const sql = getSqlStore();
    if (!sql) throw new Error('未配置数据库连接');
    const f = await this.one(TABLES.aiUpstream.tableId, upstreamId);
    if (!f) throw new Error('上游账号不存在');
    await sql.update(TABLES.aiUpstream.tableId, upstreamId, {
      限流解除时间: 0,
      过载解除时间: 0,
      临时不可调度解除时间: 0,
      临时不可调度原因: '',
      连续失败次数: 0,
      健康状态: '正常',
      最后失败信息: '',
    });
    await this.writeOpLog('重置账号状态', '上游账号', String(f['名称'] ?? ''), {});
  }

  // ── 账号级并发抢槽（Redis）：抢不到就换账号，而不是排队 ──
  private async acquireAccountSlot(id: string, limit: number): Promise<boolean> {
    if (!(limit > 0)) return true;
    try {
      const key = `ai:aconc:${id}`;
      const cur = await this.redis.incr(key);
      await this.redis.expire(key, 300);
      if (cur > limit) {
        await this.redis.decr(key).catch(() => undefined);
        return false;
      }
      return true;
    } catch {
      return true; // Redis 异常一律放行（fail-open）
    }
  }

  private async releaseAccountSlot(id: string): Promise<void> {
    await this.redis.decr(`ai:aconc:${id}`).catch(() => undefined);
  }

  /** 负载率 = 当前并发 × 100 / 有效负载因子（sub2api 口径；排队数这里用 0，我们抢不到就换号） */
  private loadRate(current: number, f: Record<string, unknown>): number {
    const factor = Number(f['负载因子'] ?? 0) || Number(f['并发上限'] ?? 0) || 1;
    return Math.round((current * 100) / Math.max(1, factor));
  }

  /** 当前并发（读 Redis；仅用于排序与展示，拿不到按 0 算） */
  private async currentConcurrency(ids: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    try {
      const vals = await this.redis.mget(...ids.map((i) => `ai:aconc:${i}`));
      ids.forEach((id, i) => out.set(id, Number(vals[i] ?? 0) || 0));
    } catch {
      /* 忽略 */
    }
    return out;
  }

  /** 利润门（sub2api）：账号成本倍率 U ≤ 分组倍率 D ×(1 − 毛利率 − 安全缓冲) 才准入 */
  private profitEligible(group: Record<string, unknown>, account: Record<string, unknown>): boolean {
    if (String(group['启用利润控制'] ?? '否') !== '是') return true;
    const margin = Number(group['最低毛利率'] ?? 0);
    const buffer = Number(group['安全缓冲'] ?? 0);
    if (!(margin > 0)) return true;
    if (margin + buffer >= 1) return false; // 配置本身不合法 → 拒绝（宁可少用也不亏）
    const D = Number(group['价格倍率'] ?? 1) || 1;
    const U = Number(account['账号成本倍率'] ?? 1);
    if (!Number.isFinite(U) || U < 0) return false;
    const threshold = D * (1 - margin - buffer);
    return U <= threshold + 1e-9;
  }

  /** 高峰时段倍率（sub2api）：[peak_start, peak_end) 区间内额外乘一次 */
  effectiveMultiplier(group: Record<string, unknown>, now = new Date()): number {
    const base = Number(group['价格倍率'] ?? 1) || 1;
    if (String(group['启用高峰倍率'] ?? '否') !== '是') return base;
    const start = String(group['高峰开始'] ?? '');
    const end = String(group['高峰结束'] ?? '');
    const peak = Number(group['高峰倍率'] ?? 1) || 1;
    if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) return base;
    const cur = now.getHours() * 60 + now.getMinutes();
    const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
    const a = toMin(start);
    const b = toMin(end);
    if (b <= a) return base; // 不支持跨天，配置非法时按不启用处理
    return cur >= a && cur < b ? base * peak : base;
  }

  /** 列出所有启用的逻辑模型（网关 /v1/models 用，方便使用方确认该填什么模型名） */
  async allRoutes(): Promise<{ model: string; upstreamId: string }[]> {
    const routes = await this.all(TABLES.aiModelRoute.tableId);
    return routes
      .filter((r) => String(r.f['状态'] ?? '') === '启用' && String(r.f['逻辑模型'] ?? ''))
      .map((r) => ({ model: String(r.f['逻辑模型'] ?? ''), upstreamId: String(r.f['上游账号'] ?? '') }));
  }

  // ── 配额与限流 ──────────────────────────────────────────────────
  /**
   * 用分组白名单收敛模型列表（/v1/models 用）。
   * 白名单非空时只保留命中项（支持 `xxx*` 前缀通配），与请求准入用同一套判定。
   */
  filterModelsByWhitelist(group: Record<string, unknown>, models: string[]): string[] {
    const list = toList(group['可用模型']);
    if (!list.length) return models;
    return models.filter((m) =>
      list.some((w) => w === m || (w.endsWith('*') && m.startsWith(w.slice(0, -1)))),
    );
  }

  /** 模型白名单（分组维度）：配了就必须命中，原版有字段但不校验 */
  assertModelAllowed(group: Record<string, unknown>, model: string): void {
    const list = Array.isArray(group['可用模型'])
      ? (group['可用模型'] as unknown[]).map((x) => String(x))
      : String(group['可用模型'] ?? '').split(/[,，、\s]+/).filter(Boolean);
    if (!list.length) return;
    const hit = list.some((m) => m === model || (m.endsWith('*') && model.startsWith(m.slice(0, -1))));
    if (!hit) throw new GatewayError('model_not_allowed', `分组未开放模型 ${model}`, 403);
  }

  /**
   * 三级限额（日 / 周 / 月 USD，对齐 sub2api）。任一档超了就拒绝，0 或空表示该档不限。
   * 跨档自动归零：字段上记「用量日 / 用量周 / 用量月份」，对不上就视为 0。
   */
  async assertGroupQuota(group: Record<string, unknown>, groupId: string): Promise<void> {
    const now = Date.now();
    const dayKey = new Date(now).toISOString().slice(0, 10);
    const weekKey = isoWeek(now);
    const monthKey = new Date(now).toISOString().slice(0, 7);
    const tiers: [string, string, string, number][] = [
      ['日限额USD', '今日已用USD', '用量日', dayKey === String(group['用量日'] ?? '') ? 1 : 0],
      ['周限额USD', '本周已用USD', '用量周', weekKey === String(group['用量周'] ?? '') ? 1 : 0],
      ['月配额USD', '本月已用USD', '用量月份', monthKey === String(group['用量月份'] ?? '') ? 1 : 0],
    ];
    for (const [limitField, usedField, , fresh] of tiers) {
      const limit = Number(group[limitField] ?? 0);
      if (!(limit > 0)) continue;
      const used = fresh ? Number(group[usedField] ?? 0) : 0;
      if (used >= limit) {
        throw new GatewayError(
          'quota_exceeded',
          `分组${limitField.replace('USD', '')}额度已用尽（${used.toFixed(4)}/${limit} USD）`,
          429,
        );
      }
    }
  }

  /**
   * Redis 限流：RPM（固定 60 秒窗口）与并发闸门。
   * 原版是单进程 Map —— 重启即清零、多副本各算各的，这里换成 Redis。
   */
  async acquireSlot(keyId: string, group: Record<string, unknown>, clientIp: string): Promise<void> {
    const rpmLimit = Number(group['RPM上限'] ?? 0) || DEFAULT_RPM;
    const concLimit = Number(group['并发上限'] ?? 0) || DEFAULT_CONCURRENCY;
    const minute = Math.floor(Date.now() / 60_000);
    const rpmKey = `ai:rpm:${keyId}:${minute}`;
    try {
      const count = await this.redis.incr(rpmKey);
      if (count === 1) await this.redis.expire(rpmKey, 90);
      if (count > rpmLimit) throw new GatewayError('rate_limited', `超过每分钟请求上限（${rpmLimit} RPM）`, 429);

      const concKey = `ai:conc:${keyId}`;
      const conc = await this.redis.incr(concKey);
      await this.redis.expire(concKey, 300); // 兜底 TTL：进程异常退出也不会把计数永久卡住
      if (conc > concLimit) {
        await this.redis.decr(concKey).catch(() => undefined);
        throw new GatewayError('rate_limited', `超过并发上限（${concLimit}）`, 429);
      }
    } catch (e) {
      // Redis 挂了不该让整个网关不可用：限流失败放行，但要留痕
      if (e instanceof GatewayError) throw e;
      this.logger.warn(`限流检查失败（放行）：${(e as Error).message} ip=${clientIp}`);
    }
  }

  async releaseSlot(keyId: string): Promise<void> {
    await this.redis.decr(`ai:conc:${keyId}`).catch(() => undefined);
  }

  // ── 计费 ────────────────────────────────────────────────────────
  /**
   * 按 token 算钱（USD）。
   * 与 acapi 的差异：用**实际上游模型**（upstreamModel）查价格 —— 原版用请求的逻辑模型，
   * 一旦逻辑模型映射到不同价位的上游就会算错。
   */
  computeCost(upstreamModel: string, promptTokens: number, completionTokens: number, multiplier: number): number {
    const price = priceOf(upstreamModel);
    const cost = (promptTokens / 1000) * price.in + (completionTokens / 1000) * price.out;
    return Math.round(cost * Math.max(0, multiplier || 1) * 1e6) / 1e6;
  }

  // ── 落库 ────────────────────────────────────────────────────────
  /** 写用量明细并累加额度（key 累计 + 分组本月）。失败只记日志，绝不影响调用方拿到的响应。 */
  async recordUsage(rec: AiUsageRecord): Promise<void> {
    const sql = getSqlStore();
    if (!sql) return;
    try {
      await runAs(systemActor('ai-route', '系统 · AI 路由'), async () => {
        await sql.create(TABLES.aiUsage.tableId, {
          密钥名称: rec.keyName,
          所属用户: rec.userId,
          所属分组: rec.groupId,
          上游账号: rec.upstreamName,
          逻辑模型: rec.model,
          上游模型: rec.upstreamModel,
          输入Token: rec.promptTokens,
          输出Token: rec.completionTokens,
          总Token: rec.totalTokens,
          成本USD: rec.costUsd,
          耗时ms: rec.latencyMs,
          状态: rec.status,
          错误信息: rec.errorMsg,
          客户端IP: rec.clientIp,
          接口: rec.endpoint,
          调用时间: Date.now(),
        });
      });
      await this.addUsageToKey(rec.keyId, rec.costUsd, rec.groupId);
    } catch (e) {
      this.logger.warn(`用量落库失败：${(e as Error).message}`);
    }
  }

  /**
   * 额度累加：key 的累计额度 + 分组的日/周/月三级用量。
   *
   * 一律走 SQL 表达式自增（SqlStore.addNumber）—— 读-改-写在并发下会丢更新。
   * 三级用量各自带「归属标记」（用量日/用量周/用量月份），对不上就先把总量重置为本次金额。
   */
  private async addUsageToKey(keyId: string, cost: number, groupId: string): Promise<void> {
    const sql = getSqlStore();
    if (!sql || !keyId) return;
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    const week = isoWeek(now);
    const month = new Date(now).toISOString().slice(0, 7);

    await sql.addNumber(TABLES.aiApiKey.tableId, keyId, '已用额度USD', cost).catch(() => undefined);

    const group = await this.one(TABLES.aiRouteGroup.tableId, groupId);
    if (!group) return;
    const bump = async (usedField: string, markField: string, mark: string): Promise<void> => {
      if (String(group[markField] ?? '') === mark) {
        await sql.addNumber(TABLES.aiRouteGroup.tableId, groupId, usedField, cost).catch(() => undefined);
      } else {
        // 跨档：把该档用量重置为本次金额，并记上新的归属标记
        await sql
          .update(TABLES.aiRouteGroup.tableId, groupId, { [usedField]: cost, [markField]: mark })
          .catch(() => undefined);
        group[usedField] = cost;
        group[markField] = mark;
      }
    };
    await bump('今日已用USD', '用量日', day);
    await bump('本周已用USD', '用量周', week);
    await bump('本月已用USD', '用量月份', month);
  }

  /** 上游调用成败要回写健康状态（原版 health/failCount 是死字段，这里真做） */
  async markUpstreamResult(upstreamId: string, ok: boolean, errMsg = ''): Promise<void> {
    const sql = getSqlStore();
    if (!sql || !upstreamId) return;
    try {
      const f = await this.one(TABLES.aiUpstream.tableId, upstreamId);
      if (!f) return;
      const fail = ok ? 0 : Number(f['连续失败次数'] ?? 0) + 1;
      const health = ok ? '正常' : fail >= UNHEALTHY_AFTER ? '异常' : '降级';
      await runAs(systemActor('ai-route', '系统 · AI 路由'), () =>
        sql.update(TABLES.aiUpstream.tableId, upstreamId, {
          连续失败次数: fail,
          健康状态: health,
          最后检查时间: Date.now(),
          ...(errMsg ? { 最后失败信息: errMsg.slice(0, 200) } : {}),
        }),
      );
    } catch (e) {
      this.logger.warn(`回写上游健康状态失败：${(e as Error).message}`);
    }
  }

  /** 管理动作留痕（AI 路由自己的操作日志，与系统审计日志分开） */
  async writeOpLog(action: string, targetType: string, targetName: string, detail: Record<string, unknown>, clientIp = ''): Promise<void> {
    const sql = getSqlStore();
    if (!sql) return;
    try {
      const actor = currentActorName();
      await sql.create(TABLES.aiOpLog.tableId, {
        操作人: actor,
        动作: action,
        对象类型: targetType,
        对象名称: targetName,
        详情: JSON.stringify(detail ?? {}),
        客户端IP: clientIp,
        操作时间: Date.now(),
      });
    } catch {
      /* 日志失败不影响主流程 */
    }
  }

  // ── 统计（用量页用）─────────────────────────────────────────────
  /**
   * 用量汇总：总数 + 按模型 + 按人 + 按天。
   * 宽表没有 groupBy，这里拉全量在内存聚合（量级：调用流水，按月几万条可接受）。
   * ⚠️ 超过 2 万条时只统计最近的部分，并在返回里标注 truncated。
   */
  async usageStats(params: { from?: number; to?: number; userId?: string; model?: string } = {}): Promise<{
    totals: { calls: number; promptTokens: number; completionTokens: number; totalTokens: number; costUsd: number };
    byModel: { name: string; calls: number; tokens: number; costUsd: number }[];
    byUser: { name: string; calls: number; tokens: number; costUsd: number }[];
    byDay: { day: string; calls: number; tokens: number; costUsd: number }[];
    truncated: boolean;
  }> {
    const rows = await this.all(TABLES.aiUsage.tableId, 40);
    const inRange = rows.filter((r) => {
      const t = Number(r.f['调用时间'] ?? 0) || 0;
      if (params.from && t < params.from) return false;
      if (params.to && t > params.to) return false;
      if (params.userId && String(r.f['所属用户'] ?? '') !== params.userId) return false;
      if (params.model && String(r.f['逻辑模型'] ?? '') !== params.model) return false;
      return true;
    });
    const totals = { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0 };
    const mModel = new Map<string, { calls: number; tokens: number; costUsd: number }>();
    const mUser = new Map<string, { calls: number; tokens: number; costUsd: number }>();
    const mDay = new Map<string, { calls: number; tokens: number; costUsd: number }>();
    const userNames = await this.userNames();
    for (const r of inRange) {
      const f = r.f;
      const pt = Number(f['输入Token'] ?? 0);
      const ct = Number(f['输出Token'] ?? 0);
      const tt = Number(f['总Token'] ?? pt + ct);
      const cost = Number(f['成本USD'] ?? 0);
      totals.calls += 1;
      totals.promptTokens += pt;
      totals.completionTokens += ct;
      totals.totalTokens += tt;
      totals.costUsd += cost;
      const push = (m: Map<string, { calls: number; tokens: number; costUsd: number }>, k: string) => {
        const e = m.get(k) ?? { calls: 0, tokens: 0, costUsd: 0 };
        e.calls += 1;
        e.tokens += tt;
        e.costUsd += cost;
        m.set(k, e);
      };
      push(mModel, String(f['逻辑模型'] ?? '(未知)'));
      const uid = String(f['所属用户'] ?? '');
      push(mUser, userNames.get(uid) ?? (uid ? uid.slice(0, 8) : '(未知)'));
      const day = new Date(Number(f['调用时间'] ?? 0)).toISOString().slice(0, 10);
      push(mDay, day);
    }
    const toArr = (m: Map<string, { calls: number; tokens: number; costUsd: number }>) =>
      [...m.entries()]
        .map(([name, v]) => ({ name, ...v }))
        .sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls);
    return {
      totals: { ...totals, costUsd: Math.round(totals.costUsd * 1e6) / 1e6 },
      byModel: toArr(mModel),
      byUser: toArr(mUser),
      byDay: [...mDay.entries()]
        .map(([day, v]) => ({ day, ...v }))
        .sort((a, b) => (a.day < b.day ? -1 : 1)),
      truncated: rows.length >= 20_000,
    };
  }

  /** 分组下拉、密钥表单要用：userid → 姓名 */
  async userNames(): Promise<Map<string, string>> {
    const sql = getSqlStore();
    const out = new Map<string, string>();
    if (!sql) return out;
    let token: string | undefined;
    for (let p = 0; p < 20; p += 1) {
      const res = await sql.search(USER_TABLE.tableId, { pageSize: 200, ...(token ? { pageToken: token } : {}) });
      for (const r of res.items ?? []) {
        const f = this.flat(r);
        const openId = String(f['Open ID'] ?? f['openId'] ?? f['飞书OpenID'] ?? '');
        const name = String(f['姓名'] ?? '');
        if (openId && name) out.set(openId, name);
      }
      if (!res.hasMore || !res.pageToken) break;
      token = res.pageToken;
    }
    return out;
  }

  /** 健康检查（定时任务调用）：逐个探测上游 /models 端点 */
  async healthCheckAll(): Promise<{ checked: number; ok: number; bad: number }> {
    const ups = (await this.all(TABLES.aiUpstream.tableId)).filter((u) => String(u.f['状态'] ?? '') === '启用');
    let ok = 0;
    let bad = 0;
    for (const u of ups) {
      const baseUrl = String(u.f['BaseURL'] ?? '').replace(/\/+$/, '');
      if (!baseUrl) continue;
      const cred = this.upstreamCredential(u.f);
      const headers = this.buildAuthHeaders(String(u.f['供应商'] ?? 'openai'), cred);
      let success = false;
      let errMsg = '';
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 8000);
        const res = await fetch(`${baseUrl}/models`, { headers, signal: ctl.signal });
        clearTimeout(timer);
        success = res.ok;
        if (!res.ok) errMsg = `HTTP ${res.status}`;
      } catch (e) {
        errMsg = (e as Error).message.slice(0, 120);
      }
      await this.markUpstreamResult(u.id, success, errMsg);
      if (success) ok += 1;
      else bad += 1;
    }
    if (ups.length) this.logger.log(`AI 上游健康检查：正常 ${ok} / 异常 ${bad}（共 ${ups.length}）`);
    return { checked: ups.length, ok, bad };
  }
}

/** 网关统一错误：携带厂商风格的 code，供 gateway controller 转成 {error:{...}} */
export class GatewayError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

function currentActorName(): string {
  return currentActor()?.name ?? '系统';
}

/**
 * 价格表（USD / 1K tokens）。
 * 与 acapi 一样内置常见模型，先精确匹配、再前缀匹配、最后用兜底价。
 * ⚠️ 改价只需改这里；分组上的「价格倍率」会在计算结果上再乘一次。
 */
const PRICING: Record<string, { in: number; out: number }> = {
  'gpt-4o-mini': { in: 0.00015, out: 0.0006 },
  'gpt-4o': { in: 0.0025, out: 0.01 },
  'gpt-4.1': { in: 0.002, out: 0.008 },
  'gpt-4.1-mini': { in: 0.0004, out: 0.0016 },
  'gpt-4-turbo': { in: 0.01, out: 0.03 },
  'gpt-3.5-turbo': { in: 0.0005, out: 0.0015 },
  'o3-mini': { in: 0.0011, out: 0.0044 },
  'claude-3-5-sonnet': { in: 0.003, out: 0.015 },
  'claude-3-5-haiku': { in: 0.0008, out: 0.004 },
  'claude-3-opus': { in: 0.015, out: 0.075 },
  'claude-sonnet-4': { in: 0.003, out: 0.015 },
  'claude-haiku-4': { in: 0.001, out: 0.005 },
  'deepseek-chat': { in: 0.00027, out: 0.0011 },
  'deepseek-reasoner': { in: 0.00055, out: 0.00219 },
  'qwen-turbo': { in: 0.0003, out: 0.0006 },
  'qwen-plus': { in: 0.0008, out: 0.002 },
  'qwen-max': { in: 0.0024, out: 0.0096 },
  'glm-4': { in: 0.0014, out: 0.0014 },
  'moonshot-v1-8k': { in: 0.0017, out: 0.0017 },
  'gemini-1.5-pro': { in: 0.00125, out: 0.005 },
  'gemini-1.5-flash': { in: 0.000075, out: 0.0003 },
  'text-embedding-3-small': { in: 0.00002, out: 0 },
  'text-embedding-3-large': { in: 0.00013, out: 0 },
};

function priceOf(model: string): { in: number; out: number } {
  const m = String(model ?? '').toLowerCase();
  if (PRICING[m]) return PRICING[m]!;
  const hit = Object.keys(PRICING)
    .filter((k) => m.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  if (hit) return PRICING[hit]!;
  return { in: 0.001, out: 0.002 }; // 未知模型兜底价
}

export { priceOf, KEY_PREFIX, UPSTREAM_TIMEOUT_MS, MAX_ATTEMPTS };

/** 宽表里的 multi 字段可能是数组、也可能被存成逗号分隔字符串，统一成数组 */
function toList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (v && typeof v === 'object') {
    const o = v as { text?: string };
    return o.text ? [o.text.trim()] : [];
  }
  return String(v ?? '')
    .split(/[,，、]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** ISO 周标识（如 2026-W37），用于「周限额」的跨周归零判断 */
function isoWeek(ms: number): string {
  const d = new Date(ms);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
