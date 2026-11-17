/**
 * MY CLOSET MINI — stylist server (Cloudflare Worker).
 *
 * Holds the Anthropic API key server-side. The app on the phone sends the closet
 * (descriptions + small photos), the style notes and the request; this worker asks
 * Claude to pick a look from the given items only, and returns item ids.
 *
 * Secrets (set in the Cloudflare dashboard, never in code):
 *   ANTHROPIC_API_KEY — the Anthropic key
 *   APP_PASSWORD      — personal password the app must send
 */
import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-opus-5-5';
const MAX_BODY_BYTES = 25 * 1024 * 1024;
const MAX_ITEMS = 400;
const MAX_INSPIRATION = 8;

const LOOK_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', description: 'false only if no sensible look can be built from the closet' },
    title: { type: 'string', description: 'Short Hebrew title for the look' },
    item_ids: { type: 'array', items: { type: 'string' }, description: 'ids of the chosen closet items, top to bottom' },
    explanation: { type: 'string', description: 'Short Hebrew explanation: why these items work together and for the request' },
    tip: { type: 'string', description: 'Optional short Hebrew styling tip, or empty string' },
  },
  required: ['ok', 'title', 'item_ids', 'explanation', 'tip'],
  additionalProperties: false,
};

const SYSTEM = `את סטייליסטית אישית בתוך האפליקציה MY CLOSET MINI. את עונה תמיד בעברית, בטון חם, קצר ומקצועי.

כללים מחייבים:
- בוחרים פריטים אך ורק מתוך רשימת הבגדים של המשתמשת, לפי ה-id שלהם. אסור להמציא פריטים או להציע לקנות.
- לוק אחד בלבד בכל תשובה, בדרך כלל 2–5 פריטים: בסיס (שמלה, או חלק עליון + חלק תחתון), ואם יש ומתאים — נעליים, שכבה עליונה, תיק או אביזר.
- לא לבחור שני פריטים שממלאים אותו תפקיד (למשל שני מכנסיים, או שמלה יחד עם חצאית), אלא אם זה שכבות הגיוניות.
- להתחשב בסגנון האישי ובתמונות ההשראה, אם צורפו, ובבקשה עצמה (אירוע, מזג אוויר, תחושה).
- פריט שמופיע רק עם תיאור (בלי תמונה) הוא פריט אמיתי לכל דבר.
- אם אין בארון מספיק פריטים כדי להרכיב לוק סביר — ok=false, item_ids ריק, ובהסבר כתבי בעדינות מה חסר.
- ההסבר: 2–3 משפטים. הטיפ: משפט אחד או ריק.`;

function corsHeaders(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const h = { 'Vary': 'Origin' };
  if (origin && allowed.includes(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Content-Type, X-App-Password';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors },
  });
}

async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function parseDataUrl(s) {
  if (typeof s !== 'string') return null;
  const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(s);
  return m ? { media_type: m[1], data: m[2] } : null;
}

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

function buildContent(body) {
  const content = [];
  const text = (t) => content.push({ type: 'text', text: t });

  // 1) Closet — stable part first so it can be cached between requests.
  text(`הארון של המשתמשת (${body.items.length} פריטים). כל פריט מסומן ב-id שלו:`);
  for (const it of body.items) {
    const line = `id: ${it.id} | קטגוריה: ${it.category} | תיאור: ${it.description || '(אין תיאור — ראי תמונה)'}`;
    const img = parseDataUrl(it.image);
    if (img) {
      text(line);
      content.push({ type: 'image', source: { type: 'base64', ...img } });
    } else {
      text(line + ' | (אין תמונה)');
    }
  }

  // 2) Style notes and inspiration.
  if (body.style) text(`הסגנון האישי של המשתמשת, במילים שלה:\n${body.style}`);
  if (body.inspiration.length) {
    text('תמונות השראה שהמשתמשת אוהבת (לכיוון סגנוני בלבד — הן לא פריטים בארון):');
    for (const s of body.inspiration) content.push({ type: 'image', source: { type: 'base64', ...s } });
  }

  // 3) The request itself.
  const parts = [`תאריך היום: ${body.today}.`];
  if (body.mode === 'swap') {
    parts.push(`הלוק הנוכחי (ids): ${body.look.join(', ')}.`);
    parts.push(`המשתמשת ביקשה להחליף את הפריט ${body.swapItemId}. החזירי את הלוק המלא מחדש, עם פריט אחר מהארון במקומו (לא ${body.swapItemId}), ושמרי את שאר הפריטים אם הם עדיין מתאימים.`);
    if (body.excluded.length) parts.push(`פריטים שהיא כבר דחתה בלוק הזה, אל תחזירי אותם: ${body.excluded.join(', ')}.`);
  }
  if (body.anchorItemId) parts.push(`הלוק חייב לכלול את הפריט ${body.anchorItemId}.`);
  parts.push(`הבקשה: ${body.request || 'תעשי לי לוק'}`);
  text(parts.join('\n'));
  return content;
}

