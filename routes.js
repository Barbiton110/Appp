import express from 'express';
import { DateTime } from 'luxon';
import { db } from './db.js';
import { encrypt, randomToken } from './crypto.js';
import { requireUser } from './auth.js';
import { upload, processAndSave, mediaUrl } from './media.js';
import * as ig from './instagram.js';
import { aiStatus, generateCaption, generateImage } from './ai.js';
import { nextQueueSlot, publishPost } from './scheduler.js';

export const api = express.Router();
export const igAuth = express.Router();

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- פרופיל ----------
api.get('/me', requireUser, (req, res) => {
  res.json({ user: req.user, ai: aiStatus(), dryRun: ig.DRY_RUN(), igConfigured: Boolean(process.env.IG_APP_ID) });
});

api.put('/me', requireUser, (req, res) => {
  const { business_name, business_description, timezone, daily_time } = req.body;
  if (timezone && !DateTime.now().setZone(timezone).isValid) {
    return res.status(400).json({ error: 'אזור זמן לא תקין' });
  }
  if (daily_time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(daily_time)) {
    return res.status(400).json({ error: 'שעה לא תקינה' });
  }
  db.prepare(`UPDATE users SET
      business_name = COALESCE(?, business_name),
      business_description = COALESCE(?, business_description),
      timezone = COALESCE(?, timezone),
      daily_time = COALESCE(?, daily_time)
    WHERE id = ?`).run(
    business_name?.slice(0, 120) ?? null,
    business_description?.slice(0, 2000) ?? null,
    timezone ?? null,
    daily_time ?? null,
    req.user.id
  );
  res.json({ ok: true });
});

// ---------- חשבונות אינסטגרם ----------
api.get('/accounts', requireUser, (req, res) => {
  const rows = db.prepare(
    'SELECT id, ig_user_id, username, token_expires_at FROM ig_accounts WHERE user_id = ? ORDER BY id'
  ).all(req.user.id);
  res.json(rows);
});

