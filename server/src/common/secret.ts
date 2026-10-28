import * as crypto from 'crypto';

/** 加密密钥：优先 SETTINGS_SECRET，其次 JWT_SECRET。部署时务必在 .env 里设置。 */
function key(): Buffer {
  const base = process.env.SETTINGS_SECRET || process.env.JWT_SECRET || 'zupu-scan-local-dev-secret-change-me';
  return crypto.createHash('sha256').update(base).digest();
}

export function encryptSecret(plain: string): string {
  if (!plain) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return 'v1:' + Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decryptSecret(stored: string): string {
  if (!stored) return '';
  if (!stored.startsWith('v1:')) return stored;
  try {
    const raw = Buffer.from(stored.slice(3), 'base64');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const enc = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

export function maskSecret(plain: string): string {
  if (!plain) return '';
  return '••••' + plain.slice(-4);
}

/** 给第三方取图用的签名链接 */
export function signPath(p: string, expiresAt: number): string {
  return crypto.createHmac('sha256', key()).update(`${p}|${expiresAt}`).digest('hex').slice(0, 32);
}
