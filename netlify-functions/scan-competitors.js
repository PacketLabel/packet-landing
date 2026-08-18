// ============================================================
// Packet — Netlify Function: scan-competitors
// Built from the AXRIK starter kit under licence. Kit v1.1.0.
// ============================================================
// Reads each active competitor's public product feed, records what
// they sell and what they charge, and keeps a price history.
//
// WHAT THIS DOES AND DOES NOT DO
// Shopify publishes /products.json on every store by default. It is
// a public, unauthenticated endpoint meant to be read, and it is the
// reason a Shopify competitor is straightforward to watch and
// anybody else is not. This function reads that, once a week, one
// store at a time, with a pause between pages. It is not a crawler
// and it must never become one.
//
// Before adding a competitor, check their terms of use. Reading a
// public price is ordinary market research; hammering someone's shop
// is not, and a scraped-looking traffic pattern is how an IP ends up
// blocked. If a store has switched the feed off, that is an answer —
// record it and move on rather than engineering around it.
//
// WHY THE PRICE HISTORY MATTERS
// Packet has no sales data for anybody. The only demand evidence
// available is behavioural: a shop has carried this for months, at a
// steady price, and it keeps selling out. That is weak, and the
// admin page says so. Without the history it would be nothing at all.
//
// SETUP: Netlify -> Environment variables ->
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SOURCING_CRON_SECRET
// Scheduled from netlify.toml. No npm dependencies — native fetch.
// ============================================================

const MAX_PAGES        = 12;    // 250 products a page; 3,000 is plenty
const PAGE_PAUSE_MS    = 1200;  // deliberate. Be a good guest.
const STORE_PAUSE_MS   = 2500;
const REQUEST_TIMEOUT  = 15000;

exports.handler = async (event) => {
  const url        = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return json(503, { error: 'Supabase not configured' });

  const allowed = await authorise(event, url, serviceKey);
  if (!allowed) return json(401, { error: 'Not authorised' });

  const db = restClient(url, serviceKey);

  let run;
  try {
    run = await db.insert('sourcing_runs', { status: 'running' });
  } catch (err) {
    console.error('could not open a run', err);
    return json(500, { error: 'Could not start' });
  }
  const runId = run && run[0] && run[0].id;

  let scanned = 0, seen = 0;
  const problems = [];

  try {
    const competitors = await db.select('competitors', 'select=*&active=eq.true');

    for (const c of competitors) {
      try {
        const products = await readStore(c);
        await recordProducts(db, c, products);
        seen += products.length;
        scanned++;

        await db.patch('competitors', 'id=eq.' + c.id, {
          last_scanned_at: new Date().toISOString(),
          last_scan_status: 'ok',
          last_scan_error: null,
          products_seen: products.length
        });
      } catch (err) {
        // One competitor failing is normal and must never stop the
        // rest. The reason is stored so the admin page can show it
        // rather than the row just looking stale for no visible cause.
        problems.push(c.name + ': ' + err.message);
        await db.patch('competitors', 'id=eq.' + c.id, {
          last_scanned_at: new Date().toISOString(),
          last_scan_status: 'failed',
          last_scan_error: String(err.message).slice(0, 500)
        });
      }
      await pause(STORE_PAUSE_MS);
    }

    await db.patch('sourcing_runs', 'id=eq.' + runId, {
      status: 'complete',
      finished_at: new Date().toISOString(),
      competitors_scanned: scanned,
      error: problems.length ? problems.join(' | ').slice(0, 1000) : null
    });

    // No competitor data in the response body. This endpoint returns
    // counts and nothing else.
    return json(200, { ok: true, competitors_scanned: scanned, products_seen: seen, problems: problems.length });
  } catch (err) {
    console.error('scan failed', err);
    if (runId) {
      await db.patch('sourcing_runs', 'id=eq.' + runId, {
        status: 'failed', finished_at: new Date().toISOString(), error: String(err.message).slice(0, 1000)
      }).catch(() => {});
    }
    return json(500, { error: 'Scan failed' });
  }
};


// ---------------------------------------------------------------- reading

async function readStore(competitor) {
  if (competitor.platform !== 'shopify') {
    throw new Error('Only Shopify stores can be read automatically. Set this one to manual.');
  }

  const base = String(competitor.website).replace(/\/+$/, '');
  const path = competitor.feed_path || '/products.json';
  const out  = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const target = base + path + '?limit=250&page=' + page;
    const resp = await fetchWithTimeout(target);

    if (resp.status === 404 || resp.status === 403) {
      // The merchant has turned the feed off. That is their right and
      // it is a legitimate answer, not an obstacle.
      throw new Error('Product feed is not available (HTTP ' + resp.status + '). Watch this one by hand.');
    }
    if (!resp.ok) throw new Error('HTTP ' + resp.status + ' reading the product feed');

    let data;
    try { data = await resp.json(); }
    catch { throw new Error('That URL did not return a product feed. Check the address.'); }

    const batch = (data && data.products) || [];
    if (!batch.length) break;

    out.push(...batch.map(p => normalise(p, base)));
    if (batch.length < 250) break;
    await pause(PAGE_PAUSE_MS);
  }

  return out;
}

