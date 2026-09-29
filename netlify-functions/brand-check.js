// ============================================================
// Packet — Netlify Function: brand-check
// Built from the AXRIK starter kit under licence. Kit v1.1.0.
// ============================================================
// Answers the two questions that decide whether a brand is worth
// writing to at all, before anybody spends an email on them.
//
//   1. Can Shopify Collective reach them? Collective works between
//      two Shopify stores and nothing else, so a brand on Wix or
//      WooCommerce is unreachable however good they are. One
//      public request settles it.
//
//   2. What does their own shop charge? Report 007's arithmetic
//      kills a £22 order, and the last six research reports got
//      stuck on a sub-£8 shelf. A brand whose median product is
//      £45 is a different proposition from one whose median is £6,
//      and that is visible from outside for nothing.
//
// Written 20 September 2026, out of Supplier 010.
//
// THREE PUBLIC ENDPOINTS, NO KEY, NO AI, NO COST
//   /products.json  — is it Shopify, how many products, what prices
//   the front page  — Instagram handle, the shop's own currency, and
//                     a Shopify fallback for stores that have
//                     products.json turned off
//   /cart.json      — currency of last resort, and only ever as the
//                     PRESENTMENT currency (see below)
//
// THE CURRENCY TRAP, AND WHY IT IS HANDLED THE LONG WAY
// Shopify shows every visitor prices in their own presentment
// currency, converted from the shop's real one. This function runs
// on a Netlify machine whose location we do not control, so a
// Manchester shop can hand it dollars. Collective gates on the
// SHOP's currency, not the visitor's, so reading /cart.json and
// calling the answer "their currency" would be wrong in exactly the
// cases that matter. A theme publishes Shopify.currency =
// {"active":"GBP","rate":"1.0"} and a rate of exactly 1 means no
// conversion took place — only then is 'active' the shop's own.
//
// THE RULE, CARRIED FROM price-check.js: never write a number that
// did not come from a fetched page. A shop that does not answer is
// recorded as 'unreachable', which is honest and says nothing
// either way. A guess would look like evidence.
//
// WHAT THIS DELIBERATELY DOES NOT DO
//   It does not decide whether a brand is a UK company. No
//   endpoint knows that. GBP is a hint and nothing more, so the
//   country question stays a human field on the brands table and
//   starts at 'unknown'.
//   It does not decide whether a brand will say yes. That is what
//   the email in Supplier 010 is for.
//
// SETUP: Netlify -> Environment variables ->
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// POST { brand_id } with an owner/staff bearer token.
// No npm dependencies — native fetch (Netlify Node 18+).
// ============================================================