async function askClaude(env, content) {
  const client = new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    maxRetries: 2,
    timeout: 120000,
    ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}), // local testing only
  });
  const params = {
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM,
    cache_control: { type: 'ephemeral' },
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: LOOK_SCHEMA } },
    messages: [{ role: 'user', content }],
  };
  try {
    // Server-side fallback: if the model declines, the API retries on a fallback model.
    return await client.beta.messages.create({
      ...params,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
  } catch (err) {
    if (err instanceof Anthropic.BadRequestError) return await client.messages.create(params);
    throw err;
  }
}

function validate(raw) {
  if (!raw || typeof raw !== 'object') return 'בקשה לא תקינה';
  if (!Array.isArray(raw.items) || raw.items.length === 0) return 'הארון ריק';
  if (raw.items.length > MAX_ITEMS) return 'יותר מדי פריטים';
  return null;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const cors = corsHeaders(origin, env);
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (url.pathname === '/health') {
      return json({ ok: true, configured: Boolean(env.ANTHROPIC_API_KEY && env.APP_PASSWORD) }, 200, cors);
    }
    if (url.pathname !== '/stylist' || request.method !== 'POST') return json({ error: 'not_found' }, 404, cors);

    if (!env.ANTHROPIC_API_KEY || !env.APP_PASSWORD) {
      return json({ error: 'not_configured', message: 'השרת עוד לא הוגדר: חסר מפתח או סיסמה.' }, 503, cors);
    }
    const pw = request.headers.get('X-App-Password') || '';
    if (!pw || !(await safeEqual(pw, env.APP_PASSWORD))) {
      return json({ error: 'bad_password', message: 'הסיסמה של הסטייליסטית לא נכונה.' }, 401, cors);
    }
    const len = Number(request.headers.get('Content-Length') || 0);
    if (len > MAX_BODY_BYTES) return json({ error: 'too_large', message: 'הבקשה גדולה מדי.' }, 413, cors);

    let raw;
    try { raw = await request.json(); } catch { return json({ error: 'bad_json', message: 'בקשה לא תקינה.' }, 400, cors); }
    const problem = validate(raw);
    if (problem) return json({ error: 'bad_request', message: problem }, 400, cors);

    const items = raw.items
      .filter((it) => it && typeof it.id === 'string')
      .map((it) => ({ id: str(it.id, 80), category: str(it.category, 40), description: str(it.description, 1500), image: it.image }));
    const ids = new Set(items.map((i) => i.id));
    const mode = raw.mode === 'swap' ? 'swap' : 'new';
    const look = Array.isArray(raw.look) ? raw.look.filter((id) => ids.has(id)) : [];
    const swapItemId = ids.has(raw.swapItemId) ? raw.swapItemId : null;
    if (mode === 'swap' && (!swapItemId || look.length === 0)) {
      return json({ error: 'bad_request', message: 'חסר הלוק או הפריט להחלפה.' }, 400, cors);
    }
    const body = {
      mode,
      items,
      look,
      swapItemId,
      excluded: Array.isArray(raw.excluded) ? raw.excluded.filter((id) => ids.has(id)).slice(0, 50) : [],
      anchorItemId: ids.has(raw.anchorItemId) ? raw.anchorItemId : null,
      request: str(raw.request, 1000),
      style: str(raw.style, 6000),
      today: str(raw.today, 40) || new Date().toISOString().slice(0, 10),
      inspiration: (Array.isArray(raw.inspiration) ? raw.inspiration : []).map(parseDataUrl).filter(Boolean).slice(0, MAX_INSPIRATION),
    };

    let msg;
    try {
      msg = await askClaude(env, buildContent(body));
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) {
        return json({ error: 'bad_key', message: 'המפתח של Claude לא תקין. צריך לבדוק אותו ב-Cloudflare.' }, 502, cors);
      }
      if (err instanceof Anthropic.RateLimitError) {
        return json({ error: 'rate_limited', message: 'יותר מדי בקשות כרגע. נסי שוב בעוד דקה.' }, 429, cors);
      }
      if (err instanceof Anthropic.APIError) {
        const credit = err.status === 400 && /credit|balance/i.test(String(err.message));
        return json({
          error: credit ? 'no_credit' : 'api_error',
          message: credit ? 'נגמר הקרדיט בחשבון Anthropic.' : 'הסטייליסטית לא הצליחה לענות. נסי שוב.',
          status: err.status,
        }, 502, cors);
      }
      return json({ error: 'server_error', message: 'תקלה זמנית. נסי שוב.' }, 502, cors);
    }

    if (msg.stop_reason === 'refusal') {
      return json({ error: 'refusal', message: 'הסטייליסטית לא יכלה לענות על הבקשה הזו. נסי לנסח אחרת.' }, 422, cors);
    }
    const textBlock = msg.content.find((b) => b.type === 'text');
    let out;
    try { out = JSON.parse(textBlock ? textBlock.text : ''); } catch {
      return json({ error: 'bad_output', message: 'התשובה לא התקבלה כמו שצריך. נסי שוב.' }, 502, cors);
    }

    const chosen = [...new Set((out.item_ids || []).filter((id) => ids.has(id)))];
    if (mode === 'swap' && chosen.includes(swapItemId)) chosen.splice(chosen.indexOf(swapItemId), 1);
    return json({
      ok: Boolean(out.ok) && chosen.length > 0,
      title: str(out.title, 120),
      item_ids: chosen,
      explanation: str(out.explanation, 1500),
      tip: str(out.tip, 500),
      usage: {
        input_tokens: msg.usage?.input_tokens ?? 0,
        output_tokens: msg.usage?.output_tokens ?? 0,
        cache_read_input_tokens: msg.usage?.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: msg.usage?.cache_creation_input_tokens ?? 0,
      },
    }, 200, cors);
  },
};
