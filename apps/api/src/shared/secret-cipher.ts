/**
 * 外接系统凭证（App Secret 等）的加密存储与掩码回显。
 * ──────────────────────────────────────────────────────────────
 * 开放平台要保存 App ID / App Secret 这类第三方凭证。明文落库风险太高
 * （有库权限的人直接能看、备份文件里也是明文），所以：
 *  - 写入：AES-256-GCM 加密后存
 *  - 读取：一律回显掩码 `******`，前端改了才覆盖
 *
 * 为什么零依赖：生产 node_modules 对新增包不保证可解析
 * （曾因 import express 导致 API MODULE_NOT_FOUND 起不来），一律用 node:crypto。
 *
 * 密钥来源：优先 `CREDENTIAL_KEY` 环境变量；未配置时从 `DATABASE_URL` 派生
 * （保证不配也能跑，但换库会解不开旧数据 —— 生产应显式配置 CREDENTIAL_KEY）。
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const PREFIX = 'enc1';

/** 掩码：表单回显与列表展示都用这个值，前端原样回传表示「不修改」 */
export const SECRET_MASK = '******';

let cachedKey: Buffer | null = null;
let warned = false;

function secretKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.CREDENTIAL_KEY?.trim();
  if (!raw && !warned) {
    warned = true;
    console.warn(
      '[secret-cipher] 未配置 CREDENTIAL_KEY，密钥改由 DATABASE_URL 派生（更换数据库后旧凭证将解不开，建议显式配置）',
    );
  }
  cachedKey = createHash('sha256')
    .update(raw || process.env.DATABASE_URL || 'acms-credential-default')
    .digest();
  return cachedKey;
}

/** 加密明文，返回 `enc1.<iv>.<tag>.<data>`（全部 base64url）。空串原样返回。 */
export function encryptSecret(plain: string): string {
  const text = String(plain ?? '');
  if (!text) return '';
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, secretKey(), iv);
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString('base64url'), tag.toString('base64url'), data.toString('base64url')].join('.');
}

/**
 * 解密。任何异常（未加密的历史值 / 密钥变更 / 格式损坏）都返回空串，
 * 绝不让凭证解析失败把整个接口打挂。
 */
export function decryptSecret(stored: string): string {
  const v = String(stored ?? '');
  if (!v.startsWith(PREFIX + '.')) return '';
  const parts = v.split('.');
  if (parts.length !== 4) return '';
  try {
    const [, ivB64, tagB64, dataB64] = parts as [string, string, string, string];
    const decipher = createDecipheriv(ALGO, secretKey(), Buffer.from(ivB64, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

/** 是否掩码占位（前端回传掩码 = 不修改） */
export function isSecretMask(v: unknown): boolean {
  return String(v ?? '').trim() === SECRET_MASK;
}

/** 是否已是加密串（避免重复加密） */
export function isEncrypted(v: unknown): boolean {
  return String(v ?? '').startsWith(PREFIX + '.');
}

/** 读取侧统一回显：有值 → 掩码，无值 → 空串 */
export function maskSecret(stored: unknown): string {
  const v = String(stored ?? '');
  if (!v) return '';
  return isSecretMask(v) ? SECRET_MASK : SECRET_MASK;
}