const REQUEST_TIMEOUT = 15000;
const PAGE_LIMIT      = 250;   // Shopify's own maximum for products.json
const UA = 'PacketSourcing/1.0 (+https://packetlabel.com; retail partnership research; contact info@packetlabel.com)';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const url        = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return json(503, { error: 'Supabase not configured' });

  if (!(await authorise(event, url, serviceKey))) return json(401, { error: 'Not authorised' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const brandId = (body.brand_id || '').toString();
  if (!/^[0-9a-f-]{36}$/i.test(brandId)) return json(400, { error: 'Missing or malformed brand_id' });

  const db = restClient(url, serviceKey);

  let brand;
  try {
    const rows = await db.select('brands', 'select=id,name,website&id=eq.' + brandId);
    brand = rows && rows[0];
  } catch (err) {
    console.error('could not read the brand', err);
    return json(500, { error: 'Could not read that brand' });
  }
  if (!brand) return json(404, { error: 'No such brand' });

  const origin = normaliseSite(brand.website);
  if (!origin) {
    return json(400, { error: 'That website is not a usable address. It needs to look like https://example.co.uk' });
  }

  const sources = [];
  const row = { brand_id: brandId, platform: 'unreachable', sources, verdict: 'unknown' };

  // ---- 1. the product feed --------------------------------------
  const feed = await productFeed(origin);
  if (feed.ok) {
    row.platform = 'shopify';
    sources.push({ what: 'product feed', url: feed.url, products: feed.products.length });

    const band = priceBandMinor(feed.products);
    row.product_count      = band.n;
    row.count_capped       = feed.products.length >= PAGE_LIMIT;
    row.price_min_minor    = band.min;
    row.price_median_minor = band.median;
    row.price_max_minor    = band.max;
  }

  // ---- 2. the front page ----------------------------------------
  // Needed for the Instagram handle either way, and it is the
  // fallback platform test for shops that have turned the feed off
  // — which some themes do, and which is not the same as not being
  // on Shopify.
  const home = await frontPage(origin);
  if (home.ok) {
    sources.push({ what: 'front page', url: home.url });
    row.instagram_found = instagramFrom(home.html);

    if (row.platform !== 'shopify') {
      row.platform = looksShopify(home.html) ? 'shopify' : 'not_shopify';
      if (row.platform === 'shopify') {
        row.note = 'Runs on Shopify, but its public product feed is switched off, so no prices could be read. ' +
                   'Reachable by Collective; the price band has to be looked at by hand.';
      }
    }
  }

  // ---- 3. the trading currency ----------------------------------
  // The shop's own first, from the front page. Only if that is not
  // published do we fall back to /cart.json, and what that returns
  // is recorded honestly as presentment — which settles nothing.
  if (row.platform === 'shopify') {
    let cur = home.ok ? currencyFromHtml(home.html) : null;
    let curUrl = home.url;

    if (!cur) {
      const cart = await shopCurrency(origin);
      if (cart.code) { cur = { code: cart.code, basis: 'presentment' }; curUrl = cart.url; }
    }

    if (cur) {
      row.currency = cur.code;
      row.currency_basis = cur.basis;
      sources.push({ what: 'currency', url: curUrl, currency: cur.code, basis: cur.basis });
    }
  }

  row.verdict = verdictFor(row.platform, row.currency, row.currency_basis);
  if (!row.note) row.note = noteFor(row.verdict, row.platform, row.currency, row.currency_basis);

  try {
    const saved = await db.insert('brand_checks', row);
    return json(200, { check: (saved && saved[0]) || row });
  } catch (err) {
    console.error('could not save the check', err);
    return json(500, { error: 'Checked, but could not save it' });
  }
};


// ── the verdict ───────────────────────────────────────────────
// Narrow on purpose. 'reachable' means "runs on Shopify and trades
// in the currency Packet's store would trade in". It does NOT mean
// UK-registered, suitable, or willing. Those are the three human
// fields on the brands table, and conflating them with this is how
// a screen starts being read as a recommendation.
function verdictFor(platform, currency, basis) {
  if (platform === 'not_shopify') return 'not_reachable';
  if (platform !== 'shopify')     return 'unknown';
  if (!currency)                  return 'unknown';

  // A presentment currency is what this machine was shown, not what
  // the shop trades in. It never decides the verdict either way — a
  // GBP presentment does not prove a UK shop, and a USD one does not
  // disprove it.
  if (basis !== 'shop')           return 'unknown';

  return currency === 'GBP' ? 'reachable' : 'wrong_currency';
}

function noteFor(verdict, platform, currency, basis) {
  if (verdict === 'reachable') {
    return 'On Shopify and the shop’s own currency is GBP. Collective can reach them once Packet’s own ' +
           'store is live. Whether they are a UK company still has to be checked by hand.';
  }
  if (verdict === 'wrong_currency') {
    return 'On Shopify, but the shop’s own currency is ' + currency + '. Collective requires the retailer ' +
           'and the supplier to share a country and a currency, so a GBP Packet store cannot connect to this one.';
  }
  if (platform === 'shopify' && currency && basis === 'presentment') {
    return 'On Shopify. The shop showed this check prices in ' + currency + ', but that is the presentment ' +
           'currency for wherever the check ran, not necessarily the shop’s own. Worth two minutes on their ' +
           'site to see what they actually trade in.';
  }
  if (verdict === 'not_reachable') {
    return 'Not a Shopify shop, so Collective cannot reach them at all. Carrying this brand would mean a ' +
           'feed or a manual listing instead — worth it only if the brand is worth it.';
  }
  if (platform === 'unreachable') {
    return 'The site did not answer. That says nothing either way — try again before drawing any conclusion.';
  }
  return 'On Shopify, but the trading currency could not be read. Check it by hand before writing to them.';
}


// ── the pure half, testable without a network ─────────────────

// Accepts what somebody will actually paste: a bare domain, a
// product link, a URL with tracking junk on the end. Returns the
// origin, because every endpoint below hangs off that.
function normaliseSite(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;
  let u;
  try { u = new URL(withScheme); } catch { return null; }
  if (!u.hostname || u.hostname.indexOf('.') < 0) return null;
  if (!/^https?:$/.test(u.protocol)) return null;
  return u.origin;
}

// The entry price of each product — the cheapest variant a shopper
// could actually buy — then the spread across the catalogue.
//
// Median rather than mean, because one £900 display piece should
// not make a £12 brand read as a premium one. A zero-priced variant
// is Shopify for "not for sale" and is ignored, same as in
// price-check.js.
function priceBandMinor(products) {
  const entry = (products || [])
    .map(lowestVariantMinor)
    .filter(n => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);

  if (!entry.length) return { n: 0, min: null, median: null, max: null };

  return {
    n: entry.length,
    min: entry[0],
    median: medianOf(entry),
    max: entry[entry.length - 1]
  };
}

function lowestVariantMinor(product) {
  const variants = (product && product.variants) || [];
  const prices = variants
    .map(v => Math.round(parseFloat(v && v.price) * 100))
    .filter(n => Number.isFinite(n) && n > 0);
  return prices.length ? Math.min.apply(null, prices) : null;
}

function medianOf(sorted) {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

// A shop's own link to itself. Deliberately ignores share and
// intent links, which point at Instagram but are not the brand's
// account, and reserved paths that are Instagram's own.
function instagramFrom(html) {
  if (!html) return null;
  const re = /(?:https?:\/\/)?(?:www\.)?instagram\.com\/([A-Za-z0-9_.]{1,30})/gi;
  const skip = ['p', 'reel', 'reels', 'explore', 'stories', 'share', 'accounts', 'direct', 'tv'];
  let m;
  while ((m = re.exec(html)) !== null) {
    const handle = m[1].replace(/\.$/, '');
    if (!handle) continue;
    if (skip.indexOf(handle.toLowerCase()) > -1) continue;
    return handle;
  }
  return null;
}

// Fallback platform test. Every Shopify storefront serves its
// assets from cdn.shopify.com and defines a Shopify object, and a
// theme cannot easily hide both.
function looksShopify(html) {
  if (!html) return false;
  return /cdn\.shopify\.com/i.test(html)
      || /cdn\/shop\/(files|t)\//i.test(html)
      || /Shopify\.(shop|theme|currency)\s*=/i.test(html)
      || /<meta[^>]+shopify-(digital-wallet|checkout-api-token)/i.test(html);
}

// The shop's OWN currency, when the theme publishes it. Shopify
// themes emit Shopify.currency = {"active":"GBP","rate":"1.0"}.
// 'rate' is the presentment rate against the shop's currency, so a
// rate of exactly 1 means nothing was converted and 'active' is the
// shop's own. Any other rate means we are looking at a conversion
// and cannot see the base, so it is reported as presentment.
function currencyFromHtml(html) {
  if (!html) return null;
  const m = html.match(/Shopify\.currency\s*=\s*(\{[^}]*\})/i);
  if (!m) return null;
  let obj;
  try { obj = JSON.parse(m[1]); } catch { return null; }

  const code = currencyFrom({ currency: obj && obj.active });
  if (!code) return null;

  const rate = parseFloat(obj && obj.rate);
  const unconverted = Number.isFinite(rate) && Math.abs(rate - 1) < 1e-9;
  return { code, basis: unconverted ? 'shop' : 'presentment' };
}

// /cart.json answers {"token":"…","currency":"GBP",…} on any
// Shopify storefront. Anything outside the list Collective supports
// is recorded as 'other' rather than dropped, because "trades in a
// currency Packet cannot match" is itself the finding.
function currencyFrom(cart) {
  const code = cart && typeof cart.currency === 'string' ? cart.currency.toUpperCase() : null;
  if (!code || !/^[A-Z]{3}$/.test(code)) return null;
  return ['GBP', 'USD', 'EUR', 'AUD', 'CAD'].indexOf(code) > -1 ? code : 'other';
}


// ── the network half ──────────────────────────────────────────

async function productFeed(origin) {
  const target = origin + '/products.json?limit=' + PAGE_LIMIT;
  try {
    const resp = await fetchWithTimeout(target, 'application/json');
    if (!resp.ok) return { ok: false };
    const ct = (resp.headers.get('content-type') || '').toLowerCase();
    if (ct.indexOf('json') < 0) return { ok: false };   // a themed 404 page is not a feed
    const data = await resp.json();
    if (!data || !Array.isArray(data.products)) return { ok: false };
    return { ok: true, url: target, products: data.products };
  } catch (err) {
    console.error('product feed failed', target, err.message);
    return { ok: false };
  }
}

async function frontPage(origin) {
  try {
    const resp = await fetchWithTimeout(origin, 'text/html');
    if (!resp.ok) return { ok: false };
    const html = (await resp.text()).slice(0, 400000);
    return { ok: true, url: origin, html };
  } catch (err) {
    console.error('front page failed', origin, err.message);
    return { ok: false };
  }
}

async function shopCurrency(origin) {
  const target = origin + '/cart.json';
  try {
    const resp = await fetchWithTimeout(target, 'application/json');
    if (!resp.ok) return { code: null };
    const data = await resp.json();
    return { code: currencyFrom(data), url: target };
  } catch (err) {
    console.error('currency lookup failed', target, err.message);
    return { code: null };
  }
}


// ── plumbing, same as price-check.js ──────────────────────────
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

function fetchWithTimeout(target, accept) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  return fetch(target, {
    signal: controller.signal,
    redirect: 'follow',
    headers: { 'user-agent': UA, accept: accept || '*/*' }
  }).finally(() => clearTimeout(timer));
}

function json(statusCode, obj) {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) };
}

// Exported for test/brand-check.test.js. Netlify only calls handler.
exports._internal = {
  normaliseSite, priceBandMinor, lowestVariantMinor, medianOf,
  instagramFrom, looksShopify, currencyFrom, currencyFromHtml, verdictFor
};
