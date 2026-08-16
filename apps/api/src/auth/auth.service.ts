import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { DATA_LEVEL_RANK, ROLES, USER_TABLE, type DataLevel, type SessionUser } from '@acms/contracts';
import { toText, toStringArray, type BaseClient } from '@acms/base-adapter';
import { SessionService } from './session.service.js';
import { REDIS } from '../redis.provider.js';
import { BASE_CLIENT } from '../base.provider.js';

const FEISHU_BASE = 'https://open.feishu.cn';

interface UserInfoResp {
  code: number;
  msg: string;
  data?: {
    user?: { open_id?: string; name?: string };
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

  private get redirectUri(): string {
    return process.env.FEISHU_REDIRECT_URI ?? 'http://localhost:3000/api/v1/auth/callback';
  }

  async buildAuthorizeUrl(): Promise<string> {
    const state = crypto.randomUUID().replace(/-/g, '');
    const verifier = crypto.randomUUID() + crypto.randomUUID();
    const challenge = await this.pkceChallenge(verifier);
    await this.redis.set(`oauth:state:${state}`, verifier, 'EX', 600, 'NX');
    const params = new URLSearchParams({
      client_id: this.appId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    return `${FEISHU_BASE}/open-apis/authen/v1/index?${params}`;
  }

  /** 换 code → access_token → 用户信息 → 建会话 */
  async handleCallback(code: string, state: string): Promise<SessionUser> {
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
        redirect_uri: this.redirectUri,
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

    const infoRes = await fetch(`${FEISHU_BASE}/open-apis/authen/v1/user_info`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const info = (await infoRes.json()) as UserInfoResp;
    const openId = info.data?.user?.open_id;
    if (info.code !== 0 || !openId) {
      throw new UnauthorizedException('USER_INFO_FAILED');
    }
    const name = info.data?.user?.name ?? '';
    const principal = await this.resolvePrincipal(openId, name);
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
        filter: { conditions: [{ field: 'Open ID', value: [openId] }] },
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
      if (!isFirstUser && !bootstrapAdmins.includes(openId)) {
        throw new UnauthorizedException('NOT_REGISTERED');
      }
      // 自动建档：系统管理员 / L4 / 启用
      try {
        await this.base.create(USER_TABLE.tableId, {
          'Open ID': openId,
          姓名: name,
          系统角色: ['系统管理员'],
          数据密级上限: 'L4',
          状态: '启用',
        });
      } catch {
        // 建档失败不阻断登录（Base 只读时仍可进系统）
      }
      return { openId, name, roles: ['系统管理员'], campuses: [], maxDataLevel: 'L4' };
    }

    const status = toText(record.fields['状态']);
    if (status === '停用') throw new UnauthorizedException('USER_DISABLED');

    const roles = toStringArray(record.fields['系统角色']).filter((r: string) =>
      (ROLES as readonly string[]).includes(r),
    );
    const campuses = toStringArray(record.fields['校区']);
    const levelRaw = toText(record.fields['数据密级上限']) ?? 'L1';
    const maxDataLevel: DataLevel = levelRaw in DATA_LEVEL_RANK ? (levelRaw as DataLevel) : 'L1';
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
