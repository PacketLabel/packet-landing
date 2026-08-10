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

function json(statusCode, obj) {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) };
}
