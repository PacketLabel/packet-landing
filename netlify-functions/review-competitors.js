// ============================================================
// Packet — Netlify Function: review-competitors
// Built from the AXRIK starter kit under licence. Kit v1.1.0.
// ============================================================
// Works out how each competitor operates and writes it up.
//
// THE RULE THIS FILE IS BUILT AROUND
// Every number is counted here, in plain code, from data we have
// actually collected. The AI is handed those numbers and asked to
// interpret them. It is never asked what the numbers are.
//
// That split is the whole design. "Focus on customer experience
// and build a strong brand" is the kind of thing a model will
// generate all day, and it reads like insight. Tying it to "all
// four charge £3.95 for delivery and none goes free under £30"
// means a wrong write-up sits next to the facts that disprove it.
//
// If ANTHROPIC_API_KEY is missing, ai.js returns { fallback: true }
// and this stores the facts with no summary. Nothing breaks and
// nothing is silently lost — ai_used records which you are seeing.
//
// SETUP: same environment variables as the other sourcing
// functions. Scheduled from netlify.toml. No npm dependencies.
// ============================================================

// Shopify puts its policy pages at fixed addresses, which is why
// these are worth trying. A 404 is normal and not an error.
const POLICY_PATHS = [
  '/policies/shipping-policy',
  '/policies/refund-policy',
  '/pages/delivery',
  '/pages/shipping',
  '/pages/returns'
];

const PAGE_PAUSE_MS   = 1200;
const STORE_PAUSE_MS  = 2500;
const REQUEST_TIMEOUT = 15000;

// Price bands in pence. Chosen to straddle the sort of goods on
// the low-return list; an empty band is the interesting result.
const BANDS = [
  [0, 499, 'under £5'], [500, 999, '£5–10'], [1000, 1499, '£10–15'],
  [1500, 1999, '£15–20'], [2000, 2999, '£20–30'], [3000, 4999, '£30–50'],
  [5000, null, 'over £50']
];

exports.handler = async (event) => {
  const url        = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return json(503, { error: 'Supabase not configured' });
  if (!(await authorise(event, url, serviceKey))) return json(401, { error: 'Not authorised' });

  const db = restClient(url, serviceKey);

  try {
    const competitors = await db.select('competitors', 'select=*&active=eq.true');
    if (!competitors.length) return json(200, { ok: true, reviewed: 0, note: 'No competitors added yet.' });

    const profiles = [];

    for (const c of competitors) {
      // Everything they sell, as last seen.
      const products = await db.select(
        'competitor_products',
        'select=price_pence,compare_at_pence,available,product_type,tags,first_seen_at,last_seen_at' +
        '&competitor_id=eq.' + c.id + '&limit=5000'
      );

      const facts = computeFacts(products);
      const terms = await readTerms(c);

      const row = Object.assign({
        competitor_id: c.id,
        pages_read: terms.pagesRead,
        delivery_cost_pence: terms.deliveryCostPence,
        delivery_free_over_pence: terms.deliveryFreeOverPence,
        delivery_note: terms.deliveryNote,
        returns_days: terms.returnsDays,
        returns_note: terms.returnsNote,
        facts: Object.assign({}, facts, { terms: terms })
      }, facts.columns);

      const written = await describeOne(c, row, facts, terms);
      row.summary  = written.text;
      row.ai_used  = written.ai;

      const saved = await db.insert('competitor_profiles', row);
      profiles.push({ competitor: c, row: saved && saved[0], facts, terms });

      await pause(STORE_PAUSE_MS);
    }

    // The across-everybody view. This is where the gaps show up,
    // and gaps are the only genuinely useful output here — anything
    // visible on a public site is visible to them too.
    const market = combine(profiles);
    const writtenMarket = await describeMarket(market);

    await db.insert('market_reviews', {
      competitors_count: profiles.length,
      price_bands:       market.priceBands,
      category_coverage: market.categoryCoverage,
      delivery_summary:  market.delivery,
      returns_summary:   market.returns,
      summary:           writtenMarket.text,
      gaps:              writtenMarket.gaps,
      ai_used:           writtenMarket.ai,
      facts:             market
    });

    return json(200, { ok: true, reviewed: profiles.length, ai_used: writtenMarket.ai });
  } catch (err) {
    console.error('review-competitors failed', err);
    return json(500, { error: 'Review failed' });
  }
};


