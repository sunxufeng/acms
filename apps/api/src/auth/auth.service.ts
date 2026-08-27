import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { ROLES, USER_LEVEL_TO_ENGINE, USER_TABLE, type DataLevel, type SessionUser } from '@acms/contracts';
import { toText, toStringArray, type BaseClient } from '@acms/base-adapter';
import { SessionService } from './session.service.js';
import { REDIS } from '../redis.provider.js';
import { BASE_CLIENT } from '../base.provider.js';

const FEISHU_BASE = 'https://open.feishu.cn';

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
      scope: ['auth:user.id:read', ...(process.env.FEISHU_DRIVE_SCOPE === '1' ? ['drive:drive'] : [])].join(' '),
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

    const roles = toStringArray(record.fields['系统角色']).filter((r: string) =>
      (ROLES as readonly string[]).includes(r),
    );
    const campuses = toStringArray(record.fields['默认校区']);
    const levelRaw = toText(record.fields['数据密级上限']) ?? 'L1';
    const maxDataLevel: DataLevel =
      levelRaw in USER_LEVEL_TO_ENGINE ? (USER_LEVEL_TO_ENGINE[levelRaw] ?? 'L1') : 'L1';
    return { openId, name: toText(record.fields['姓名']) || name, roles, campuses, maxDataLevel };
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
