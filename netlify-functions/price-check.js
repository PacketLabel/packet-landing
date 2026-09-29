// ============================================================
// Packet — Netlify Function: price-check
// Built from the AXRIK starter kit under licence. Kit v1.1.0.
// ============================================================
// Answers one question about one product find: what does this
// already sell for in the UK, and is our cost below it?
//
// Written 7 September 2026 after Supplier 008, where three of four
// AppScenic suppliers turned out to cost more than the same goods
// sell for in ordinary shops. The check that found that is
// mechanical, so it belongs here rather than in somebody's evening.
//
// TWO ROUTES, CHEAPEST FIRST
//   1. Shopify. If the find's link points at a Shopify store, the
//      product's own price is one public request away. Free, exact,
//      no AI, no key. Roughly a third of finds land here.
//   2. AI web search. Everything else. Costs money per check, so it
//      only runs when route 1 has nothing, and only when a key is
//      set. Without a key the function still works — it records
//      'not_found', which is honest, rather than failing.
//
// THE RULE: never write a price that did not come from a fetched
// page. Every row stores its sources. See 012_price_checks.sql.
//
// SETUP: Netlify -> Environment variables ->
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   ANTHROPIC_API_KEY   (optional — route 2 only)
// POST { find_id } with an owner/staff bearer token.
// No npm dependencies — native fetch (Netlify Node 18+).
// ============================================================