// One row per product, priced on the cheapest variant that is
// actually buyable. Storing every variant would multiply the table by
// ten for no gain — we are establishing what a thing sells for, not
// rebuilding somebody's catalogue.
//
// Note the public feed does not expose barcodes, which is exactly why
// the matcher cannot rely on them for competitor rows and has to fall
// back to brand, SKU and title.
function normalise(p, base) {
  const variants = (p.variants || []);
  const sellable = variants.filter(v => v.available);
  const priced   = (sellable.length ? sellable : variants)
    .map(v => ({ v: v, pence: toPence(v.price) }))
    .filter(x => x.pence !== null)
    .sort((a, b) => a.pence - b.pence);

  const best = priced.length ? priced[0] : null;

  return {
    external_id:      String(p.id),
    handle:           p.handle || null,
    title:            p.title || '(untitled)',
    brand:            p.vendor || null,
    sku:              best && best.v.sku ? String(best.v.sku) : null,
    gtin:             best && best.v.barcode ? String(best.v.barcode) : null,
    product_type:     p.product_type || null,
    tags:             Array.isArray(p.tags) ? p.tags : (p.tags ? String(p.tags).split(/\s*,\s*/) : null),
    price_pence:      best ? best.pence : null,
    compare_at_pence: best ? toPence(best.v.compare_at_price) : null,
    available:        sellable.length > 0,
    image_url:        (p.images && p.images[0] && p.images[0].src) || null,
    product_url:      p.handle ? base + '/products/' + p.handle : null
  };
}

// "12.99" -> 1299. Parsed as a string deliberately: floating point
// and money should never meet.
function toPence(value) {
  if (value === null || value === undefined) return null;
  const m = String(value).trim().match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  return parseInt(m[1], 10) * 100 + parseInt((m[2] || '0').padEnd(2, '0'), 10);
}


// ---------------------------------------------------------------- writing

async function recordProducts(db, competitor, products) {
  if (!products.length) return;

  const now = new Date().toISOString();

  for (let i = 0; i < products.length; i += 200) {
    const chunk = products.slice(i, i + 200).map(p => Object.assign({}, p, {
      competitor_id: competitor.id,
      last_seen_at: now
    }));

    // A plain upsert. times_seen and first_seen_at are handled by the
    // trigger in 005, so this cannot drift if somebody later writes a
    // second importer and forgets about them.
    const rows = await db.upsert(
      'competitor_products',
      chunk,
      'competitor_id,external_id'
    );

    const observations = (rows || []).map(r => ({
      competitor_product_id: r.id,
      price_pence: r.price_pence,
      available: r.available,
      observed_at: now
    }));
    if (observations.length) await db.insert('competitor_price_observations', observations);
  }
}


// ---------------------------------------------------------------- plumbing

// Two ways in, both server-side:
//   1. Netlify's scheduler, which posts a body containing next_run.
//   2. A signed-in owner or staff pressing "Scan now" in the admin,
//      or a call carrying SOURCING_CRON_SECRET.
//
// Worth being clear about the risk here, because it is low: this
// endpoint reads public web pages and writes competitor prices. It
// returns no data, touches no personal data, and cannot approve or
// publish anything. The gate is about stopping somebody running up
// requests against competitors in Packet's name, not about secrecy.
async function authorise(event, url, serviceKey) {
  const secret = process.env.SOURCING_CRON_SECRET;
  if (secret && event.headers['x-sourcing-secret'] === secret) return true;

  try {
    const body = JSON.parse(event.body || '{}');
    if (body.next_run) return true;               // Netlify scheduled invocation
  } catch { /* not JSON; fall through to the token check */ }

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

// A thin PostgREST wrapper. The supabase-js library would do this too,
// but the repo has no build step and no package.json, and this is
// forty lines. Keeping the dependency count at zero is worth more.
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
    insert: (table, row) => call('POST', table, row, 'return=representation'),
    patch:  (table, query, row) => call('PATCH', table + '?' + query, row),
    upsert: (table, rows, onConflict) =>
      call('POST', table + '?on_conflict=' + onConflict, rows,
           'resolution=merge-duplicates,return=representation')
  };
}

function fetchWithTimeout(target) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  return fetch(target, {
    signal: controller.signal,
    headers: {
      // Say who we are. A shop owner reading their logs should be able
      // to see it is us and get in touch, rather than guessing.
      'user-agent': 'PacketSourcing/1.0 (+https://packetlabel.com; price research; contact info@packetlabel.com)',
      accept: 'application/json'
    }
  }).finally(() => clearTimeout(timer));
}

function pause(ms) { return new Promise(r => setTimeout(r, ms)); }

function json(statusCode, obj) {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) };
}

// Exposed so the parsing can be tested without a network or a
// database. Not part of what this function promises to callers.
exports._internal = { normalise, toPence };
