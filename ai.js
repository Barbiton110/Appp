// יכולות AI: כיתובים (Claude) ותמונות (OpenAI Images). שתיהן אופציונליות.

export const aiStatus = () => ({
  caption: Boolean(process.env.ANTHROPIC_API_KEY),
  image: Boolean(process.env.OPENAI_API_KEY),
});

export async function generateCaption({ businessName, businessDescription, topic, tone }) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('לא הוגדר ANTHROPIC_API_KEY');

  const system =
    'אתה קופירייטר מומחה לשיווק באינסטגרם לעסקים קטנים. כתוב כיתוב אחד לפוסט: ' +
    'פתיח שתופס תשומת לב, 2-4 משפטים קצרים, קריאה לפעולה, ובסוף 5-10 האשטגים רלוונטיים. ' +
    'כתוב בשפה שבה נכתבה הבקשה (ברירת מחדל: עברית). אל תוסיף הסברים - החזר רק את הכיתוב עצמו. ' +
    'עד 2000 תווים.';

  const user = [
    businessName && `שם העסק: ${businessName}`,
    businessDescription && `על העסק: ${businessDescription}`,
    topic && `נושא הפוסט: ${topic}`,
    tone && `טון: ${tone}`,
  ].filter(Boolean).join('\n') || 'כתוב פוסט שיווקי כללי לעסק.';

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
      max_tokens: 800,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Claude: ${data.error?.message || res.status}`);
  return data.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

export async function generateImage({ prompt, businessDescription }) {
  if (!process.env.OPENAI_API_KEY) throw new Error('לא הוגדר OPENAI_API_KEY');

  const fullPrompt = [
    prompt,
    businessDescription && `Context about the business: ${businessDescription}`,
    'Style: high quality, professional social-media marketing photo, square composition, no text overlays.',
  ].filter(Boolean).join('\n');

  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1',
      prompt: fullPrompt,
      size: '1024x1024',
      n: 1,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`OpenAI: ${data.error?.message || res.status}`);

  const item = data.data?.[0];
  if (item?.b64_json) return Buffer.from(item.b64_json, 'base64');
  if (item?.url) {
    const img = await fetch(item.url);
    return Buffer.from(await img.arrayBuffer());
  }
  throw new Error('OpenAI: לא התקבלה תמונה');
}
