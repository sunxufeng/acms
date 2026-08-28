import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/**
 * 邮件账户密码加密（AES-256-GCM）。
 * 密钥由环境变量 MAIL_CRED_KEY 派生（scrypt → 32 字节），避免把明文口令落库。
 * 存储格式：base64( iv(12B) ‖ authTag(16B) ‖ ciphertext )
 */
const ALGO = 'aes-256-gcm';
const SALT = 'acms-mail-archive-v1';

function deriveKey(): Buffer {
  const pass = process.env.MAIL_CRED_KEY;
  if (!pass) throw new Error('MAIL_CRED_KEY 未配置，无法加解密邮件账户密码');
  return scryptSync(pass, SALT, 32);
}

export function encryptCredential(plain: string): string {
  if (!plain) return '';
  const key = deriveKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decryptCredential(cipherB64: string): string {
  if (!cipherB64) return '';
  let buf: Buffer;
  try {
    buf = Buffer.from(cipherB64, 'base64');
  } catch {
    return '';
  }
  if (buf.length < 28) return ''; // 12 + 16 + 最少 1 字节
  const key = deriveKey();
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  try {
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

/** 列表/详情中用于遮罩已存密码的占位符 */
export const PASSWORD_MASK = '********';
