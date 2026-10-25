import express from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { db } from './db.js';
import { randomToken } from './crypto.js';

const SESSION_DAYS = 30;
const SECURE_COOKIE = (process.env.PUBLIC_BASE_URL || '').startsWith('https://');

function setSessionCookie(res, token) {
  res.cookie('sid', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: SECURE_COOKIE,
    maxAge: SESSION_DAYS * 24 * 3600 * 1000,
  });
}

function createSession(userId) {
  const token = randomToken();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .run(token, userId, Date.now() + SESSION_DAYS * 24 * 3600 * 1000);
  return token;
}

// מצרף את המשתמש המחובר ל-req.user (אם יש)
export function loadUser(req, _res, next) {
  const token = req.cookies?.sid;
  if (token) {
    const row = db.prepare(`
      SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ? AND s.expires_at > ?`).get(token, Date.now());
    if (row) {
      delete row.password_hash;
      req.user = row;
    }
  }
  next();
}

export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'יש להתחבר' });
  next();
}

export const authRouter = express.Router();
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30 });

authRouter.post('/register', limiter, (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const businessName = String(req.body.business_name || '').trim().slice(0, 120);
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'אימייל לא תקין' });
  if (password.length < 8) return res.status(400).json({ error: 'הסיסמה חייבת להכיל לפחות 8 תווים' });
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    return res.status(409).json({ error: 'האימייל כבר רשום' });
  }
  const hash = bcrypt.hashSync(password, 10);
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO users (email, password_hash, business_name, created_at) VALUES (?, ?, ?, ?)'
  ).run(email, hash, businessName, Date.now());
  setSessionCookie(res, createSession(lastInsertRowid));
  res.json({ ok: true });
});

authRouter.post('/login', limiter, (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(String(req.body.password || ''), user.password_hash)) {
    return res.status(401).json({ error: 'אימייל או סיסמה שגויים' });
  }
  setSessionCookie(res, createSession(user.id));
  res.json({ ok: true });
});

authRouter.post('/logout', (req, res) => {
  if (req.cookies?.sid) db.prepare('DELETE FROM sessions WHERE token = ?').run(req.cookies.sid);
  res.clearCookie('sid');
  res.json({ ok: true });
});

export function cleanupSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}
