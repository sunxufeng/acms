import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Redis } from 'ioredis';
import { MODULE_RESOURCES, TABLES, type SessionUser } from '@acms/contracts';
import { getSqlStore } from '../base.provider.js';
import { REDIS } from '../redis.provider.js';
import { AuthService } from '../auth/auth.service.js';
import { SessionService } from '../auth/session.service.js';
import { HighRiskGateService, GATE_UNLOCK_TTL_SECONDS } from '../auth/high-risk-gate.js';
import { UsersService } from '../user/user.service.js';

/**
 * 身份模拟（Impersonation）—— 2026-09-16 新增，系统管理员排障用。
 *
 * 用途：管理员以任意账号的身份浏览 ACMS，用来回答「他为什么看不到这条数据」这类
 * 权限 / 数据范围问题，而不是靠猜配置。
 *
 * ⚠️ 这是风险等级最高的功能之一：模拟会话拿到的是**目标用户的完整数据视野**。
 * 因此四条防线缺一不可：
 *   ① 必须是已登录的系统管理员（服务端硬校验 roles，不信前端）
 *   ② 二次密码（默认值写在源码里 ⇒ 防的是误操作，不是攻击）
 *   ③ 同 IP 连续失败 5 次锁 15 分钟
 *   ④ 进入 / 退出 / 解锁失败全部落「身份模拟记录表」
 *
 * 设计要点（都是踩过的坑，改之前先读）：
 *  - 模拟 = **另建一个会话 + 换 Cookie**，管理员原会话保留并续期 ⇒ 退出能回到原身份。
 *    原会话若被销毁或过期，"退出模拟"会变成"被登出"。
 *  - 会话身份**必须**走 `AuthService.resolvePrincipal()`（用户表 → 角色/校区/密级的唯一口径）。
 *    自己拼会漏掉「有效角色清单过滤」与校区规则，校区算错 ⇒ 模拟进去一条数据都看不到。
 *  - 建会话时 `recordLogin:false`（模拟不是登录，否则污染「活跃时段统计」）、
 *    `indexByOpenid:false`（否则会覆盖目标用户真实会话的反向索引，强制下线会打错人）。
 */

/** 建表用的字段 type（与飞书 Base / 生产 `acms_fields` 实测口径一致） */
const T = { TEXT: 1, NUMBER: 2, SELECT: 3 } as const;
type FieldDef = { name: string; type: number; property?: unknown };
const sel = (...names: string[]): FieldDef['property'] => ({ options: names.map((name) => ({ name })) });

/**
 * 解锁凭证有效期：10 分钟（刷新页面不用重输，超时回落到密码屏）。
 * 实际实现已抽到 `HighRiskGateService`（与 API 令牌管理共用同一套密码闸），
 * 这里保留别名，避免既有引用断裂。
 */
export const UNLOCK_TTL_SECONDS = GATE_UNLOCK_TTL_SECONDS;
/** 模拟会话时长：30 分钟（短于常规 1 小时，降低"忘记自己在模拟态"的风险） */
export const IMPERSONATE_TTL_SECONDS = 1800;
const ADMIN_ROLE = '系统管理员';

/** 解锁结果：密码错与锁定时**不抛异常**，返回 200 + 结构体 —— 前端要拿到剩余次数才能提示 */
export type UnlockResult =
  | { ok: true; expiresIn: number }
  | { ok: false; code: 'BAD_PASSWORD'; fails: number; remaining: number }
  | { ok: false; code: 'LOCKED'; lockedSeconds: number };

export interface ImpersonateUserRow {
  openId: string;
  name: string;
  teacherType: string;
  campus: string;
  roles: string[];
  status: string;
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

export interface EnterResult {
  target: { openId: string; name: string; roles: string[]; campus: string };
  expiresIn: number;
}

export interface ExitResult {
  /** 恢复出来的管理员会话 id；null = 原会话已过期，需要重新登录 */
  adminSessionId: string | null;
}

@Injectable()
export class ImpersonateService {
  private readonly logger = new Logger('Impersonate');

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly users: UsersService,
    /** 二次密码闸（与 API 令牌管理共用；scope='impersonate' 与后者互不影响） */
    private readonly gate: HighRiskGateService,
  ) {}

  // ── 建表 ───────────────────────────────────────────────────────────

