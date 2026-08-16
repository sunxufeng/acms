import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { SessionUser } from '@acms/contracts';
import { SessionService } from './session.service.js';
import { REDIS } from '../redis.provider.js';

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

    // M0：角色暂按默认（无角色）；M1 接用户表后按表内角色/校区/密级解析
    return this.sessions.create({
      openId,
      name: info.data?.user?.name ?? '',
      roles: [],
      campuses: [],
      maxDataLevel: 'L1',
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
