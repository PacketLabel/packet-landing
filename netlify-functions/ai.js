// ============================================================
// Packet — Netlify Function: ai
// From the AXRIK starter kit under licence. Kit v1.1.0, unchanged
// except for these comments — improvements here go back to the kit.
// ============================================================
// Keeps the Anthropic key server-side. POST { system, prompt,
// max_tokens } -> { text }. Every AI feature in the admin routes
// through this one endpoint rather than each getting its own.
//
// Graceful degradation: if the key is missing or the call fails it
// returns { fallback: true } so the front-end quietly uses a built-in
// template instead of erroring. ALWAYS pair an AI feature with a
// non-AI fallback — nobody should ever see a broken button because
// an environment variable was not set.
//
// SETUP (one-off): Netlify -> site -> Environment variables ->
//   ANTHROPIC_API_KEY = <key from console.anthropic.com>
// No npm dependencies — native fetch (Netlify Node 18+).
// ============================================================

const MODEL = 'claude-haiku-4-5-20251001'; // cheap and fast; bump for harder tasks

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return json(503, { error: 'AI not configured', fallback: true });

  // Who is asking. Added 29 September 2026: until then this endpoint
  // answered anyone on the internet who found it, on Packet's Anthropic
  // key. Now it answers two kinds of caller and nobody else:
  //   - Phil or Scott (an owner or staff login), from the admin page
  //   - Packet's own scheduled functions, which send the service key
  // A brand login is refused, and so is everyone without a login. They
  // get { fallback: true }, the same as a missing key, so no page ever
  // shows a broken button because of this.
  if (!(await allowed(event))) return json(401, { error: 'Not allowed', fallback: true });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const system    = (body.system || '').toString().slice(0, 4000);
  const prompt    = (body.prompt || '').toString().slice(0, 6000);
  const maxTokens = Math.min(Math.max(parseInt(body.max_tokens, 10) || 600, 64), 1500);
  if (!prompt) return json(400, { error: 'Missing prompt' });

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        ...(system ? { system } : {}),
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!resp.ok) {
      console.error('Anthropic API error', resp.status, await resp.text());
      return json(502, { error: 'AI request failed', fallback: true });
    }

    const data = await resp.json();
    const text = (data.content || [])
      .filter(b => b.type === 'text').map(b => b.text).join('').trim();

    if (!text) return json(502, { error: 'Empty AI response', fallback: true });
    return json(200, { text });
  } catch (err) {
    console.error('ai function error', err);
    return json(502, { error: 'AI request failed', fallback: true });
  }
};

async function allowed(event) {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return false;

  const auth = event.headers.authorization || event.headers.Authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return false;

  if (sameSecret(token, serviceKey)) return true;

  try {
    const resp = await fetch(url + '/auth/v1/user', {
      headers: { apikey: serviceKey, authorization: 'Bearer ' + token }
    });
    if (!resp.ok) return false;
    const user = await resp.json();
    if (!user || !user.id) return false;
    const pr = await fetch(url + '/rest/v1/user_profiles?select=role&id=eq.' + user.id, {
      headers: { apikey: serviceKey, authorization: 'Bearer ' + serviceKey }
    });
    const rows = await pr.json();
    return !!(rows && rows[0] && ['owner', 'staff'].indexOf(rows[0].role) > -1);
  } catch (err) {
    console.error('ai authorise failed', err);
    return false;
  }
}

// Compares without leaking how much of the secret matched.
function sameSecret(a, b) {
  const crypto = require('crypto');
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function json(statusCode, obj) {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) };
}