  /** 启动期幂等建表（通用 CRUD 不建表；漏了会导致记录写入静默失败） */
  async ensureTables(): Promise<void> {
    const sql = getSqlStore();
    if (!sql) {
      this.logger.warn('[impersonate] 未配置 DATABASE_URL，跳过建表（模拟记录不可查）');
      return;
    }
    await sql.ensureTable(TABLES.impersonateLog.tableId, TABLES.impersonateLog.name, [
      // 存毫秒时间戳（NUMBER）而不是 DATE：读取端自己做格式化，不受时区口径影响
      { name: '操作时间', type: T.NUMBER, property: { formatter: '0' } },
      { name: '动作', type: T.SELECT, property: sel('进入', '退出', '解锁失败') },
      { name: '操作人', type: T.TEXT },
      { name: '操作人OpenID', type: T.TEXT },
      { name: '目标用户', type: T.TEXT },
      { name: '目标OpenID', type: T.TEXT },
      { name: 'IP', type: T.TEXT },
      { name: '详情', type: T.TEXT },
    ]);
    this.logger.log('[impersonate] 身份模拟记录表已就绪');
  }

  // ── 权限与状态校验 ─────────────────────────────────────────────────

  private requireAdmin(user: SessionUser): void {
    if (!user?.roles?.includes(ADMIN_ROLE)) throw new ForbiddenException('ADMIN_ONLY');
  }

  /**
   * 模拟态下不允许再模拟：会让"谁在操作"变成糊涂账，也造出无法追溯的会话链。
   *
   * ⚠️ 本方法必须在 `requireAdmin` **之前**调用。原因：模拟会话的角色是**目标用户**的，
   * 绝大多数情况不含「系统管理员」，若先判 requireAdmin 会返回 ADMIN_ONLY ——
   * 前端于是显示"仅系统管理员可用"，而真正的原因是"你正在模拟中"。
   * 同一件事给出错误的原因，排查成本立刻翻倍。（2026-09-16 线上实测踩到）
   */
  private denyIfImpersonating(user: SessionUser): void {
    if (user?.impersonatedBy) throw new ForbiddenException('IMPERSONATE_NESTED_DENIED');
  }

  /**
   * 校验解锁凭证（列表 / 进入都要过这一关，密码没输对就不该看到任何账号）。
   *
   * ⚠️ 这里刻意用 **403 而不是 401**：前端的 `request()` 把 401 一律当成「未登录」并
   * 强制跳 `/login` —— 用一个 401 会让"解锁超时"表现成"被登出"，用户会以为掉线了。
   * 403 + 明确的 message 让页面自己回到密码屏。
   */
  private async requireUnlocked(user: SessionUser): Promise<void> {
    if (!(await this.gate.isUnlocked('impersonate', user.openId))) {
      throw new ForbiddenException('IMPERSONATE_UNLOCK_REQUIRED');
    }
  }

  // ── ① 解锁 ─────────────────────────────────────────────────────────

  /**
   * 校验二次密码。成功则发放解锁凭证（Redis，10 分钟）。
   *
   * 密码错 / 被锁定**不抛 HTTP 异常**，直接返回结构体：前端需要 `remaining`
   * 才能显示"还可以尝试 2 次"，抛异常会把这个信息埋在错误体里、还得解析。
   */
  async unlock(user: SessionUser, password: string, ip: string): Promise<UnlockResult> {
    this.denyIfImpersonating(user);
    this.requireAdmin(user);

    // 定长比较 + 同 IP 失败锁定 + 解锁凭证，全部委托 HighRiskGateService
    // （与 API 令牌管理共用同一套实现；scope 隔离，解锁其一不会解锁另一个）
    return this.gate.unlock('impersonate', user.openId, password, ip, ({ fails, locked }) => {
      void this.log(
        { openId: user.openId, name: user.name },
        '',
        '解锁失败',
        ip,
        locked ? `连续失败 ${fails} 次，已锁定` : `第 ${fails} 次`,
      );
    });
  }

  /** 主动锁定（页面上的「立即锁定」）：删掉解锁凭证即可 */
  async lock(user: SessionUser): Promise<{ ok: true }> {
    this.denyIfImpersonating(user);
    this.requireAdmin(user);
    await this.gate.lockScope('impersonate', user.openId);
    return { ok: true };
  }

  /**
   * 模块白名单的候选项（Phase 2）。
   *
   * 清单来自 `MODULE_RESOURCES` 这个**单一真源** —— 不在前端硬编码一份，
   * 否则以后新增模块时白名单会静默缺项（用户勾不到自己想要的模块）。
   */
  listModuleOptions(user: SessionUser): { key: string; label: string }[] {
    this.requireAdmin(user);
    return MODULE_RESOURCES.map((m) => ({ key: m.key, label: m.label })).sort((a, b) =>
      a.label.localeCompare(b.label, 'zh-CN'),
    );
  }

  // ── ② 列账号 ───────────────────────────────────────────────────────

  async listUsers(user: SessionUser): Promise<ImpersonateListResult> {
    this.denyIfImpersonating(user);
    this.requireAdmin(user);
    await this.requireUnlocked(user);
    const rows = await this.users.listForImpersonation();
    const enterable = rows.filter((r) => r.canEnter).length;
    return {
      users: rows,
      total: rows.length,
      enterable,
      disabled: rows.length - enterable,
      currentOpenId: user.openId,
    };
  }

