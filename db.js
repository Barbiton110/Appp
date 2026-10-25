import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
export const MEDIA_DIR = path.join(DATA_DIR, 'media');
fs.mkdirSync(MEDIA_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, 'app.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  business_name TEXT DEFAULT '',
  business_description TEXT DEFAULT '',
  timezone TEXT NOT NULL DEFAULT 'Asia/Jerusalem',
  daily_time TEXT NOT NULL DEFAULT '10:00',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ig_accounts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ig_user_id TEXT NOT NULL,
  username TEXT,
  access_token_enc TEXT NOT NULL,
  token_expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, ig_user_id)
);

CREATE TABLE IF NOT EXISTS media (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  source TEXT NOT NULL,           -- 'upload' | 'ai'
  prompt TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ig_account_id INTEGER NOT NULL REFERENCES ig_accounts(id) ON DELETE CASCADE,
  media_id INTEGER NOT NULL REFERENCES media(id),
  caption TEXT DEFAULT '',
  scheduled_at INTEGER NOT NULL,  -- epoch ms (UTC)
  status TEXT NOT NULL DEFAULT 'scheduled', -- scheduled | publishing | published | failed
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  ig_media_id TEXT,
  published_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_posts_due ON posts(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_posts_user ON posts(user_id, scheduled_at);
`);