// ---------------------------------------------------------------- counting

// Everything here is arithmetic over rows we already hold. No
// network, no model, no judgement.
function computeFacts(products) {
  const now = Date.now();
  const DAY = 86400000;

  const priced = products.filter(p => typeof p.price_pence === 'number' && p.price_pence > 0);
  const prices = priced.map(p => p.price_pence).sort((a, b) => a - b);

  const newRecently = products.filter(p =>
    p.first_seen_at && (now - new Date(p.first_seen_at).getTime()) < 30 * DAY).length;

  // Not seen for a fortnight while everything else has been: they
  // have stopped selling it. Only meaningful once there is history.
  const lastSeen = products.map(p => p.last_seen_at ? new Date(p.last_seen_at).getTime() : 0);
  const freshest = lastSeen.length ? Math.max.apply(null, lastSeen) : 0;
  const gone = products.filter(p =>
    p.last_seen_at && (freshest - new Date(p.last_seen_at).getTime()) > 14 * DAY).length;

  const outOfStock = products.filter(p => p.available === false).length;

  // A discount only counts when the "was" price is above the price.
  const discounted = priced.filter(p =>
    typeof p.compare_at_pence === 'number' && p.compare_at_pence > p.price_pence);
  const discountPcts = discounted
    .map(p => ((p.compare_at_pence - p.price_pence) / p.compare_at_pence) * 100)
    .sort((a, b) => a - b);

  const bands = {};
  BANDS.forEach(([lo, hi, label]) => {
    bands[label] = prices.filter(p => p >= lo && (hi === null || p <= hi)).length;
  });

  const categories = {};
  products.forEach(p => {
    const key = (p.product_type || '').trim();
    if (key) categories[key] = (categories[key] || 0) + 1;
  });

  return {
    columns: {
      product_count:       products.length,
      new_products_30d:    newRecently,
      gone_products_30d:   gone,
      out_of_stock_count:  outOfStock,
      price_min_pence:     prices.length ? prices[0] : null,
      // Rounded here, not inside median(), because median() is also
      // used on percentages where rounding to a whole number would
      // throw away the precision that makes the figure worth having.
      price_median_pence:  prices.length ? Math.round(median(prices)) : null,
      price_max_pence:     prices.length ? prices[prices.length - 1] : null,
      price_bands:         bands,
      discounted_count:    discounted.length,
      median_discount_pct: discountPcts.length ? Math.round(median(discountPcts) * 100) / 100 : null,
      categories:          categories
    },
    priceBands: bands,
    categories: categories,
    outOfStockRate: products.length ? Math.round((outOfStock / products.length) * 1000) / 10 : null
  };
}

// Returns the exact middle. The caller rounds if it needs a whole
// number — this is used on both pence and percentages.
function median(sorted) {
  if (!sorted.length) return null;
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}


// ---------------------------------------------------------------- terms

// Delivery and returns, read off their own policy pages. Regex
// rather than a model, because these are the numbers a customer
// compares and getting one wrong is worse than not having it.
// Anything not confidently found stays null and shows as unknown.
async function readTerms(competitor) {
  const base = String(competitor.website).replace(/\/+$/, '');
  const out = {
    pagesRead: [], deliveryCostPence: null, deliveryFreeOverPence: null,
    deliveryNote: null, returnsDays: null, returnsNote: null
  };

  let text = '';
  for (const path of POLICY_PATHS) {
    try {
      const resp = await fetchWithTimeout(base + path);
      if (!resp.ok) continue;
      const html = await resp.text();
      const page = stripHtml(html);
      if (page.length > 200) {
        text += ' ' + page;
        out.pagesRead.push(path);
      }
    } catch { /* a missing policy page is normal, not a failure */ }
    await pause(PAGE_PAUSE_MS);
  }

  if (!text) return out;

  const free = findFreeDeliveryThreshold(text);
  if (free !== null) {
    out.deliveryFreeOverPence = free;
    out.deliveryNote = 'Free delivery over ' + pounds(free);
  }

  const cost = findDeliveryCost(text);
  if (cost !== null) {
    out.deliveryCostPence = cost;
    out.deliveryNote = (out.deliveryNote ? out.deliveryNote + '; ' : '') + 'delivery from ' + pounds(cost);
  }

  const days = findReturnsWindow(text);
  if (days !== null) {
    out.returnsDays = days;
    out.returnsNote = days + ' days to return';
  }

  return out;
}

function stripHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&pound;/gi, '£').replace(/&#163;/g, '£')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toPence(s) {
  const m = String(s).match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  return parseInt(m[1], 10) * 100 + parseInt((m[2] || '0').padEnd(2, '0'), 10);
}

function findFreeDeliveryThreshold(text) {
  const patterns = [
    /free\s+(?:uk\s+)?(?:standard\s+)?(?:delivery|shipping|postage)[^.£]{0,40}?(?:over|above|from|spend(?:ing)?(?:\s+of)?)\s*£\s*(\d+(?:\.\d{1,2})?)/i,
    // Both word orders. Shops write "spend £25 for free delivery"
    // and "spend £25 and delivery is free" about equally often, and
    // missing the second one loses a real policy.
    /(?:orders?|spend)\s*(?:over|above|of)?\s*£\s*(\d+(?:\.\d{1,2})?)[^.]{0,40}?(?:free\s+(?:delivery|shipping|postage)|(?:delivery|shipping|postage)\s+(?:is|are|becomes?)\s+free)/i,
    /£\s*(\d+(?:\.\d{1,2})?)\s*(?:or more|and over)[^.]{0,30}?free\s+(?:delivery|shipping)/i
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const p = toPence(m[1]);
      // A "free over £2000" match is a misread, not a policy.
      if (p !== null && p >= 500 && p <= 20000) return p;
    }
  }
  return null;
}

function findDeliveryCost(text) {
  const patterns = [
    /(?:standard|uk)\s+(?:delivery|shipping|postage)[^.£]{0,40}?£\s*(\d+\.\d{2})/i,
    /(?:delivery|shipping|postage)\s+(?:costs?|charge[ds]?|is|from)?\s*£\s*(\d+\.\d{2})/i
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const p = toPence(m[1]);
      if (p !== null && p > 0 && p <= 3000) return p;
    }
  }
  return null;
}

function findReturnsWindow(text) {
  const m = text.match(/(\d{1,3})\s*(?:calendar\s+|working\s+)?days?[^.]{0,40}?(?:return|refund|exchange|change[d]?\s+your\s+mind)/i)
        || text.match(/(?:return|refund|exchange)[^.]{0,40}?within\s+(\d{1,3})\s*(?:calendar\s+|working\s+)?days?/i);
  if (!m) return null;
  const d = parseInt(m[1], 10);
  // Under 14 would be unlawful for distance selling; over 365 is a misread.
  return d >= 7 && d <= 365 ? d : null;
}

function pounds(pence) { return '£' + (pence / 100).toFixed(2); }


// ---------------------------------------------------------------- combining

