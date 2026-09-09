import { Inject, Injectable, Logger, HttpException, HttpStatus, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Redis } from 'ioredis';
import { USER_LEVEL_TO_ENGINE, USER_TABLE, type DataLevel, type SessionUser } from '@acms/contracts';
import { getRoleList } from '@acms/domain';
import { toText, toStringArray, type BaseClient } from '@acms/base-adapter';
import { SessionService } from './session.service.js';
import { REDIS } from '../redis.provider.js';
import { BASE_CLIENT } from '../base.provider.js';

const FEISHU_BASE = 'https://open.feishu.cn';

/** 应急登录：连续失败达到该次数即锁定 IP */
const EMERGENCY_MAX_FAILS = 5;
/** 应急登录：失败计数与锁定时长（秒） */
const EMERGENCY_LOCK_SECONDS = 15 * 60;
/** 应急登录未配置 EMERGENCY_ADMIN_OPEN_ID 时使用的虚拟 openId */
const EMERGENCY_DEFAULT_OPEN_ID = 'emergency-admin';

interface FeishuUserInfo {
  code: number;
  msg: string;
  data?: {
    open_id?: string;
    name?: string;
    en_name?: string;
  };
}

/** 飞书 OAuth 2.0 + PKCE S256 + 用户解析 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger('AuthService');

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(BASE_CLIENT) private readonly base: BaseClient,
    private readonly sessions: SessionService,
  ) {}

  private get appId(): string {
    const v = process.env.FEISHU_APP_ID;
    if (!v) throw new Error('FEISHU_APP_ID not configured');
    return v;
  }

  async buildAuthorizeUrl(redirectUri: string): Promise<string> {
    const state = crypto.randomUUID().replace(/-/g, '');
    const verifier = crypto.randomUUID() + crypto.randomUUID();
    const challenge = await this.pkceChallenge(verifier);
    await this.redis.set(`oauth:state:${state}`, verifier, 'EX', 600, 'NX');
    const params = new URLSearchParams({
      client_id: this.appId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: (() => {
        const s = ['auth:user.id:read'];
        if (process.env.FEISHU_DRIVE_SCOPE === '1') s.push('drive:drive', 'calendar:calendar', 'task:task');
        return s.join(' ');
      })(),
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    return `${FEISHU_BASE}/open-apis/authen/v1/index?${params}`;
  }

  /** 换 code → access_token → 用户信息 → 建会话 */
  async handleCallback(code: string, state: string, redirectUri: string): Promise<SessionUser> {
    const key = `oauth:state:${state}`;
    const verifier = await this.redis.get(key);
    if (!verifier) throw new UnauthorizedException('INVALID_STATE');
    await this.redis.del(key);

    const tokenRes = await fetch(`${FEISHU_BASE}/open-apis/authen/v2/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: this.appId,
        client_secret: process.env.FEISHU_APP_SECRET,
        code,
        grant_type: 'authorization_code',
        code_verifier: verifier,
        redirect_uri: redirectUri,
      }),
    });
    const tokenData = (await tokenRes.json()) as {
      code?: number;
      access_token?: string;
      error?: string;
      error_description?: string;
    };
    const accessToken = tokenData.access_token;
    if (!accessToken) {
      throw new UnauthorizedException(
        `OAUTH_TOKEN_FAILED: ${tokenData.error ?? tokenData.code ?? 'unknown'}`,
      );
    }

    // token 响应不含 open_id，需带 token 调 authen/v1/user_info（scope=auth:user.id:read）
    const infoRes = await fetch(`${FEISHU_BASE}/open-apis/authen/v1/user_info`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const info = (await infoRes.json()) as FeishuUserInfo;
    // 注意：user_info 返回结构为 data.open_id（非 data.user.open_id）
    const openId = info.data?.open_id;
    const name = info.data?.name ?? info.data?.en_name ?? '';
    if (info.code !== 0 || !openId) {
      throw new UnauthorizedException('USER_INFO_FAILED');
    }
    const principal = await this.resolvePrincipal(openId, name);

    // 若开启了云盘授权 scope，则把用户的飞书令牌（access/refresh/expires）持久化，
    // 供 AI 以「用户身份」操作其飞书云盘（列目录、移动文件）。未开通权限时不做。
    if (process.env.FEISHU_DRIVE_SCOPE === '1') {
      try {
        const { setUserToken } = await import('../ai/lib/config/userConfigStore.js');
        const td = tokenData as Record<string, any>;
        const refreshToken = td.refresh_token || (td.data && td.data.refresh_token);
        const expiresIn = Number(td.expires_in || (td.data && td.data.expires_in) || 7200);
        setUserToken(openId, {
          accessToken,
          refreshToken: refreshToken || undefined,
          expiresAt: Date.now() + expiresIn * 1000,
        });
      } catch (e) {
        console.warn('[auth] 持久化用户云盘令牌失败:', (e as Error).message);
      }
    }

    return this.sessions.create(principal);
  }

  /** 从系统用户表解析角色/校区/密级；未注册用户拒绝（引导管理员开通） */
  private async resolvePrincipal(
    openId: string,
    name: string,
  ): Promise<Omit<SessionUser, 'sessionId' | 'expiresAt'>> {
    const bootstrapAdmins = (process.env.BOOTSTRAP_ADMIN_OPEN_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    let record: { fields: Record<string, unknown> } | null = null;
    let tableTotal = -1;
    try {
      const res = await this.base.search(USER_TABLE.tableId, {
        pageSize: 1,
        filter: { conjunction: 'and', conditions: [{ field: '飞书 Open ID', value: [openId] }] },
      });
      record = res.items[0] ?? null;
      // 判断用户表是否为空（首登引导用）：无此人时再查全表计数
      if (!record) {
        const all = await this.base.search(USER_TABLE.tableId, { pageSize: 1 });
        tableTotal = all.total;
      }
    } catch {
      // 用户表不可读（权限/建表未完成）时只放行引导管理员
      if (!bootstrapAdmins.includes(openId)) {
        throw new UnauthorizedException('USER_TABLE_UNAVAILABLE');
      }
    }

    if (!record) {
      // 用户表为空 → 首个登录者自动成为系统管理员并建档；否则拒绝
      const isFirstUser = tableTotal === 0;
      // DEV 便捷开关：开启后任何完成 OAuth 的 DEV 用户自动建档为普通内部账号，
      // 无需预先登记 open_id（prod 不设置 ALLOW_SELF_REGISTER 即维持原 NOT_REGISTERED 行为）。
      const allowSelfRegister = ['1', 'true', 'dev'].includes(
        (process.env.ALLOW_SELF_REGISTER ?? '').toLowerCase(),
      );
      if (!isFirstUser && !bootstrapAdmins.includes(openId) && !allowSelfRegister) {
        throw new UnauthorizedException('NOT_REGISTERED');
      }
      const role = isFirstUser ? '系统管理员' : process.env.SELF_REGISTER_ROLE || '教师本人';
      const level = isFirstUser ? 'L4' : process.env.SELF_REGISTER_LEVEL || '内部';
      // 自动建档：系统管理员 / L4（首登）或 SELF_REGISTER_*（自注册普通账号）/ 启用
      try {
        await this.base.create(USER_TABLE.tableId, {
          '飞书 Open ID': openId,
          姓名: name,
          系统角色: [role],
          数据密级上限: level,
          账号状态: '启用',
        });
      } catch {
        // 建档失败不阻断登录（Base 只读时仍可进系统）
      }
      const maxDataLevel = (USER_LEVEL_TO_ENGINE as Record<string, string>)[level] ?? 'L1';
      return { openId, name, roles: [role], campuses: [], maxDataLevel };
    }

    const status = toText(record.fields['账号状态']);
    if (status === '停用') throw new UnauthorizedException('USER_DISABLED');

    // 角色白名单用「有效角色清单」（内置 + 角色管理里配置的自定义角色，启动时加载），
    // 不能用静态 ROLES——否则自定义角色（如 Phase1）会被滤掉，用户会话 roles=[] 全部 403。
    const validRoles = new Set(getRoleList());
    const roles = toStringArray(record.fields['系统角色']).filter((r: string) => validRoles.has(r));
    const campuses = toStringArray(record.fields['默认校区']);
    const levelRaw = toText(record.fields['数据密级上限']) ?? 'L1';
    const maxDataLevel: DataLevel =
      levelRaw in USER_LEVEL_TO_ENGINE ? (USER_LEVEL_TO_ENGINE[levelRaw] ?? 'L1') : 'L1';
    return { openId, name: toText(record.fields['姓名']) || name, roles, campuses, maxDataLevel };
  }

  /**
   * 应急管理员本地登录（飞书不可用时的兜底入口）。
   *
   * 飞书 OAuth 曾是本系统唯一的登录链路：应用被停用、凭据过期或网络不通时，
   * 连系统管理员都进不来，且无法自助恢复。此入口只依赖环境变量，不触碰飞书。
   *
   * 启用条件：配置 `EMERGENCY_ADMIN_PASSWORD`；未配置时直接 401（不消耗失败计数）。
   * 可选 `EMERGENCY_ADMIN_OPEN_ID`：指定以哪个已有用户的 openId 建会话（可复用其数据与授权），
   * 缺省使用虚拟 openId 'emergency-admin'。
   *
   * 防护：同一 IP 连续失败 5 次锁定 15 分钟，成功即清零；成功与失败均记告警日志。
   */
  async emergencyLogin(password: string, ip: string): Promise<SessionUser> {
    const expected = process.env.EMERGENCY_ADMIN_PASSWORD?.trim();
    if (!expected) {
      throw new UnauthorizedException('EMERGENCY_LOGIN_DISABLED');
    }

    const lockKey = `emergency:lock:${ip}`;
    const failKey = `emergency:fail:${ip}`;
    if (await this.redis.get(lockKey)) {
      throw new HttpException('EMERGENCY_LOGIN_LOCKED', HttpStatus.TOO_MANY_REQUESTS);
    }

    // 定长比较，避免通过响应耗时逐字节爆破
    const input = Buffer.from(password);
    const want = Buffer.from(expected);
    if (input.length !== want.length || !timingSafeEqual(input, want)) {
      const fails = await this.redis.incr(failKey);
      await this.redis.expire(failKey, EMERGENCY_LOCK_SECONDS);
      if (fails >= EMERGENCY_MAX_FAILS) {
        await this.redis.set(lockKey, '1', 'EX', EMERGENCY_LOCK_SECONDS);
        this.logger.warn(`应急登录连续失败 ${fails} 次，锁定 IP=${ip} ${EMERGENCY_LOCK_SECONDS}s`);
      } else {
        this.logger.warn(`应急登录失败 IP=${ip}（第 ${fails}/${EMERGENCY_MAX_FAILS} 次）`);
      }
      throw new UnauthorizedException('BAD_CREDENTIALS');
    }

    await this.redis.del(failKey);
    const openId = process.env.EMERGENCY_ADMIN_OPEN_ID?.trim() || EMERGENCY_DEFAULT_OPEN_ID;
    this.logger.warn(`应急管理员登录成功 IP=${ip} openId=${openId}`);
    return this.sessions.create({
      openId,
      name: '应急管理员',
      roles: ['系统管理员'],
      campuses: [],
      maxDataLevel: 'L4',
    });
  }

  async logout(sessionId: string): Promise<void> {
    await this.sessions.destroy(sessionId);
  }

  private async pkceChallenge(verifier: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }
}