  // ── ③ 进入模拟 ─────────────────────────────────────────────────────

  /**
   * 以 `targetOpenId` 的身份建模拟会话。
   *
   * 返回新的会话 id，由 controller 写进 Cookie（覆盖 `acms_sid`）。
   * **不销毁管理员原会话**，只把 sid 存进 `impersonate:return:<新sid>`，退出时换回来。
   */
  async enter(
    user: SessionUser,
    adminSid: string,
    targetOpenId: string,
    ip: string,
    limits: { readOnly?: boolean; modules?: string[] } = {},
  ): Promise<{ sessionId: string; result: EnterResult }> {
    this.denyIfImpersonating(user);
    this.requireAdmin(user);
    await this.requireUnlocked(user);

    const target = String(targetOpenId ?? '').trim();
    if (!target) throw new BadRequestException('TARGET_REQUIRED');
    if (target === user.openId) throw new BadRequestException('TARGET_IS_SELF');

    // 复用与页面**同一份**清单做资格判定，避免"页面能点、接口拒绝"的不一致
    const rows = await this.users.listForImpersonation();
    const row = rows.find((r) => r.openId === target);
    if (!row) throw new NotFoundException('TARGET_NOT_FOUND');
    if (!row.canEnter) throw new BadRequestException(`TARGET_NOT_ALLOWED:${row.reason}`);

    // 身份的唯一口径：与飞书登录链路走同一个 resolvePrincipal()
    const principal = await this.auth.resolvePrincipal(row.openId, row.name);

    // 限制项（Phase 2）：只读 / 模块白名单。写进会话，由 SessionGuard 统一拦截。
    const modules = (limits.modules ?? []).map((x) => String(x)).filter(Boolean);
    const readOnly = !!limits.readOnly;

    const session = await this.sessions.create(
      {
        ...principal,
        impersonatedBy: { openId: user.openId, name: user.name },
        ...(readOnly || modules.length ? { impersonation: { readOnly, modules } } : {}),
      },
      IMPERSONATE_TTL_SECONDS,
      { recordLogin: false, indexByOpenid: false },
    );

    // 记住「从哪来」；同时把管理员原会话续到满 —— 否则模拟久了回来已过期，
    // 用户看到的现象就是"退出模拟把我自己登出了"。
    await this.redis.set(
      this.returnKey(session.sessionId),
      adminSid,
      'EX',
      IMPERSONATE_TTL_SECONDS,
    );
    const keepAlive = Math.max(Number(process.env.SESSION_TTL_SECONDS ?? 3600), IMPERSONATE_TTL_SECONDS);
    try {
      await this.sessions.refresh(adminSid, keepAlive);
    } catch {
      /* 原会话不存在时忽略：退出会走「已过期」分支提示重新登录 */
    }

    this.logger.warn(
      `身份模拟进入：${user.name}（${user.openId}）→ ${row.name}（${row.openId}）IP=${ip}`,
    );
    void this.log(
      { openId: user.openId, name: user.name },
      row.name,
      '进入',
      ip,
      `目标 ${row.openId} · 角色 ${row.roles.join('、') || '（空）'} · 校区 ${row.campus || '（空）'}` +
        (readOnly ? ' · 只读' : '') +
        (modules.length ? ` · 限定模块 ${modules.join('/')}` : ''),
      row.openId,
    );

    return {
      sessionId: session.sessionId,
      result: {
        target: { openId: row.openId, name: row.name, roles: row.roles, campus: row.campus },
        expiresIn: IMPERSONATE_TTL_SECONDS,
      },
    };
  }

  // ── ④ 退出模拟 ─────────────────────────────────────────────────────

  /**
   * 销毁模拟会话并把 Cookie 换回管理员原会话。
   *
   * 原会话已过期时返回 `adminSessionId: null`（controller 清 Cookie）——
   * 诚实报错并销毁模拟会话，不留下悬空会话，也不隐式提权。
   */
  async exit(user: SessionUser, sid: string, ip: string): Promise<ExitResult> {
    const by = user.impersonatedBy;
    if (!by) throw new BadRequestException('NOT_IMPERSONATING');

    const adminSid = await this.redis.get(this.returnKey(sid));
    await this.redis.del(this.returnKey(sid));
    // 销毁模拟会话（SessionService.destroy 不会动 openid 反向索引，见那里的注释）
    await this.sessions.destroy(sid);

    const admin = adminSid ? await this.sessions.get(adminSid) : null;
    this.logger.warn(
      `身份模拟退出：${by.name}（${by.openId}）← ${user.name}（${user.openId}）IP=${ip}` +
        (admin ? '' : ' · 管理员原会话已过期'),
    );
    void this.log(
      { openId: by.openId, name: by.name },
      user.name,
      '退出',
      ip,
      admin ? `目标 ${user.openId}` : `目标 ${user.openId} · 管理员原会话已过期`,
      user.openId,
    );

    return { adminSessionId: admin ? adminSid : null };
  }