function combine(profiles) {
  const priceBands = {};
  BANDS.forEach(([, , label]) => { priceBands[label] = {}; });

  const categoryCoverage = {};
  const delivery = [];
  const returns = [];

  profiles.forEach(({ competitor, facts, terms }) => {
    BANDS.forEach(([, , label]) => {
      priceBands[label][competitor.name] = facts.priceBands[label] || 0;
    });
    Object.keys(facts.categories).forEach(cat => {
      categoryCoverage[cat] = categoryCoverage[cat] || [];
      categoryCoverage[cat].push(competitor.name);
    });
    delivery.push({
      competitor: competitor.name,
      cost_pence: terms.deliveryCostPence,
      free_over_pence: terms.deliveryFreeOverPence,
      known: terms.pagesRead.length > 0
    });
    returns.push({
      competitor: competitor.name,
      days: terms.returnsDays,
      known: terms.pagesRead.length > 0
    });
  });

  // A band nobody occupies is the single most useful thing here.
  const emptyBands = Object.keys(priceBands).filter(label =>
    Object.values(priceBands[label]).every(n => n === 0));

  return {
    priceBands, categoryCoverage, delivery, returns, emptyBands,
    competitors: profiles.map(p => ({
      name: p.competitor.name,
      products: p.facts.columns.product_count,
      median_price_pence: p.facts.columns.price_median_pence,
      new_30d: p.facts.columns.new_products_30d,
      out_of_stock_rate: p.facts.outOfStockRate,
      discounted: p.facts.columns.discounted_count
    }))
  };
}


// ---------------------------------------------------------------- writing

const VOICE =
  'You are writing an internal note for the two owners of Packet, a UK online shop being set up on ' +
  'a dropship model. Write in plain UK English, warm and direct, no marketing language and no ' +
  'management jargon. Never write filler such as "focus on customer experience" or "build a strong ' +
  'brand" — say something specific or say nothing.\n\n' +
  'CRITICAL: every claim you make must be traceable to a figure you were given. You may not estimate, ' +
  'infer sales, revenue, profit, traffic or advertising, or state that a competitor is doing well or ' +
  'badly. You cannot see any of that and neither can the reader. If the data does not support a point, ' +
  'leave the point out. Where a figure is missing, say it is unknown rather than working around it.';

async function describeOne(competitor, row, facts, terms) {
  const f = row;
  const lines = [
    'Competitor: ' + competitor.name + ' (' + competitor.website + ')',
    'Products listed: ' + f.product_count,
    'Added in the last 30 days: ' + f.new_products_30d,
    'Appear to have been dropped: ' + f.gone_products_30d,
    'Currently out of stock: ' + f.out_of_stock_count +
      (facts.outOfStockRate !== null ? ' (' + facts.outOfStockRate + '% of the range)' : ''),
    'Prices: lowest ' + money(f.price_min_pence) + ', middle ' + money(f.price_median_pence) +
      ', highest ' + money(f.price_max_pence),
    'Products per price band: ' + JSON.stringify(f.price_bands),
    'On discount: ' + f.discounted_count +
      (f.median_discount_pct !== null ? ', typically ' + f.median_discount_pct + '% off' : ''),
    'Their own product categories: ' + JSON.stringify(topN(f.categories, 12)),
    'Delivery: ' + (terms.deliveryNote || 'not found on their policy pages'),
    'Returns: ' + (terms.returnsNote || 'not found on their policy pages'),
    'Policy pages read: ' + (terms.pagesRead.length ? terms.pagesRead.join(', ') : 'none could be read')
  ];

  return ask(
    VOICE,
    'Here is what we observed about one competitor.\n\n' + lines.join('\n') + '\n\n' +
    'In no more than 180 words, describe how this shop appears to operate: the shape of its range, ' +
    'where it sits on price, how actively it is being added to, and how its delivery and returns ' +
    'terms compare to what a UK shopper would expect. Point out anything genuinely notable. ' +
    'If little can be said from this data, say so briefly rather than padding.',
    420
  );
}

