import multer from 'multer';
import sharp from 'sharp';
import path from 'node:path';
import fs from 'node:fs/promises';
import { db, MEDIA_DIR } from './db.js';
import { randomToken } from './crypto.js';

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 10 },
  fileFilter: (_req, file, cb) =>
    /^image\/(jpeg|png|webp|heic|heif)$/.test(file.mimetype)
      ? cb(null, true)
      : cb(new Error('סוג קובץ לא נתמך - העלו JPG / PNG / WEBP')),
});

// אינסטגרם מקבל JPEG ביחס גובה-רוחב בין 4:5 (0.8) ל-1.91:1.
// חותכים למרכז אם התמונה חורגת, ומקטינים לרוחב 1440 לכל היותר.
const MIN_RATIO = 0.8;
const MAX_RATIO = 1.91;

export async function processAndSave(buffer, userId, { source = 'upload', prompt = null } = {}) {
  // מיישרים לפי EXIF קודם, כדי שהממדים יהיו נכונים
  const { data: rotated, info } = await sharp(buffer, { failOn: 'none' })
    .rotate()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  let img = sharp(rotated);

  const ratio = width / height;
  if (ratio < MIN_RATIO) {
    const h = Math.round(width / MIN_RATIO);
    img = img.extract({ left: 0, top: Math.round((height - h) / 2), width, height: h });
  } else if (ratio > MAX_RATIO) {
    const w = Math.round(height * MAX_RATIO);
    img = img.extract({ left: Math.round((width - w) / 2), top: 0, width: w, height });
  }

  const out = await img
    .resize({ width: 1440, withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();

  // שם קובץ אקראי ולא ניתן לניחוש (התמונה חייבת להיות ציבורית עבור אינסטגרם)
  const filename = `${randomToken(16)}.jpg`;
  await fs.writeFile(path.join(MEDIA_DIR, filename), out);

  const { lastInsertRowid } = db.prepare(
    'INSERT INTO media (user_id, filename, source, prompt, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, filename, source, prompt, Date.now());

  return { id: Number(lastInsertRowid), filename, url: mediaUrl(filename) };
}

export const mediaUrl = (filename) => `/media/${filename}`;
export const publicMediaUrl = (filename) => `${process.env.PUBLIC_BASE_URL}/media/${filename}`;