  // ── ⑤ 模拟历史（Phase 2）──────────────────────────────────────────

  /**
   * 模拟记录查询（只读审计）。
   *
   * **不需要二次密码**：它是纯只读的历史留痕，越方便查越好；
   * 而「以他人身份进入」才需要密码。两者风险完全不同，不该共用一个门禁。
   *
   * 读的是「身份模拟记录表」，字段在 jsonb 里（`data->>'动作'`），
   * 所以这里内存过滤而不走 SQL 条件 —— 量级（每次进出两条）完全撑得住。
   */
  async listLogs(
    user: SessionUser,
    opts: { action?: string; actor?: string; target?: string; from?: string; to?: string; limit?: number } = {},
  ): Promise<{
    rows: {
      id: string;
      at: number;
      action: string;
      actor: string;
      target: string;
      ip: string;
      detail: string;
    }[];
    total: number;
    actions: string[];
  }> {
    this.requireAdmin(user);
    const sql = getSqlStore();
    if (!sql) return { rows: [], total: 0, actions: [] };

    const all: { id: string; at: number; action: string; actor: string; target: string; ip: string; detail: string }[] = [];
    const PAGE = 500;
    let tok: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      // 分页用 pageToken（ListOptions 没有 offset —— 2026-09-16 实测）
      const res = (await sql.search(TABLES.impersonateLog.tableId, {
        pageSize: PAGE,
        ...(tok ? { pageToken: tok } : {}),
      })) as unknown as { items?: unknown[]; hasMore?: boolean; pageToken?: string };
      const items = res?.items ?? [];
      for (const raw of items) {
        const r = raw as { recordId?: string; id?: string; fields?: Record<string, unknown> };
        const f = r.fields ?? {};
        all.push({
          id: String(r.recordId ?? r.id ?? ''),
          at: Number(f['操作时间']) || 0,
          action: String(f['动作'] ?? ''),
          actor: String(f['操作人'] ?? ''),
          target: String(f['目标用户'] ?? ''),
          ip: String(f['IP'] ?? ''),
          detail: String(f['详情'] ?? ''),
        });
      }
      tok = res?.hasMore ? res.pageToken : undefined;
      if (!tok) break;
    }
    all.sort((a, b) => b.at - a.at);

    const kw = (s: string) => s.trim().toLowerCase();
    const fromMs = opts.from ? new Date(`${opts.from}T00:00:00`).getTime() : -Infinity;
    const toMs = opts.to ? new Date(`${opts.to}T23:59:59.999`).getTime() : Infinity;
    const filtered = all.filter((r) => {
      if (opts.action && r.action !== opts.action) return false;
      if (opts.actor && !r.actor.toLowerCase().includes(kw(opts.actor))) return false;
      if (opts.target && !r.target.toLowerCase().includes(kw(opts.target))) return false;
      if (r.at < fromMs || r.at > toMs) return false;
      return true;
    });
    const limit = Math.min(2000, Math.max(1, Number(opts.limit) || 500));
    return {
      rows: filtered.slice(0, limit),
      total: filtered.length,
      actions: [...new Set(all.map((r) => r.action).filter(Boolean))],
    };
  }

  private returnKey(sid: string): string {
    return `impersonate:return:${sid}`;
  }

  // ── 留痕 ───────────────────────────────────────────────────────────

  /**
   * 写「身份模拟记录表」。fire-and-forget —— 留痕失败绝不能影响主流程。
   *
   * 注意与审计日志的分工：审计日志记**业务写操作**（含模拟标记，见 AuditService.log），
   * 这里记**模拟进出本身**。两者合起来才答得全"谁在什么时候以谁的身份做了什么"。
   */
  private async log(
    actor: { openId: string; name: string },
    targetName: string,
    action: '进入' | '退出' | '解锁失败',
    ip: string,
    detail: string,
    targetOpenId = '',
  ): Promise<void> {
    try {
      const sql = getSqlStore();
      if (!sql) return;
      await sql.create(TABLES.impersonateLog.tableId, {
        操作时间: Date.now(),
        动作: action,
        操作人: actor.name || actor.openId || '',
        操作人OpenID: actor.openId ?? '',
        目标用户: targetName,
        目标OpenID: targetOpenId,
        IP: ip,
        详情: detail,
      });
    } catch (e) {
      this.logger.error(`身份模拟记录写入失败: ${(e as Error).message}`);
    }
  }
}