const MODEL           = 'claude-sonnet-4-5-20250929'; // search needs the judgement
const REQUEST_TIMEOUT = 15000;
const MAX_SOURCES     = 8;
const UA = 'PacketSourcing/1.0 (+https://packetlabel.com; price research; contact info@packetlabel.com)';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const url        = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return json(503, { error: 'Supabase not configured' });

  if (!(await authorise(event, url, serviceKey))) return json(401, { error: 'Not authorised' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const findId = (body.find_id || '').toString();
  if (!/^[0-9a-f-]{36}$/i.test(findId)) return json(400, { error: 'Missing or malformed find_id' });

  const db = restClient(url, serviceKey);

  let find;
  try {
    const rows = await db.select('product_finds',
      'select=id,title,url,cost_minor,cost_currency,pack_quantity&id=eq.' + findId);
    find = rows && rows[0];
  } catch (err) {
    console.error('could not read the find', err);
    return json(500, { error: 'Could not read that find' });
  }
  if (!find) return json(404, { error: 'No such find' });

  // ---- our cost, restated in GBP --------------------------------
  let fx = { rate: 1, asOf: null };
  if (find.cost_minor != null && find.cost_currency && find.cost_currency !== 'GBP') {
    fx = await gbpRate(find.cost_currency);
  }
  const costPence = (find.cost_minor == null || fx.rate == null)
    ? null
    : Math.round(find.cost_minor * fx.rate);

  // ---- route 1: the shop's own price ----------------------------
  let result = await shopifyPrice(find.url);

  // ---- route 2: web search, only if route 1 found nothing -------
  if (!result && process.env.ANTHROPIC_API_KEY) {
    result = await aiPrice(find.title, find.url);
  }

  // ---- write it down --------------------------------------------
  const row = {
    find_id: findId,
    method: result ? result.method : (process.env.ANTHROPIC_API_KEY ? 'ai' : 'shopify'),
    uk_lowest_pence: result ? result.lowestPence : null,
    uk_seller: result ? result.seller : null,
    uk_url: result ? result.url : null,
    cost_pence: costPence,
    fx_rate: fx.rate,
    fx_as_of: fx.asOf,
    sources: result ? result.sources.slice(0, MAX_SOURCES) : [],
    note: result ? result.note : (process.env.ANTHROPIC_API_KEY
      ? 'Nothing found. Generic goods often have no comparable listing, which is not the same as no competition.'
      : 'No search key set, and the link is not a Shopify shop. Check this one by hand.')
  };

  if (row.uk_lowest_pence == null || costPence == null) {
    row.verdict = 'not_found';
  } else {
    const g = grossFrom(row.uk_lowest_pence, costPence);
    row.gross_pence = g.pence;
    row.gross_pct   = g.pct;
    row.verdict = await verdictFor(db, g.pence, g.pct);
  }

  try {
    const saved = await db.insert('price_checks', row);
    return json(200, { check: (saved && saved[0]) || row });
  } catch (err) {
    console.error('could not save the check', err);
    return json(500, { error: 'Checked, but could not save it' });
  }
};


// ── verdict ───────────────────────────────────────────────────
// Deliberately refuses to judge when no target has been set. An
// invented threshold is how a screen starts lying.
async function verdictFor(db, grossPence, grossPct) {
  if (grossPence <= 0) return 'loss';
  try {
    const rows = await db.select('sourcing_settings', 'select=target_contribution_pct&id=eq.1');
    const target = rows && rows[0] && rows[0].target_contribution_pct;
    if (target == null) return 'unknown';
    return (grossPct != null && Number(grossPct) < Number(target)) ? 'below_target' : 'ok';
  } catch (err) {
    console.error('could not read the target', err);
    return 'unknown';
  }
}


// ── route 1: Shopify ──────────────────────────────────────────
// Every Shopify store publishes /products/<handle>.json. It is
// public and meant to be read. One request, no key, exact price.
async function shopifyPrice(link) {
  if (!link) return null;
  let u;
  try { u = new URL(link); } catch { return null; }
  const m = u.pathname.match(/\/products\/([^/?#]+)/);
  if (!m) return null;

  const target = u.origin + '/products/' + m[1] + '.json';
  try {
    const resp = await fetchWithTimeout(target);
    if (!resp.ok) return null;
    const data = await resp.json();
    const lowest = lowestVariantPence(data && data.product);
    if (lowest == null) return null;
    return {
      method: 'shopify',
      lowestPence: lowest,
      seller: u.hostname.replace(/^www\./, ''),
      url: link,
      sources: [{ seller: u.hostname.replace(/^www\./, ''), url: link, price_pence: lowest }],
      note: 'Read straight from the shop’s own product feed. Assumed GBP — check if the shop trades in another currency.'
    };
  } catch (err) {
    console.error('shopify lookup failed', target, err.message);
    return null;
  }
}


// The pure half of route 1, kept separate so it can be tested
// without a network. Returns pence, or null when there is nothing
// usable — a variant priced at 0 is Shopify for "not for sale".
function lowestVariantPence(product) {
  const variants = (product && product.variants) || [];
  const prices = variants
    .map(v => Math.round(parseFloat(v && v.price) * 100))
    .filter(n => Number.isFinite(n) && n > 0);
  return prices.length ? Math.min.apply(null, prices) : null;
}


// Headline gross only. Named so nobody mistakes it for contribution.
function grossFrom(ukLowestPence, costPence) {
  if (ukLowestPence == null || costPence == null) return { pence: null, pct: null };
  const pence = ukLowestPence - costPence;
  const pct = ukLowestPence > 0
    ? Math.round((pence / ukLowestPence) * 10000) / 100
    : null;
  return { pence, pct };
}


// ── route 2: AI web search ────────────────────────────────────
// Only reached when route 1 has nothing. The prompt is written to
// make "I could not find it" an acceptable answer, because the
// alternative is a plausible invented number.
async function aiPrice(title, link) {
  const system =
    'You check UK retail prices for a small shop deciding what to sell. ' +
    'Search the web for the product and report what UK sellers actually charge. ' +
    'Rules you must not break: only report a price you have seen on a page you retrieved; ' +
    'never estimate, average or infer a price; ignore non-UK sellers and non-GBP prices; ' +
    'ignore listings that are clearly a different product, size or pack quantity. ' +
    'If you cannot find the same product on a UK site, say so. That is a useful answer. ' +
    'Reply with JSON only, no prose, in this shape: ' +
    '{"found":true|false,"sources":[{"seller":"","url":"","price_gbp":0.00}],"note":""} ' +
    'Put the cheapest first. At most 6 sources. Keep note under 200 characters.';

  const prompt = 'Product: ' + String(title || '').slice(0, 300) +
    (link ? '\nSeen at: ' + String(link).slice(0, 300) : '') +
    '\n\nWhat do UK sellers charge for this exact product?';

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1200,
        system,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!resp.ok) {
      console.error('Anthropic error', resp.status, (await resp.text()).slice(0, 400));
      return null;
    }

    const data = await resp.json();
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const parsed = firstJson(text);
    if (!parsed || !parsed.found || !Array.isArray(parsed.sources)) return null;

    const sources = parsed.sources
      .map(s => ({
        seller: String(s.seller || '').slice(0, 120),
        url: String(s.url || '').slice(0, 500),
        price_pence: Math.round(parseFloat(s.price_gbp) * 100)
      }))
      .filter(s => s.url && Number.isFinite(s.price_pence) && s.price_pence > 0)
      .sort((a, b) => a.price_pence - b.price_pence);

    if (!sources.length) return null;

    return {
      method: 'ai',
      lowestPence: sources[0].price_pence,
      seller: sources[0].seller || null,
      url: sources[0].url,
      sources,
      note: String(parsed.note || '').slice(0, 400)
    };
  } catch (err) {
    console.error('ai price lookup failed', err);
    return null;
  }
}

function firstJson(text) {
  if (!text) return null;
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(text.slice(a, b + 1)); } catch { return null; }
}


// ── exchange rate ─────────────────────────────────────────────
// Frankfurter publishes the European Central Bank's daily reference
// rates. Free, no key, no account. The rate and its date are stored
// on the check, so a margin never silently changes later.
async function gbpRate(from) {
  try {
    const resp = await fetchWithTimeout(
      'https://api.frankfurter.dev/v1/latest?base=' + encodeURIComponent(from) + '&symbols=GBP');
    if (!resp.ok) return { rate: null, asOf: null };
    const data = await resp.json();
    const rate = data && data.rates && data.rates.GBP;
    if (!rate) return { rate: null, asOf: null };
    return { rate: Number(rate), asOf: data.date || null };
  } catch (err) {
    console.error('fx lookup failed', err);
    return { rate: null, asOf: null };
  }
}


// ── plumbing, same as the sourcing functions ──────────────────
async function authorise(event, url, serviceKey) {
  const auth = event.headers.authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return false;
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
    console.error('authorise failed', err);
    return false;
  }
}

function restClient(url, serviceKey) {
  const base = url + '/rest/v1/';
  const headers = {
    apikey: serviceKey,
    authorization: 'Bearer ' + serviceKey,
    'content-type': 'application/json'
  };
  async function call(method, path, body, extraPrefer) {
    const resp = await fetch(base + path, {
      method,
      headers: Object.assign({}, headers, extraPrefer ? { prefer: extraPrefer } : {}),
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await resp.text();
    if (!resp.ok) throw new Error(method + ' ' + path + ' -> ' + resp.status + ' ' + text.slice(0, 300));
    return text ? JSON.parse(text) : null;
  }
  return {
    select: (table, query) => call('GET', table + '?' + query),
    insert: (table, row) => call('POST', table, row, 'return=representation')
  };
}

function fetchWithTimeout(target) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  return fetch(target, {
    signal: controller.signal,
    headers: { 'user-agent': UA, accept: 'application/json' }
  }).finally(() => clearTimeout(timer));
}

function json(statusCode, obj) {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) };
}

// Exported for test/price-check.test.js. Netlify only calls handler.
exports._internal = { lowestVariantPence, grossFrom, firstJson };
