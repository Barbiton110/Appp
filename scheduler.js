import cron from 'node-cron';
import { DateTime } from 'luxon';
import { db } from './db.js';
import { encrypt, decrypt } from './crypto.js';
import { publishImage, refreshToken } from './instagram.js';
import { publicMediaUrl } from './media.js';
import { cleanupSessions } from './auth.js';

const MAX_ATTEMPTS = 3;
let running = false;

// לוקח פוסטים שהגיע זמנם ומסמן אותם "publishing" באופן אטומי (מונע פרסום כפול)
const claimDue = db.prepare(`
  UPDATE posts SET status = 'publishing'
  WHERE id IN (
    SELECT id FROM posts WHERE status = 'scheduled' AND scheduled_at <= ?
    ORDER BY scheduled_at LIMIT 20
  )
  RETURNING id`);

const loadPost = db.prepare(`
  SELECT p.*, m.filename, a.ig_user_id, a.access_token_enc, a.token_expires_at
  FROM posts p
  JOIN media m ON m.id = p.media_id
  JOIN ig_accounts a ON a.id = p.ig_account_id
  WHERE p.id = ?`);

export async function publishPost(postId) {
  const p = loadPost.get(postId);
  if (!p) return;
  try {
    if (p.token_expires_at < Date.now()) {
      throw new Error('פג תוקף החיבור לאינסטגרם - חברו את החשבון מחדש בהגדרות');
    }
    const result = await publishImage({
      igUserId: p.ig_user_id,
      token: decrypt(p.access_token_enc),
      imageUrl: publicMediaUrl(p.filename),
      caption: p.caption,
    });
    db.prepare(`UPDATE posts SET status='published', ig_media_id=?, published_at=?, error=NULL,
                attempts = attempts + 1 WHERE id=?`).run(result.id, Date.now(), p.id);
    console.log(`[scheduler] post ${p.id} published (${result.id})`);
  } catch (err) {
    const attempts = p.attempts + 1;
    // שגיאות הרשאה/טוקן לא ישתפרו בניסיון חוזר
    const fatal = /token|permission|OAuth|פג תוקף/i.test(err.message);
    if (attempts < MAX_ATTEMPTS && !fatal) {
      db.prepare(`UPDATE posts SET status='scheduled', attempts=?, error=?, scheduled_at=? WHERE id=?`)
        .run(attempts, err.message, Date.now() + attempts * 5 * 60 * 1000, p.id);
    } else {
      db.prepare(`UPDATE posts SET status='failed', attempts=?, error=? WHERE id=?`)
        .run(attempts, err.message, p.id);
    }
    console.error(`[scheduler] post ${p.id} failed (attempt ${attempts}): ${err.message}`);
  }
}

export async function runDue() {
  if (running) return;
  running = true;
  try {
    const ids = claimDue.all(Date.now()).map((r) => r.id);
    for (const id of ids) await publishPost(id);
  } finally {
    running = false;
  }
}

// מרענן טוקנים שיפוג תוקפם בעוד פחות מ-10 ימים
export async function refreshTokens() {
  const soon = Date.now() + 10 * 24 * 3600 * 1000;
  const rows = db.prepare('SELECT * FROM ig_accounts WHERE token_expires_at < ? AND token_expires_at > ?')
    .all(soon, Date.now());
  for (const a of rows) {
    try {
      const t = await refreshToken(decrypt(a.access_token_enc));
      db.prepare('UPDATE ig_accounts SET access_token_enc=?, token_expires_at=? WHERE id=?')
        .run(encrypt(t.accessToken), t.expiresAt, a.id);
      console.log(`[tokens] refreshed @${a.username}`);
    } catch (err) {
      console.error(`[tokens] refresh failed for @${a.username}: ${err.message}`);
    }
  }
}

// מוצא את היום הפנוי הבא (בשעה היומית של המשתמש) עבור "תור יומי"
export function nextQueueSlot(user, igAccountId, reserved = []) {
  const zone = user.timezone || 'Asia/Jerusalem';
  const [hour, minute] = (user.daily_time || '10:00').split(':').map(Number);
  const now = DateTime.now().setZone(zone);
  let slot = now.set({ hour, minute, second: 0, millisecond: 0 });
  if (slot <= now.plus({ minutes: 5 })) slot = slot.plus({ days: 1 });

  const taken = db.prepare(`
    SELECT 1 FROM posts WHERE ig_account_id = ? AND status != 'failed'
    AND scheduled_at >= ? AND scheduled_at < ? LIMIT 1`);

  for (let i = 0; i < 730; i++) {
    const dayStart = slot.startOf('day').toMillis();
    const dayEnd = slot.endOf('day').toMillis();
    const busy = taken.get(igAccountId, dayStart, dayEnd) ||
      reserved.some((t) => t >= dayStart && t <= dayEnd);
    if (!busy) return slot.toMillis();
    slot = slot.plus({ days: 1 });
  }
  throw new Error('לא נמצא יום פנוי בשנתיים הקרובות');
}

export function startScheduler() {
  // פוסטים שנתקעו ב-"publishing" בגלל קריסה: לא מפרסמים שוב אוטומטית (ייתכן שכבר עלו)
  const stuck = db.prepare(`UPDATE posts SET status='failed',
    error='השרת הופעל מחדש באמצע פרסום - בדקו באינסטגרם אם הפוסט עלה ופרסמו מחדש במידת הצורך'
    WHERE status='publishing'`).run();
  if (stuck.changes) console.warn(`[scheduler] marked ${stuck.changes} interrupted posts as failed`);

  cron.schedule('* * * * *', () => runDue().catch((e) => console.error(e)));
  cron.schedule('17 3 * * *', () => {
    refreshTokens().catch((e) => console.error(e));
    cleanupSessions();
  });
  console.log('[scheduler] running (checks every minute)');
}
