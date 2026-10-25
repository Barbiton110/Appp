// חיבור ל-Instagram API with Instagram Login (Business Login for Instagram)
// דורש חשבון אינסטגרם מקצועי (Business / Creator). לא נדרש דף פייסבוק.

const GRAPH = 'https://graph.instagram.com';
const VER = () => process.env.IG_API_VERSION || 'v26.0';
export const DRY_RUN = () => process.env.IG_DRY_RUN === '1';

export const SCOPES = ['instagram_business_basic', 'instagram_business_content_publish'];

export const redirectUri = () => `${process.env.PUBLIC_BASE_URL}/auth/instagram/callback`;

async function igFetch(url, options = {}) {
  const res = await fetch(url, options);
  let data;
  try { data = await res.json(); } catch { data = {}; }
  if (!res.ok || data.error) {
    const msg = data.error?.message || data.error_message || `HTTP ${res.status}`;
    const err = new Error(`Instagram: ${msg}`);
    err.ig = data.error;
    throw err;
  }
  return data;
}

export function authorizeUrl(state) {
  const p = new URLSearchParams({
    client_id: process.env.IG_APP_ID,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPES.join(','),
    state,
  });
  return `https://www.instagram.com/oauth/authorize?${p}`;
}

// שלב 1: קוד -> טוקן קצר מועד
export async function exchangeCode(code) {
  const body = new URLSearchParams({
    client_id: process.env.IG_APP_ID,
    client_secret: process.env.IG_APP_SECRET,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri(),
    code,
  });
  const data = await igFetch('https://api.instagram.com/oauth/access_token', { method: 'POST', body });
  // התגובה יכולה להגיע כאובייקט או בתוך data[]
  const d = Array.isArray(data.data) ? data.data[0] : data;
  return { accessToken: d.access_token, userId: String(d.user_id) };
}

// שלב 2: טוקן קצר -> טוקן ארוך (כ-60 יום)
export async function toLongLived(shortToken) {
  const p = new URLSearchParams({
    grant_type: 'ig_exchange_token',
    client_secret: process.env.IG_APP_SECRET,
    access_token: shortToken,
  });
  const d = await igFetch(`${GRAPH}/access_token?${p}`);
  return { accessToken: d.access_token, expiresAt: Date.now() + (d.expires_in || 5184000) * 1000 };
}

// רענון טוקן ארוך (אפשרי רק אם הטוקן בן 24 שעות לפחות ועדיין בתוקף)
export async function refreshToken(token) {
  const p = new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: token });
  const d = await igFetch(`${GRAPH}/refresh_access_token?${p}`);
  return { accessToken: d.access_token, expiresAt: Date.now() + (d.expires_in || 5184000) * 1000 };
}

export async function getProfile(token) {
  const p = new URLSearchParams({ fields: 'user_id,username', access_token: token });
  return igFetch(`${GRAPH}/${VER()}/me?${p}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// פרסום תמונה: יצירת container -> המתנה לסטטוס FINISHED -> media_publish
export async function publishImage({ igUserId, token, imageUrl, caption }) {
  if (DRY_RUN()) {
    console.log(`[dry-run] would publish ${imageUrl} to IG user ${igUserId}`);
    await sleep(300);
    return { id: `dry_${Date.now()}` };
  }

  const base = `${GRAPH}/${VER()}/${igUserId}`;
  const container = await igFetch(`${base}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ image_url: imageUrl, caption: caption || '' }),
  });

  // תמונות בדרך כלל מוכנות מיד, אבל בודקים סטטוס ליתר ביטחון
  for (let i = 0; i < 12; i++) {
    const s = await igFetch(
      `${GRAPH}/${VER()}/${container.id}?fields=status_code&access_token=${encodeURIComponent(token)}`
    );
    if (s.status_code === 'FINISHED') break;
    if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') {
      throw new Error(`Instagram: עיבוד המדיה נכשל (${s.status_code})`);
    }
    await sleep(5000);
  }

  return igFetch(`${base}/media_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ creation_id: container.id }),
  });
}
