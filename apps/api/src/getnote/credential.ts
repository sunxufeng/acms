import { join } from 'node:path';
import { createJsonStore } from '../ai/lib/config/jsonStore.js';
import { encryptSecret, decryptSecret } from '../ai/lib/crypto/kms.js';

/**
 * 得到大脑（Get笔记）用户凭证存储。
 *
 * ⚠️ 为什么按用户分开存：
 * 官方限流是**按 API Key 算**的（QPS 2 / 每天 5000 次）。一份 Key 给全校用，
 * 几个人同时查就撞墙。而且笔记是私人数据，本就不该共享凭证。
 *
 * ⚠️ Client ID 为什么也 per-user（2026-09-05 二次修正）：
 * 官方「5 分钟快速上手」写明「创建应用 → 获取 Client ID **和** API Key」—— 两者是
 * 用户建应用时成对拿到的。所以不存在「应用级全局一份」的强约束，让用户两个都填
 * 即可完全自助，不用管理员介入。早期版本把 Client ID 塞进 .env，导致你不配就整页
 * 阻塞在「请联系管理员」，用户干等着 —— 这个设计已废弃。
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
  /** Client ID 同样加密存（虽非机密，但与 Key 成对，一起管理最省心） */
  clientIdEnc?: unknown;
  displayName?: string;
  /** 最后更新时间 */
  updatedAt?: string;
  /** 最后一次验活通过的时间；存 Key 时会先打一次 API 验证 */
  verifiedAt?: string;
  /** 凭证来源：manual 手动填入 / oauth 设备授权 */
  source?: 'manual' | 'oauth';
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

/**
 * 掩码展示：只留可识别的前缀与后 4 位。
 * gk_live_9d3f2a7b → gk_live****2a7b；cli_8f2a1c9b4d → cli****9b4d
 * ⚠️ 不要按固定长度切前缀 —— cli_ 后面跟着的是应用 ID，截多了等于泄露。
 */
function mask(v: string): string {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (s.length <= 8) return '****';
  const head = s.startsWith('gk_live') ? 'gk_live' : s.startsWith('cli') ? 'cli' : s.slice(0, 3);
  return `${head}****${s.slice(-4)}`;
}

export interface CredentialStatus {
  configured: boolean;
  masked: string;
  clientIdMasked: string;
  updatedAt: string;
  verifiedAt: string;
  source: 'manual' | 'oauth' | '';
}

function read(enc: unknown): string {
  if (!enc) return '';
  try {
    return String(decryptSecret(enc) ?? '');
  } catch {
    // 主密钥轮换或数据损坏时解密会抛。当作「已配置但不可用」，让用户重填即可
    return '';
  }
}

/** 当前用户的凭证状态（不含任何明文/密文） */
export function getCredentialStatus(openId: string): CredentialStatus {
  const c = load().users[openId];
  if (!c?.apiKeyEnc) {
    return { configured: false, masked: '', clientIdMasked: '', updatedAt: '', verifiedAt: '', source: '' };
  }
  return {
    configured: true,
    masked: mask(read(c.apiKeyEnc)),
    clientIdMasked: mask(read(c.clientIdEnc)),
    updatedAt: c.updatedAt ?? '',
    verifiedAt: c.verifiedAt ?? '',
    source: c.source ?? '',
  };
}

/**
 * 内部用：解出可直接发请求的凭证对。缺任何一个都返回 null。
 *
 * 返回值里 clientId 可能为空串（老用户只存过 Key 的场景），调用方按缺失处理。
 */
export function getCredentialPair(openId: string): { key: string; clientId: string } | null {
  const c = load().users[openId];
  if (!c?.apiKeyEnc) return null;
  const key = read(c.apiKeyEnc);
  if (!key) return null;
  return { key, clientId: read(c.clientIdEnc) };
}

/** 写入（覆盖）用户凭证。调用方应先用真实请求验活。 */
export function setCredential(
  openId: string,
  apiKey: string,
  clientId: string,
  opts: { displayName?: string; verified?: boolean; source?: 'manual' | 'oauth' } = {},
): CredentialStatus {
  const d = load();
  const prev = d.users[openId] ?? {};
  const now = new Date().toISOString();
  d.users[openId] = {
    ...prev,
    apiKeyEnc: encryptSecret(String(apiKey).trim()),
    clientIdEnc: encryptSecret(String(clientId ?? '').trim()),
    displayName: opts.displayName ?? prev.displayName,
    updatedAt: now,
    verifiedAt: opts.verified === false ? prev.verifiedAt : now,
    source: opts.source ?? prev.source ?? 'manual',
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
