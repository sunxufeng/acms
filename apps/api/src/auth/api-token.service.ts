import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { createHash, randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import { MODULE_RESOURCES, TABLES, type SessionUser } from '@acms/contracts';
import { getSqlStore } from '../base.provider.js';
import { REDIS } from '../redis.provider.js';
import { AuthService } from './auth.service.js';
import { HighRiskGateService, GATE_UNLOCK_TTL_SECONDS } from './high-risk-gate.js';
import { AuditService } from '../audit/audit.service.js';
import { UsersService } from '../user/user.service.js';

/**
 * API 令牌（CLI / MCP / 脚本接入，2026-09-16）。
 *
 * ## 定位
 * 让 WorkBuddy、Codex、脚本能以「一个有权限的账号」的身份读写 ACMS ——
 * 而不是让人把浏览器 Cookie 抠出来塞进脚本。
 *
 * ## 手法照抄仓库既有的 AI 网关（`ai-route.service.ts` 的 `verifyKey`）
 *   前缀校验 → sha256 → **用哈希当主键查库（O(1)）** → 状态 → 过期 → IP 白名单 → 限流
 * 库里**不存明文**，明文只在签发时的响应体里出现一次。
 *
 * 🔴 **签发必须走本服务的专用接口**：通用 CRUD 会自己生成随机 id，
 * 而这里的 id 必须是明文哈希 —— 用通用 CRUD 建出来的令牌永远验不过。
 *
 * ## 认证之后会发生什么（这是整个方案的关键）
 * `verify()` 返回的是一个**标准的 SessionUser**，守卫把它塞进 `req.user` 后，
 * 后续链路（学生档案行级数据范围、`requireModule()` 模块权限、审计操作人、
 * `currentActor()`）**全部零改动自动生效**。
 * 换句话说：令牌不是一个后门，它是「另一种凭证形式的同一个用户」。
 *
 * ## 限制项
 * `只读` / `可访问模块` 通过 `SessionUser.limits` 交给 `checkAccessLimits` 判定，
 * 与身份模拟共用同一条链路（kind 不同，放行规则不同）。
 */

/** 令牌前缀：`acms-sk-` 后面接 43 字符 base64url（256 bit 熵） */
const TOKEN_PREFIX = 'acms-sk-';

/** 建表用的字段 type（与生产 `acms_fields` 实测口径一致） */
const T = { TEXT: 1, NUMBER: 2, SELECT: 3 } as const;
type FieldDef = { name: string; type: number; property?: unknown };
const sel = (...names: string[]): FieldDef['property'] => ({ options: names.map((name) => ({ name })) });

/** 令牌有效期上限：1 年（长期凭证泄漏 = 长期风险，超过一年的令牌不该存在） */
export const MAX_TOKEN_TTL_MS = 365 * 24 * 3600 * 1000;

/** 校验结果的 Redis 缓存 TTL：60 秒。吊销/改限制时会**主动清**，不等它过期 */
const CACHE_TTL_SECONDS = 60;

/** 计数回写的节流：同一个令牌最多每 5 分钟写一次库（否则每个请求都要写 PG） */
const COUNTER_FLUSH_SECONDS = 300;

const STATUS_ENABLED = '启用';
const STATUS_DISABLED = '停用';
const STATUS_REVOKED = '已吊销';
const STATUS_EXPIRED = '已过期';
/** 「已过期」是服务端顺手改的状态，不算「启用」 */
const AVAILABLE = new Set([STATUS_ENABLED]);

export type TokenStatus = '启用' | '停用' | '已吊销' | '已过期';

export interface ApiTokenRow {
  id: string;
  name: string;
  prefix: string;
  userOpenId: string;
  userName: string;
  usage: string;
  readOnly: boolean;
  modules: string[];
  status: string;
  expiresAt: number;
  ipWhitelist: string[];
  rateLimit: number;
  logAll: boolean;
  lastUsedAt: number;
  usedCount: number;
  remark: string;
  /** 已过期 / 已吊销 / 已停用 —— 前端据此置灰 */
  expired: boolean;
}

export interface ApiTokenListResult {
  rows: ApiTokenRow[];
  total: number;
  enabled: number;
  revoked: number;
  /** 现存令牌里「可写」的数量 —— 页面上要显眼，这是风险点 */
  writable: number;
  maxTtlMs: number;
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

export interface UpdateTokenDto {
  name?: string;
  readOnly?: boolean;
  modules?: string[];
  expiresAt?: number;
  ipWhitelist?: string;
  rateLimit?: number;
  logAll?: boolean;
  /** 只允许在 启用 / 停用 之间切；吊销走 revoke()（语义不同，要留痕） */
  status?: typeof STATUS_ENABLED | typeof STATUS_DISABLED;
  remark?: string;
}

@Injectable()
export class ApiTokenService implements OnModuleInit {
  private readonly logger = new Logger(ApiTokenService.name);

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly auth: AuthService,
    /** 二次密码闸：签发/吊销长期凭证与「身份模拟」同等级，共用一套密码与失败锁定 */
    private readonly gate: HighRiskGateService,
    private readonly audit: AuditService,
    /**
     * `UsersService` 通过 ModuleRef **延迟解析**，而不是直接注入 + `imports: [UsersModule]`。
     *
     * 为什么：本服务住在 `AuthModule`（`@Global`）里，而 `UsersModule` 的控制器要用
     * AuthModule 导出的 `SessionGuard`。若让 AuthModule 反过来 import UsersModule，
     * 就形成「AuthModule → UsersModule →（全局）AuthModule 的守卫」这种解析顺序依赖 ——
     * 一旦 Nest 的实例化顺序不对，**表现是整个 API 起不来**（不是某个接口报错）。
     * 本地没有 .env 无法预跑，这种风险不值得冒。
     *
     * ModuleRef 把解析推迟到首次调用，容器此时早已建好，两全其美。
     */
    private readonly modRef: ModuleRef,
  ) {}

  /** 用户表相关读取统一走 UsersService —— 复用「用户表 → 可用清单」的既有判定，不另写一份 */
  private get users(): UsersService {
    // strict:false ⇒ 在整个应用容器里找（UsersModule 已在 AppModule 注册）
    return this.modRef.get(UsersService, { strict: false });
  }

  /** 启动期幂等建表（通用 CRUD 只生成路由、不建表；漏了会导致写入静默失败） */
  async onModuleInit(): Promise<void> {
    try {
      await this.ensureTables();
    } catch (e) {
      console.error(`[api-token] 启动建表失败: ${(e as Error).message}`);
    }
  }

  async ensureTables(): Promise<void> {
    const sql = getSqlStore();
    if (!sql) {
      this.logger.warn('[api-token] 未配置 DATABASE_URL，跳过建表（令牌不可用）');
      return;
    }

    // ── 1. API 令牌表 ──────────────────────────────────────────────
    // 🔴 记录 id = 明文 SHA-256（由 create() 显式传入），所以这里没有「密钥」字段
    await sql.ensureTable(TABLES.apiToken.tableId, TABLES.apiToken.name, [
      { name: '名称', type: T.TEXT },
      // 只存前 16 字符，用于在列表里辨认 —— 不足以还原明文
      { name: '密钥前缀', type: T.TEXT },
      { name: '绑定用户', type: T.TEXT },
      { name: '绑定OpenID', type: T.TEXT },
      { name: '用途', type: T.SELECT, property: sel('CLI', 'MCP', '脚本', 'CI') },
      { name: '只读', type: T.SELECT, property: sel('是', '否') },
      // 模块白名单存 **key 的逗号分隔串**（不是多选枚举）：
      // 多选要维护「码值↔中文」映射，而 MODULE_RESOURCES 会持续新增，
      // 那种映射一旦漂移就是权限事故（历史上已有多次枚举漂移的教训）。
      { name: '可访问模块', type: T.TEXT },
      { name: '状态', type: T.SELECT, property: sel(STATUS_ENABLED, STATUS_DISABLED, STATUS_REVOKED, STATUS_EXPIRED) },
      // 时间统一存毫秒时间戳（NUMBER）：读取端自己格式化，不受时区口径影响
      { name: '过期时间', type: T.NUMBER, property: { formatter: '0' } },
      { name: 'IP白名单', type: T.TEXT },
      { name: '限流', type: T.NUMBER, property: { formatter: '0' } },
      { name: '全量留痕', type: T.SELECT, property: sel('是', '否') },
      { name: '最后使用时间', type: T.NUMBER, property: { formatter: '0' } },
      { name: '使用次数', type: T.NUMBER, property: { formatter: '0' } },
      { name: '备注', type: T.TEXT },
    ]);

    // ── 2. 调用日志表 ──────────────────────────────────────────────
    await sql.ensureTable(TABLES.apiTokenLog.tableId, TABLES.apiTokenLog.name, [
      { name: '令牌', type: T.TEXT },
      { name: '令牌名称', type: T.TEXT },
      { name: '操作人', type: T.TEXT },
      { name: '操作人OpenID', type: T.TEXT },
      { name: '时间', type: T.NUMBER, property: { formatter: '0' } },
      { name: '方法', type: T.TEXT },
      { name: '路径', type: T.TEXT },
      { name: '状态码', type: T.NUMBER, property: { formatter: '0' } },
      { name: '耗时ms', type: T.NUMBER, property: { formatter: '0' } },
      { name: 'IP', type: T.TEXT },
    ]);

    this.logger.log('[api-token] API 令牌表 / 调用日志表 已就绪');
  }

  // ────────────────────────────────────────────────────────────────
  // 认证（SessionGuard 调用）
  // ────────────────────────────────────────────────────────────────

  /** 明文 → 记录 id（SHA-256 hex） */
  hashToken(plain: string): string {
    return createHash('sha256').update(plain.trim()).digest('hex');
  }

  /** 请求头里是不是我们的令牌（守卫先做这个廉价判断，避免误吞别家的 Bearer） */
  looksLikeToken(value: string | undefined | null): boolean {
    return typeof value === 'string' && value.trim().startsWith(TOKEN_PREFIX);
  }

  private cacheKey(id: string): string {
    return `apitok:cache:${id}`;
  }

  private countKey(id: string): string {
    return `apitok:use:${id}`;
  }

  private flushKey(id: string): string {
    return `apitok:flush:${id}`;
  }

  /** 读令牌记录（带 60s 缓存）。返回 null = 不存在 */
  private async loadToken(id: string): Promise<Record<string, unknown> | null> {
    const cached = await this.redis.get(this.cacheKey(id));
    if (cached) {
      try {
        return JSON.parse(cached) as Record<string, unknown>;
      } catch {
        /* 缓存坏了就走库 */
      }
    }
    const sql = getSqlStore();
    if (!sql) return null;
    const rec = await sql.get(TABLES.apiToken.tableId, id);
    if (!rec) return null;
    const fields = ((rec as unknown as { fields?: Record<string, unknown> }).fields ??
      {}) as Record<string, unknown>;
    await this.redis.set(this.cacheKey(id), JSON.stringify(fields), 'EX', CACHE_TTL_SECONDS);
    return fields;
  }

  /**
   * 清缓存。**改限制与吊销后必须调用** ——
   * 只靠 60 秒 TTL 的话，「已吊销的令牌还能再用一分钟」是安全事故而不是缓存问题。
   */
  async invalidate(id: string): Promise<void> {
    await this.redis.del(this.cacheKey(id));
  }

  /**
   * 校验令牌并组装成**标准 SessionUser**。
   *
   * 抛出的异常把「认证失败」与「权限/限制」分开：
   *  - 401 ⇒ 令牌本身不可用（格式/不存在/已删）→ 调用方该换令牌
   *  - 403 ⇒ 令牌存在但状态/IP/限制不允许 → 换令牌没用
   * 这样 CLI 才能给出语义化退出码（3 vs 4），而不是笼统的「失败」。
   */
  async verify(bearer: string, ip: string): Promise<SessionUser> {
    const plain = bearer.trim();
    if (!plain.startsWith(TOKEN_PREFIX)) throw new ForbiddenException('TOKEN_INVALID_FORMAT');

    const id = this.hashToken(plain);
    const f = await this.loadToken(id);
    if (!f) throw new ForbiddenException('TOKEN_NOT_FOUND');

    const status = String(f['状态'] ?? '');
    if (!AVAILABLE.has(status)) {
      throw new ForbiddenException(status === STATUS_EXPIRED ? 'TOKEN_EXPIRED' : 'TOKEN_DISABLED');
    }

    const exp = Number(f['过期时间'] ?? 0);
    if (exp && Date.now() > exp) {
      // 顺手把状态改成「已过期」，省得每次都算一遍（与 AI 网关同一做法）
      const sql = getSqlStore();
      if (sql) {
        await sql.update(TABLES.apiToken.tableId, id, { 状态: STATUS_EXPIRED }).catch(() => undefined);
      }
      await this.invalidate(id);
      throw new ForbiddenException('TOKEN_EXPIRED');
    }

    const whitelist = this.parseList(f['IP白名单']);
    if (whitelist.length && !whitelist.some((w) => this.ipMatches(ip, w))) {
      throw new ForbiddenException('TOKEN_IP_FORBIDDEN');
    }

    const limit = Number(f['限流'] ?? 0);
    if (limit > 0) await this.assertRate(id, limit);

    const openId = String(f['绑定OpenID'] ?? '').trim();
    if (!openId) throw new ForbiddenException('TOKEN_NO_USER');

    /**
     * 🔴 身份**必须**走 resolvePrincipal —— 角色/校区/密级的唯一口径。
     * 自己拼会漏掉「有效角色清单过滤」与校区规则，校区算错 ⇒ 令牌查一条数据都看不到，
     * 还会被误判成功能坏了（身份模拟踩过同款）。
     */
    const principal = await this.auth.resolvePrincipal(openId, String(f['绑定用户'] ?? ''));

    const readOnly = String(f['只读'] ?? '是') !== '否';
    const modules = this.parseList(f['可访问模块']);

    // fire-and-forget：计数与最后使用时间不能拖慢请求
    void this.touch(id);

    return {
      ...principal,
      sessionId: `token:${id.slice(0, 16)}`,
      expiresAt: exp || Date.now() + 3600_000,
      limits: { readOnly, modules },
      authVia: 'token',
      tokenId: id,
    } as SessionUser;
  }

  /** 频率限制：次/分钟（滑动窗口按分钟分桶，够用且实现简单） */
  private async assertRate(id: string, perMinute: number): Promise<void> {
    const bucket = Math.floor(Date.now() / 60000);
    const key = `apitok:rl:${id}:${bucket}`;
    const n = await this.redis.incr(key);
    if (n === 1) await this.redis.expire(key, 120);
    if (n > perMinute) {
      throw new HttpException(`TOKEN_RATE_LIMITED: 该令牌限流 ${perMinute} 次/分钟`, 429);
    }
  }

  /**
   * 累加使用计数 / 记录最后使用时间。
   *
   * ⚠️ 这里刻意**不**每请求写库：agent 一小时可能调几百次，
   * 逐次 UPDATE 会把 PG 写热。做法是先在 Redis 累加，
   * 每 5 分钟（`SET NX EX` 抢锁）才真正落一次库 —— 计数是「大致准确」就够用的指标。
   */
  private async touch(id: string): Promise<void> {
    try {
      await this.redis.incr(this.countKey(id));
      const got = await this.redis.set(this.flushKey(id), '1', 'EX', COUNTER_FLUSH_SECONDS, 'NX');
      if (!got) return;
      const n = Number(await this.redis.get(this.countKey(id))) || 0;
      if (!n) return;
      const sql = getSqlStore();
      if (!sql) return;
      // 用 addNumber 做原子自增，而不是「读出来加一下再写回」——
      // 后者在并发下必然丢更新（两个请求都读到 100、各写 110，只累加了一次）。
      await sql.addNumber(TABLES.apiToken.tableId, id, '使用次数', n, 0);
      await sql.update(TABLES.apiToken.tableId, id, { 最后使用时间: Date.now() });
      await this.redis.del(this.countKey(id));
      // 计数变了 ⇒ 缓存的 fields 里那份计数已过时，顺手清掉
      await this.invalidate(id);
    } catch {
      /* 计数失败绝不能影响请求 */
    }
  }

  /**
   * 写调用日志。
   *
   * 默认**只记写操作**：读操作逐条落库会淹掉真正重要的审计，也会把 PG 写热。
   * 需要全量时把令牌上的「全量留痕」打开。
   *
   * 令牌名与操作人从令牌记录里取（走缓存，代价可忽略）——
   * 这样 `SessionUser` 契约不必为了留痕多背两个字段。
   */
  async logCall(info: {
    tokenId: string;
    method: string;
    path: string;
    status: number;
    ms: number;
    ip: string;
  }): Promise<void> {
    try {
      const f = await this.loadToken(info.tokenId);
      if (!f) return;
      const logAll = String(f['全量留痕'] ?? '') === '是';
      const isRead = new Set(['GET', 'HEAD', 'OPTIONS']).has(info.method.toUpperCase());
      if (isRead && !logAll) return;

      const sql = getSqlStore();
      if (!sql) return;
      await sql.create(TABLES.apiTokenLog.tableId, {
        令牌: info.tokenId,
        令牌名称: String(f['名称'] ?? ''),
        操作人: String(f['绑定用户'] ?? ''),
        操作人OpenID: String(f['绑定OpenID'] ?? ''),
        时间: Date.now(),
        方法: info.method.toUpperCase(),
        路径: info.path,
        状态码: info.status,
        耗时ms: info.ms,
        IP: info.ip,
      });
    } catch (e) {
      this.logger.warn(`[api-token] 调用日志写入失败: ${(e as Error).message}`);
    }
  }

  // ────────────────────────────────────────────────────────────────
  // 管理（页面，系统管理员 + 二次密码）
  // ────────────────────────────────────────────────────────────────

  private requireAdmin(user: SessionUser): void {
    if (!user?.roles?.includes('系统管理员')) throw new ForbiddenException('ADMIN_ONLY');
  }

  /**
   * 二次密码解锁。与身份模拟共用 `HighRiskGateService`（scope='apitoken' 独立）——
   * 解锁了模拟不等于解锁了令牌管理，两者风险等级不同，不该互相授权。
   */
  async unlock(admin: SessionUser, password: string, ip: string) {
    this.requireAdmin(admin);
    return this.gate.unlock('apitoken', admin.openId, password, ip);
  }

  async lock(admin: SessionUser): Promise<{ ok: true }> {
    this.requireAdmin(admin);
    await this.gate.lockScope('apitoken', admin.openId);
    return { ok: true };
  }

  /** 页面初始状态：是否已解锁 + 密码来源（让页面能如实提示「用的是代码内默认值」） */
  async state(admin: SessionUser) {
    this.requireAdmin(admin);
    return {
      unlocked: await this.gate.isUnlocked('apitoken', admin.openId),
      expiresIn: GATE_UNLOCK_TTL_SECONDS,
      passwordSource: this.gate.passwordSource(),
      maxTtlMs: MAX_TOKEN_TTL_MS,
    };
  }

  private async requireUnlocked(admin: SessionUser): Promise<void> {
    if (!(await this.gate.isUnlocked('apitoken', admin.openId))) {
      // 403 而不是 401：前端的 request() 把 401 一律当「未登录」并跳登录页，
      // 用 401 会让「解锁超时」表现成「被登出」。
      throw new ForbiddenException('TOKEN_UNLOCK_REQUIRED');
    }
  }

  /** 模块白名单候选项 —— 来自 MODULE_RESOURCES 单一真源，不在前端硬编码 */
  listModuleOptions(admin: SessionUser): { key: string; label: string }[] {
    this.requireAdmin(admin);
    return MODULE_RESOURCES.map((m) => ({ key: m.key, label: m.label })).sort((a, b) =>
      a.label.localeCompare(b.label, 'zh-CN'),
    );
  }

  /** 可签发令牌的用户（复用身份模拟那份「用户表 → 可用清单」判定，避免两处口径不一） */
  async listUsers(admin: SessionUser) {
    this.requireAdmin(admin);
    const rows = await this.users.listForImpersonation();
    return rows.map((r) => ({ openId: r.openId, name: r.name, campus: r.campus, roles: r.roles, status: r.status, canUse: r.canEnter, reason: r.reason }));
  }

  async list(admin: SessionUser): Promise<ApiTokenListResult> {
    this.requireAdmin(admin);
    await this.requireUnlocked(admin);
    const sql = getSqlStore();
    if (!sql) return { rows: [], total: 0, enabled: 0, revoked: 0, writable: 0, maxTtlMs: MAX_TOKEN_TTL_MS };

    const raw: { id: string; f: Record<string, unknown> }[] = [];
    let token: string | undefined;
    for (let i = 0; i < 20; i++) {
      const res = await sql.search(TABLES.apiToken.tableId, { pageSize: 500, pageToken: token });
      for (const r of res.items) {
        const x = r as unknown as { recordId?: string; id?: string; fields?: Record<string, unknown> };
        raw.push({ id: String(x.recordId ?? x.id ?? ''), f: x.fields ?? {} });
      }
      token = res.pageToken ?? undefined;
      if (!token || res.items.length < 500) break;
    }

    const now = Date.now();
    const rows: ApiTokenRow[] = raw.map(({ id, f }) => {
      const exp = Number(f['过期时间'] ?? 0);
      const status = String(f['状态'] ?? STATUS_ENABLED);
      return {
        id,
        name: String(f['名称'] ?? '未命名令牌'),
        prefix: String(f['密钥前缀'] ?? ''),
        userOpenId: String(f['绑定OpenID'] ?? ''),
        userName: String(f['绑定用户'] ?? ''),
        usage: String(f['用途'] ?? ''),
        readOnly: String(f['只读'] ?? '是') !== '否',
        modules: this.parseList(f['可访问模块']),
        status,
        expiresAt: exp,
        ipWhitelist: this.parseList(f['IP白名单']),
        rateLimit: Number(f['限流'] ?? 0),
        logAll: String(f['全量留痕'] ?? '') === '是',
        lastUsedAt: Number(f['最后使用时间'] ?? 0),
        usedCount: Number(f['使用次数'] ?? 0),
        remark: String(f['备注'] ?? ''),
        expired: (exp > 0 && now > exp) || status === STATUS_REVOKED || status === STATUS_EXPIRED,
      };
    });
    // 活跃的排前面，最近用过的再靠前
    rows.sort((a, b) => Number(a.expired) - Number(b.expired) || b.lastUsedAt - a.lastUsedAt);

    return {
      rows,
      total: rows.length,
      enabled: rows.filter((r) => r.status === STATUS_ENABLED && !r.expired).length,
      revoked: rows.filter((r) => r.status === STATUS_REVOKED || r.status === STATUS_EXPIRED).length,
      writable: rows.filter((r) => !r.readOnly && !r.expired && r.status === STATUS_ENABLED).length,
      maxTtlMs: MAX_TOKEN_TTL_MS,
    };
  }

  /**
   * 签发令牌。**返回值里的明文只出现这一次**，库里只存哈希。
   */
  async issue(
    admin: SessionUser,
    dto: IssueTokenDto,
    ip: string,
  ): Promise<{ id: string; token: string; prefix: string; row: ApiTokenRow }> {
    this.requireAdmin(admin);
    await this.requireUnlocked(admin);

    const openId = String(dto.userOpenId ?? '').trim();
    if (!openId) throw new BadRequestException('必须指定绑定用户');
    const users = await this.users.listForImpersonation();
    const target = users.find((u) => u.openId === openId);
    if (!target) throw new NotFoundException('绑定用户不存在');
    if (!target.canEnter) throw new BadRequestException(`该用户不可签发令牌：${target.reason}`);

    const expiresAt = this.normalizeExpiry(dto.expiresAt);
    const modules = this.normalizeModules(dto.modules);
    const readOnly = dto.readOnly !== false; // 默认只读（不传也按只读处理，宁可收紧）

    const plain = TOKEN_PREFIX + randomBytes(32).toString('base64url');
    const id = this.hashToken(plain);
    const prefix = plain.slice(0, 16);

    const sql = getSqlStore();
    if (!sql) throw new HttpException('数据库未就绪', 503);
    // 🔴 必须用 createWithId 显式指定主键 = 明文哈希：
    // 普通 create() 会自己生成随机 id，哈希就丢了，令牌永远验不过。
    await sql.createWithId(TABLES.apiToken.tableId, id, {
      名称: String(dto.name ?? '').trim() || '未命名令牌',
      密钥前缀: prefix,
      绑定用户: target.name,
      绑定OpenID: openId,
      用途: String(dto.usage ?? 'CLI'),
      只读: readOnly ? '是' : '否',
      可访问模块: modules.join(','),
      状态: STATUS_ENABLED,
      过期时间: expiresAt,
      IP白名单: String(dto.ipWhitelist ?? '').trim(),
      限流: Math.max(0, Number(dto.rateLimit ?? 0) || 0),
      全量留痕: dto.logAll ? '是' : '否',
      最后使用时间: 0,
      使用次数: 0,
      备注: String(dto.remark ?? ''),
    });

    await this.audit.log({
      actor: admin.name,
      action: '创建',
      module: 'apiTokens',
      recordId: id,
      summary: `签发 API 令牌「${String(dto.name ?? '').trim() || '未命名令牌'}」（${prefix}…）给 ${target.name}`,
      detail: `只读=${readOnly ? '是' : '否'} 模块=${modules.join('/') || '不限'} 过期=${expiresAt ? new Date(expiresAt).toISOString() : '永久'}`,
    });

    void ip;
    const row = (await this.list(admin)).rows.find((r) => r.id === id);
    return { id, token: plain, prefix, row: row as ApiTokenRow };
  }

  /** 改限制项（名称/只读/模块/过期/IP/限流/留痕/备注） */
  async update(admin: SessionUser, id: string, dto: UpdateTokenDto): Promise<ApiTokenRow> {
    this.requireAdmin(admin);
    await this.requireUnlocked(admin);

    const sql = getSqlStore();
    if (!sql) throw new HttpException('数据库未就绪', 503);
    const rec = await sql.get(TABLES.apiToken.tableId, id);
    if (!rec) throw new NotFoundException('令牌不存在');
    const cur = ((rec as unknown as { fields?: Record<string, unknown> }).fields ?? {}) as Record<string, unknown>;

    const fields: Record<string, unknown> = {};
    if (dto.name !== undefined) fields['名称'] = String(dto.name).trim() || '未命名令牌';
    if (dto.readOnly !== undefined) fields['只读'] = dto.readOnly ? '是' : '否';
    if (dto.modules !== undefined) fields['可访问模块'] = this.normalizeModules(dto.modules).join(',');
    if (dto.expiresAt !== undefined) fields['过期时间'] = this.normalizeExpiry(dto.expiresAt);
    if (dto.ipWhitelist !== undefined) fields['IP白名单'] = String(dto.ipWhitelist).trim();
    if (dto.rateLimit !== undefined) fields['限流'] = Math.max(0, Number(dto.rateLimit) || 0);
    if (dto.logAll !== undefined) fields['全量留痕'] = dto.logAll ? '是' : '否';
    if (dto.remark !== undefined) fields['备注'] = String(dto.remark);
    if (dto.status !== undefined) {
      if (String(cur['状态'] ?? '') === STATUS_REVOKED) {
        throw new BadRequestException('已吊销的令牌不能重新启用，请重新签发');
      }
      fields['状态'] = dto.status === STATUS_DISABLED ? STATUS_DISABLED : STATUS_ENABLED;
    }
    if (!Object.keys(fields).length) throw new BadRequestException('没有要修改的内容');

    await sql.update(TABLES.apiToken.tableId, id, fields);
    // 🔴 改完立刻清缓存：否则「已经关掉只读」要等 60 秒才生效，人会以为没生效
    await this.invalidate(id);

    void this.audit.log({
      actor: admin.name,
      action: '更新',
      module: 'apiTokens',
      recordId: id,
      summary: `修改 API 令牌「${String(cur['名称'] ?? '')}」的限制项`,
      detail: Object.keys(fields).join('、'),
    });

    const row = (await this.list(admin)).rows.find((r) => r.id === id);
    if (!row) throw new NotFoundException('令牌不存在');
    return row;
  }

  /**
   * 吊销令牌。语义上是**状态流转**而不是删除 —— 要留痕
   * （删了就说不清「这个令牌曾经存在过」）。
   */
  async revoke(admin: SessionUser, id: string, reason = ''): Promise<{ ok: true }> {
    this.requireAdmin(admin);
    await this.requireUnlocked(admin);

    const sql = getSqlStore();
    if (!sql) throw new HttpException('数据库未就绪', 503);
    const rec = await sql.get(TABLES.apiToken.tableId, id);
    if (!rec) throw new NotFoundException('令牌不存在');
    const cur = ((rec as unknown as { fields?: Record<string, unknown> }).fields ?? {}) as Record<string, unknown>;

    await sql.update(TABLES.apiToken.tableId, id, {
      状态: STATUS_REVOKED,
      备注: reason ? `${String(cur['备注'] ?? '')}${String(cur['备注'] ?? '') ? ' · ' : ''}吊销原因：${reason}` : String(cur['备注'] ?? ''),
    });
    await this.invalidate(id);

    void this.audit.log({
      actor: admin.name,
      action: '更新',
      module: 'apiTokens',
      recordId: id,
      summary: `吊销 API 令牌「${String(cur['名称'] ?? '')}」（${String(cur['密钥前缀'] ?? '')}…）`,
      detail: reason ? `原因：${reason}` : '',
    });
    return { ok: true };
  }

  // ────────────────────────────────────────────────────────────────
  // 工具
  // ────────────────────────────────────────────────────────────────

  /** 逗号/换行分隔 → 去重数组（前端多选与手填文本都吃） */
  private parseList(v: unknown): string[] {
    if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
    return String(v ?? '')
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  private normalizeModules(v: unknown): string[] {
    const valid = new Set(MODULE_RESOURCES.map((m) => m.key));
    return this.parseList(v).filter((k) => valid.has(k));
  }

  /** 过期时间：必须落在 (now, now+1年]；不传 = 一年后（**默认就给到期，不给永久**） */
  private normalizeExpiry(v: unknown): number {
    const n = Number(v ?? 0);
    const now = Date.now();
    if (!n) return now + MAX_TOKEN_TTL_MS;
    if (n <= now) throw new BadRequestException('过期时间必须晚于当前时间');
    if (n > now + MAX_TOKEN_TTL_MS) throw new BadRequestException('过期时间最长为一年');
    return n;
  }

  /** IP 匹配：支持 `10.0.0.*` 这种段通配（与 AI 网关同一实现思路） */
  private ipMatches(ip: string, pattern: string): boolean {
    const p = pattern.trim();
    if (!p) return true;
    if (p === ip) return true;
    if (p.endsWith('*')) return ip.startsWith(p.slice(0, -1));
    return false;
  }
}
