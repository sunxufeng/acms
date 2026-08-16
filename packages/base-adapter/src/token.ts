export interface FeishuConfig {
  appId: string;
  appSecret: string;
  baseUrl?: string;
}

const FEISHU_BASE = 'https://open.feishu.cn';

interface TokenCache {
  token: string;
  expireAt: number;
}

/** tenant_access_token 获取与缓存（提前 60s 刷新） */
export class TokenManager {
  private cache: TokenCache | null = null;

  constructor(private readonly cfg: FeishuConfig) {}

  async getToken(): Promise<string> {
    if (this.cache && Date.now() < this.cache.expireAt - 60_000) {
      return this.cache.token;
    }
    const res = await fetch(`${this.cfg.baseUrl ?? FEISHU_BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.cfg.appId, app_secret: this.cfg.appSecret }),
    });
    const data = (await res.json()) as { code: number; msg: string; tenant_access_token?: string; expire?: number };
    if (data.code !== 0 || !data.tenant_access_token) {
      throw new Error(`feishu token error ${data.code}: ${data.msg}`);
    }
    this.cache = {
      token: data.tenant_access_token,
      expireAt: Date.now() + (data.expire ?? 7200) * 1000,
    };
    return this.cache.token;
  }
}