async function describeMarket(market) {
  const lines = [
    'Competitors reviewed: ' + market.competitors.length,
    '',
    'Each one:',
    ...market.competitors.map(c =>
      '- ' + c.name + ': ' + c.products + ' products, middle price ' + money(c.median_price_pence) +
      ', ' + c.new_30d + ' added in 30 days, ' + (c.out_of_stock_rate === null ? 'unknown' : c.out_of_stock_rate + '%') +
      ' out of stock, ' + c.discounted + ' on discount'),
    '',
    'Products per price band, by shop: ' + JSON.stringify(market.priceBands),
    'Price bands NOBODY occupies: ' + (market.emptyBands.length ? market.emptyBands.join(', ') : 'none'),
    '',
    'Delivery terms: ' + JSON.stringify(market.delivery),
    'Returns terms: ' + JSON.stringify(market.returns),
    '',
    'Which shops cover each category: ' + JSON.stringify(topN(market.categoryCoverage, 20))
  ];

  const res = await ask(
    VOICE,
    'Here is everything observed across the competitors.\n\n' + lines.join('\n') + '\n\n' +
    'Write two things.\n\n' +
    'First, under the heading SUMMARY, up to 200 words on where these shops cluster — on price, on ' +
    'range, on delivery and returns terms — and where they differ from each other.\n\n' +
    'Second, under the heading GAPS, between two and six specific openings for Packet, one per line, ' +
    'each starting with "- ". A gap is something none of them does: a price band nobody occupies, a ' +
    'category nobody covers, a delivery or returns promise nobody makes. Each must name the figure it ' +
    'comes from. Do not suggest anything you cannot point at evidence for, and do not suggest ' +
    'competing on being cheaper unless the price data actually supports it. If you can only find one ' +
    'real gap, give one.',
    900
  );

  if (!res.ai) return { text: res.text, gaps: [], ai: false };

  const gapPart = res.text.split(/GAPS/i)[1] || '';
  const gaps = gapPart.split('\n')
    .map(l => l.replace(/^[-•*\s]+/, '').trim())
    .filter(l => l.length > 12);

  return {
    text: (res.text.split(/GAPS/i)[0] || res.text).replace(/^\s*SUMMARY\s*:?/i, '').trim(),
    gaps: gaps,
    ai: true
  };
}

// Every AI feature goes through the one proxy, and every AI feature
// has a non-AI answer. Here the fallback is honest silence: the
// facts are already saved and shown, there is just no write-up.
async function ask(system, prompt, maxTokens) {
  const base = process.env.URL || process.env.DEPLOY_URL;
  if (!base) return { text: null, ai: false };

  try {
    const resp = await fetch(base + '/.netlify/functions/ai', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ system: system, prompt: prompt, max_tokens: maxTokens })
    });
    const data = await resp.json();
    if (!resp.ok || data.fallback || !data.text) return { text: null, ai: false };
    return { text: data.text, ai: true };
  } catch (err) {
    console.error('write-up unavailable', err);
    return { text: null, ai: false };
  }
}

function topN(obj, n) {
  return Object.entries(obj || {})
    .sort((a, b) => (Array.isArray(b[1]) ? b[1].length : b[1]) - (Array.isArray(a[1]) ? a[1].length : a[1]))
    .slice(0, n)
    .reduce((acc, [k, v]) => { acc[k] = v; return acc; }, {});
}

function money(pence) {
  return pence === null || pence === undefined ? 'unknown' : '£' + (pence / 100).toFixed(2);
}


// ---------------------------------------------------------------- plumbing

async function authorise(event, url, serviceKey) {
  const secret = process.env.SOURCING_CRON_SECRET;
  if (secret && event.headers['x-sourcing-secret'] === secret) return true;
  try { if (JSON.parse(event.body || '{}').next_run) return true; } catch { /* not JSON */ }

  const token = (event.headers.authorization || '').replace(/^Bearer\s+/i, '');
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
    apikey: serviceKey, authorization: 'Bearer ' + serviceKey, 'content-type': 'application/json'
  };
  async function call(method, path, body, prefer) {
    const resp = await fetch(base + path, {
      method,
      headers: Object.assign({}, headers, prefer ? { prefer } : {}),
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
    headers: {
      'user-agent': 'PacketSourcing/1.0 (+https://packetlabel.com; price research; contact info@packetlabel.com)',
      accept: 'text/html'
    }
  }).finally(() => clearTimeout(timer));
}

function pause(ms) { return new Promise(r => setTimeout(r, ms)); }

function json(statusCode, obj) {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) };
}

// Exposed for the tests. Not part of the contract.
exports._internal = {
  computeFacts, stripHtml, findFreeDeliveryThreshold, findDeliveryCost,
  findReturnsWindow, combine, median, toPence
};