api.delete('/accounts/:id', requireUser, (req, res) => {
  db.prepare('DELETE FROM ig_accounts WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// חשבון דמו לבדיקה במצב IG_DRY_RUN בלי אפליקציית Meta
api.post('/accounts/demo', requireUser, (req, res) => {
  if (!ig.DRY_RUN()) return res.status(400).json({ error: 'זמין רק במצב בדיקה (IG_DRY_RUN=1)' });
  db.prepare(`INSERT OR IGNORE INTO ig_accounts
    (user_id, ig_user_id, username, access_token_enc, token_expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(
    req.user.id, `demo_${req.user.id}`, 'demo_account', encrypt('demo'),
    Date.now() + 60 * 24 * 3600 * 1000, Date.now()
  );
  res.json({ ok: true });
});

igAuth.get('/instagram', requireUser, (req, res) => {
  if (!process.env.IG_APP_ID) return res.status(500).send('IG_APP_ID לא הוגדר בשרת');
  const state = randomToken(16);
  res.cookie('ig_state', state, { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60 * 1000 });
  res.redirect(ig.authorizeUrl(state));
});

igAuth.get('/instagram/callback', requireUser, wrap(async (req, res) => {
  const { code, state, error_description } = req.query;
  if (error_description) return res.redirect(`/?ig_error=${encodeURIComponent(error_description)}`);
  if (!state || state !== req.cookies.ig_state) return res.status(400).send('state לא תקין - נסו שוב');
  res.clearCookie('ig_state');

  // אינסטגרם מוסיף לפעמים "#_" לקוד
  const short = await ig.exchangeCode(String(code).replace(/#_$/, ''));
  const long = await ig.toLongLived(short.accessToken);
  const profile = await ig.getProfile(long.accessToken);
  const igUserId = String(profile.user_id || short.userId);

  db.prepare(`INSERT INTO ig_accounts (user_id, ig_user_id, username, access_token_enc, token_expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, ig_user_id) DO UPDATE SET
      username = excluded.username,
      access_token_enc = excluded.access_token_enc,
      token_expires_at = excluded.token_expires_at`
  ).run(req.user.id, igUserId, profile.username, encrypt(long.accessToken), long.expiresAt, Date.now());

  res.redirect('/?connected=1');
}));

// ---------- מדיה ----------
api.post('/media', requireUser, upload.array('images', 10), wrap(async (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: 'לא נבחרו תמונות' });
  const saved = [];
  for (const f of req.files) saved.push(await processAndSave(f.buffer, req.user.id));
  res.json(saved);
}));

// ---------- AI ----------
api.post('/ai/caption', requireUser, wrap(async (req, res) => {
  const caption = await generateCaption({
    businessName: req.user.business_name,
    businessDescription: req.user.business_description,
    topic: String(req.body.topic || '').slice(0, 500),
    tone: String(req.body.tone || '').slice(0, 100),
  });
  res.json({ caption });
}));

api.post('/ai/image', requireUser, wrap(async (req, res) => {
  const prompt = String(req.body.prompt || '').trim().slice(0, 1000);
  if (!prompt) return res.status(400).json({ error: 'כתבו תיאור לתמונה' });
  const buf = await generateImage({ prompt, businessDescription: req.user.business_description });
  res.json(await processAndSave(buf, req.user.id, { source: 'ai', prompt }));
}));

// ---------- פוסטים ----------
const ownAccount = (userId, accountId) =>
  db.prepare('SELECT * FROM ig_accounts WHERE id = ? AND user_id = ?').get(accountId, userId);
const ownMedia = (userId, mediaId) =>
  db.prepare('SELECT * FROM media WHERE id = ? AND user_id = ?').get(mediaId, userId);

api.get('/posts', requireUser, (req, res) => {
  const rows = db.prepare(`
    SELECT p.id, p.caption, p.scheduled_at, p.status, p.error, p.published_at, p.ig_media_id,
           m.filename, a.username, a.id AS ig_account_id
    FROM posts p JOIN media m ON m.id = p.media_id JOIN ig_accounts a ON a.id = p.ig_account_id
    WHERE p.user_id = ? ORDER BY p.scheduled_at DESC LIMIT 500`).all(req.user.id);
  res.json(rows.map((r) => ({ ...r, image_url: mediaUrl(r.filename) })));
});

// יצירת פוסט אחד או יותר.
// body: { ig_account_id, media_ids: [..], caption, mode: 'datetime'|'queue', scheduled_at (ISO) }
// במצב datetime עם כמה תמונות: כל תמונה נוספת מתוזמנת יום אחרי הקודמת.
api.post('/posts', requireUser, (req, res) => {
  const { ig_account_id, caption = '', mode = 'datetime', scheduled_at } = req.body;
  const mediaIds = (req.body.media_ids || []).map(Number).filter(Boolean);

  if (!ownAccount(req.user.id, ig_account_id)) return res.status(400).json({ error: 'בחרו חשבון אינסטגרם' });
  if (!mediaIds.length) return res.status(400).json({ error: 'בחרו לפחות תמונה אחת' });
  if (mediaIds.some((id) => !ownMedia(req.user.id, id))) return res.status(400).json({ error: 'תמונה לא נמצאה' });
  if (caption.length > 2200) return res.status(400).json({ error: 'הכיתוב ארוך מ-2,200 תווים' });
  if ((caption.match(/#[^\s#]+/g) || []).length > 30) return res.status(400).json({ error: 'מותר עד 30 האשטגים' });

  const times = [];
  if (mode === 'queue') {
    for (let i = 0; i < mediaIds.length; i++) times.push(nextQueueSlot(req.user, ig_account_id, times));
  } else {
    const start = Date.parse(scheduled_at);
    if (Number.isNaN(start)) return res.status(400).json({ error: 'תאריך ושעה לא תקינים' });
    if (start < Date.now() - 60 * 1000) return res.status(400).json({ error: 'הזמן שנבחר כבר עבר' });
    mediaIds.forEach((_, i) => times.push(start + i * 24 * 3600 * 1000));
  }

  const insert = db.prepare(`INSERT INTO posts (user_id, ig_account_id, media_id, caption, scheduled_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`);
  const created = db.transaction(() =>
    mediaIds.map((mid, i) => ({
      id: Number(insert.run(req.user.id, ig_account_id, mid, caption, times[i], Date.now()).lastInsertRowid),
      scheduled_at: times[i],
    }))
  )();
  res.json(created);
});

const ownPost = (userId, id) => db.prepare('SELECT * FROM posts WHERE id = ? AND user_id = ?').get(id, userId);

api.put('/posts/:id', requireUser, (req, res) => {
  const p = ownPost(req.user.id, req.params.id);
  if (!p) return res.status(404).json({ error: 'לא נמצא' });
  if (!['scheduled', 'failed'].includes(p.status)) return res.status(400).json({ error: 'אי אפשר לערוך פוסט שכבר פורסם' });

  const caption = req.body.caption ?? p.caption;
  if (caption.length > 2200) return res.status(400).json({ error: 'הכיתוב ארוך מ-2,200 תווים' });
  let when = p.scheduled_at;
  if (req.body.scheduled_at) {
    when = Date.parse(req.body.scheduled_at);
    if (Number.isNaN(when) || when < Date.now() - 60 * 1000) return res.status(400).json({ error: 'זמן לא תקין' });
  }
  // עריכה של פוסט שנכשל מחזירה אותו לתור
  db.prepare(`UPDATE posts SET caption=?, scheduled_at=?, status='scheduled', attempts=0, error=NULL WHERE id=?`)
    .run(caption, when, p.id);
  res.json({ ok: true });
});

api.delete('/posts/:id', requireUser, (req, res) => {
  const p = ownPost(req.user.id, req.params.id);
  if (!p) return res.status(404).json({ error: 'לא נמצא' });
  if (p.status === 'publishing') return res.status(400).json({ error: 'הפוסט באמצע פרסום' });
  db.prepare('DELETE FROM posts WHERE id = ?').run(p.id);
  res.json({ ok: true });
});

api.post('/posts/:id/publish-now', requireUser, wrap(async (req, res) => {
  const p = ownPost(req.user.id, req.params.id);
  if (!p) return res.status(404).json({ error: 'לא נמצא' });
  const claimed = db.prepare(`UPDATE posts SET status='publishing', attempts=0
    WHERE id=? AND status IN ('scheduled','failed')`).run(p.id);
  if (!claimed.changes) return res.status(400).json({ error: 'הפוסט כבר פורסם או בפרסום' });
  await publishPost(p.id);
  res.json(db.prepare('SELECT status, error, ig_media_id FROM posts WHERE id=?').get(p.id));
}));
