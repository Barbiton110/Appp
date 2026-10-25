import crypto from 'node:crypto';

// הצפנת טוקנים של אינסטגרם במסד הנתונים (AES-256-GCM)
const rawKey = process.env.ENCRYPTION_KEY;
if (!rawKey || rawKey === 'change-me-to-a-long-random-string') {
  console.warn('[security] ENCRYPTION_KEY לא הוגדר - הגדירו מחרוזת אקראית ארוכה בקובץ .env');
}
const KEY = crypto.createHash('sha256').update(rawKey || 'dev-insecure-key').digest();

export function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, enc].map((b) => b.toString('base64')).join('.');
}

export function decrypt(payload) {
  const [iv, tag, enc] = payload.split('.').map((s) => Buffer.from(s, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');
