import { join } from 'node:path';
import { createJsonStore } from '../ai/lib/config/jsonStore.js';
import { encryptSecret, decryptSecret } from '../ai/lib/crypto/kms.js';

/**
 * 得到大脑（Get笔记）用户凭证存储。
 *
 * ⚠️ 为什么按用户分开存：
 * 官方文档明确 **Client ID 是应用级的、API Key 是用户级的**（「个人开发在『API Key』
 * 创建 Key；企业代授权走 OAuth」）。所以 API Key 必须一人一份 —— 全员共用一份不只
 * 是「归属不对」，更要命的是**限流是按 Key 算的**（QPS 2 / 每天 5000 次），
 * 一个 Key 给全校用，几个人同时查就撞墙。
 *
 * Client ID 仍留在 .env（应用级，全局一份），见 GetnoteService.credFor()。
 *
 * ⚠️ 为什么存文件而不是飞书用户表：
 * 1. 不用改生产数据结构（改表要 dry-run + 确认 + 写入 + 验证，风险高）
 * 2. 加密基建现成：复用 AI 模块的 KMS（ACAILY_MASTER_KEY 信封加密），
 *    密钥体系统一，生产 .env 一行都不用加主密钥
 * 3. 生产落点配 GETNOTE_CRED_STORE 指向 /opt/acms/data/ 下（仓库外），
 *    部署只删 dist 与 .next，不会覆盖
 */

const STORE =
  process.env.GETNOTE_CRED_STORE || join(process.cwd(), 'data', 'getnote-credentials.json');

interface StoredCred {
  /** KMS 信封密文（encryptSecret 返回的对象），明细文落盘 */
  apiKeyEnc?: unknown;
  displayName?: string;
  /** 最后更新时间 */
  updatedAt?: string;
  /** 最后一次验活通过的时间；存 Key 时会先打一次 API 验证 */
  verifiedAt?: string;
}

interface CredDb {
  users: Record<string, StoredCred>;
}

const db = createJsonStore(STORE, { users: {} } as CredDb) as {
  load: () => CredDb;
  persist: () => void;
  invalidate: () => void;
};

function load(): CredDb {
  const c = db.load();
  if (!c.users) c.users = {};
  return c;
}

/** 掩码展示：只留前 7 位（形如 gk_live）与后 4 位，中间打星 */
function mask(key: string): string {
  const k = String(key ?? '').trim();
  if (k.length <= 11) return k ? '****' : '';
  return `${k.slice(0, 7)}****${k.slice(-4)}`;
}

export interface CredentialStatus {
  configured: boolean;
  masked: string;
  updatedAt: string;
  verifiedAt: string;
}

/** 当前用户的凭证状态（不含任何明文/密文） */
export function getCredentialStatus(openId: string): CredentialStatus {
  const c = load().users[openId];
  if (!c?.apiKeyEnc) return { configured: false, masked: '', updatedAt: '', verifiedAt: '' };
  let masked = '';
  try {
    masked = mask(decryptSecret(c.apiKeyEnc));
  } catch {
    // 主密钥轮换或数据损坏时解密会抛。这时当作「已配置但不可用」，
    // 让用户重填即可，不要把异常抛到接口上。
    masked = '';
  }
  return {
    configured: true,
    masked,
    updatedAt: c.updatedAt ?? '',
    verifiedAt: c.verifiedAt ?? '',
  };
}

/** 内部用：解出明文 API Key。未配置返回 null。 */
export function getApiKey(openId: string): string | null {
  const c = load().users[openId];
  if (!c?.apiKeyEnc) return null;
  try {
    const k = decryptSecret(c.apiKeyEnc);
    return k ? String(k) : null;
  } catch {
    return null;
  }
}

/** 写入（覆盖）用户的 API Key。调用方应先用 verifyKey() 验活。 */
export function setCredential(
  openId: string,
  apiKey: string,
  opts: { displayName?: string; verified?: boolean } = {},
): CredentialStatus {
  const d = load();
  const prev = d.users[openId] ?? {};
  const now = new Date().toISOString();
  d.users[openId] = {
    ...prev,
    apiKeyEnc: encryptSecret(String(apiKey).trim()),
    displayName: opts.displayName ?? prev.displayName,
    updatedAt: now,
    verifiedAt: opts.verified === false ? prev.verifiedAt : now,
  };
  db.persist();
  return getCredentialStatus(openId);
}

export function deleteCredential(openId: string): boolean {
  const d = load();
  if (!d.users[openId]) return false;
  delete d.users[openId];
  db.persist();
  return true;
}
