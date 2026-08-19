// ============================================================
// Packet — Netlify Function: build-seasonal
// Built from the AXRIK starter kit under licence. Kit v1.1.0.
// ============================================================
// The weekly scan, pointed at the calendar.
//
// Same competitors, same suppliers, same margin engine, same
// compliance gate as build-opportunities. The only difference is
// that every row it writes carries a season and a date by which a
// decision has to be made, and that it also reports what the
// competitors are selling for a season that none of our suppliers
// can give us.
//
// It writes opportunities with status 'new' and a season_id. That
// is all it does. It cannot approve anything and it does not touch
// Shopify.
//
// The order of work matters and mirrors build-opportunities:
//   1. Refuse outright if the commercial settings are not filled
//      in. A seasonal margin built on invented fees is still an
//      invented margin.
//   2. Work out which seasons are close enough to matter, and
//      refuse to date the ones missing a lead time.
//   3. Compliance first, arithmetic second.
//   4. Keep the best few per season, so Christmas cannot crowd
//      out everything else.
//   5. Report the gaps, which is the answer worth having while
//      there is still time to act on it.
//
// SETUP: Netlify -> Environment variables ->
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SOURCING_CRON_SECRET
// Scheduled from netlify.toml. No npm dependencies — native fetch.
// ============================================================

const M = require('../admin/packet-margin.js');
const S = require('../admin/packet-seasons.js');

exports.handler = async (event) => {
  const url        = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return json(503, { error: 'Supabase not configured' });

  if (!(await authorise(event, url, serviceKey))) return json(401, { error: 'Not authorised' });

  const db = restClient(url, serviceKey);
  let runId = null;

  try {
    const run = await db.insert('sourcing_runs', { status: 'running' });
    runId = run && run[0] && run[0].id;

    // ---- 1. Will it run at all -----------------------------------
    const settingsRows = await db.select('sourcing_settings', 'select=*&id=eq.1');
    const raw = settingsRows[0] || {};
    const settings = camel(raw);

    const missing = M.checkSettings(settings);
    if (missing.length) {
      await db.patch('sourcing_runs', 'id=eq.' + runId, {
        status: 'blocked',
        finished_at: new Date().toISOString(),
        blocked_reason: 'Waiting on: ' + missing.join(', ') +
          '. Fill these in under Sourcing → Settings. They are blank on purpose — ' +
          'a made-up fee turns into a made-up margin, seasonal or not.'
      });
      return json(200, { ok: false, blocked: true, missing });
    }

    // ---- 2. Which seasons are close enough to matter -------------
    const seasons = await db.select('seasons', 'select=*&active=eq.true');
    const horizonDays = (raw.seasonal_horizon_weeks || 26) * 7;
    const today = new Date();

    const live = [];
    const waiting = [];

    for (const season of seasons) {
      const w = S.window(season, today);
      if (!w.ready) {
        // A season missing its lead time is not silently dropped.
        // Dropping it is precisely how Christmas gets missed.
        waiting.push({ season: season.name, reasons: w.reasons });
        continue;
      }
      if (w.daysToOrderBy > horizonDays) continue;
      live.push({ season, window: w });
    }

    // ---- 3. Score what our suppliers can actually give us ---------
    const categories  = index(await db.select('category_settings', 'select=*'), 'category');
    const candidates  = index(await db.select('sourcing_candidates', 'select=*'), 'supplier_product_id');
    const seasonalSup = await db.select('season_supplier_products', 'select=*');
    const seasonalCmp = await db.select('season_competitor_products', 'select=*');

    const supBySeason = groupBy(seasonalSup, 'season_id');

    const scored = [];

    for (const entry of live) {
      // One row per product, not one per matching word. A pumpkin
      // lantern matches "halloween" AND "pumpkin", and without this
      // it would appear on the shortlist twice — the same product,
      // the same numbers, asking to be decided on twice.
      const links = dedupeByProduct(supBySeason[entry.season.id] || []);

      for (const link of links) {
        const c = candidates[link.supplier_product_id];
        // No competitor comparison means nothing to price against.
        // The main engine treats that as silence and so does this.
        if (!c) continue;

        const category = categories[c.category] || {};

        const compliance = M.complianceCheck({
          name: c.supplier_name,
          is_uk_responsible_person: c.is_uk_responsible_person,
          rp_evidence: c.rp_evidence,
          ships_from_country: c.ships_from_country
        }, category);

        const result = M.evaluate({
          costPricePence:    c.cost_price_pence,
          deliveryCostPence: c.delivery_cost_pence,
          competitorPrices:  c.competitor_prices || [],
          weeksObserved:     Number(c.weeks_observed) || 0,
          settings:          settings,
          category: {
            category: c.category,
            returnRate: category.return_rate,
            returnHandlingCostPence: category.return_handling_cost_pence
          }
        });

        if (!result.ok) continue;

        const notes = result.confidenceNotes.slice();

        notes.push(
          'Seasonal: ' + entry.season.name + '. ' + entry.window.plain);

        // Seasonal stock is the one place where being wrong is
        // expensive in a way the margin does not show. An everyday
        // product that does not sell keeps sitting there. A
        // Halloween product that does not sell by 1 November is
        // worth roughly nothing until next year.
        notes.push(
          'Seasonal goods that do not sell in their window are not simply slow — they are dead ' +
          'until the same week next year. On a dropship model Packet is not holding the stock, ' +
          'so the risk is smaller, but any minimum order or committed buy carries it in full.');

        if (c.fuzzy_matches > 0) {
          notes.push(
            c.fuzzy_matches + ' of ' + c.total_matches + ' comparisons were matched on the ' +
            'title rather than a barcode. Confirm them before trusting the price.');
          if (result.confidence === 'good') result.confidence = 'partial';
        }

        if (['approved', 'sample_passed'].indexOf(c.supplier_status) === -1) {
          notes.push(
            c.supplier_name + ' has not passed a sample order yet (' + c.supplier_status + '). ' +
            'On a dated range there is no second chance to find that out.');
        }

        if (!c.in_stock) notes.push('The supplier is showing this as out of stock.');

        scored.push({
          run_id: runId,
          supplier_product_id: c.supplier_product_id,
          category: c.category,
          season_id: entry.season.id,
          order_by_date: entry.window.orderByDate,
          season_stage: entry.window.stage,

          n_competitors:           c.n_competitor_stores,
          competitor_min_pence:    result.competitorMinPence,
          competitor_median_pence: result.competitorMedianPence,
          competitor_max_pence:    result.competitorMaxPence,

          suggested_price_pence:        result.suggestedPricePence,
          landed_cost_pence:            result.landedCostPence,
          fees_pence:                   result.feesPence,
          expected_return_cost_pence:   result.expectedReturnCostPence,
          contribution_pence:           result.contributionPence,
          contribution_pct:             result.contributionPct,
          contribution_after_ads_pence: result.contributionAfterAdsPence,

          weeks_observed: result.weeksObserved,
          demand_signal:  result.demandSignal,
          score: compliance.status === 'blocked' ? 0 : result.score,

          compliance_status: compliance.status,
          compliance_reason: compliance.reason,

          data_confidence: result.confidence,
          confidence_notes: notes,

          breakdown: {
            supplier:     c.supplier_name,
            product:      c.title,
            sku:          c.sku,
            product_url:  c.product_url,
            price_source: result.priceSource,
            season:       entry.season.name,
            season_event: entry.window.eventDate,
            order_by:     entry.window.orderByDate,
            sell_from:    entry.window.sellFromDate,
            matched_term: link.matched_term,
            cost:         result.costBreakdown,
            fees:         result.feeBreakdown,
            net_revenue:  result.netRevenuePence,
            vat_due:      result.vatDuePence,
            return_rate_known: result.returnRateKnown,
            cpa_pence:    result.cpaPence,
            meets_minimum: result.meetsMinimum,
            meets_target:  result.meetsTarget,
            matches:      { total: c.total_matches, fuzzy: c.fuzzy_matches },
            settings_used: settings
          }
        });
      }
    }

    // ---- 4. Keep the best few per season --------------------------
    const perSeason = raw.max_candidates_per_category || 5;
    const kept = topPerSeason(scored, perSeason);

    // Only the seasonal rows nobody has touched. The everyday
    // shortlist is written by build-opportunities and must be left
    // completely alone, and any seasonal row a human has already
    // shortlisted, approved or rejected stays exactly where it is.
    await db.del('opportunities', 'status=eq.new&season_id=not.is.null');
    if (kept.length) await db.insert('opportunities', kept);

    // ---- 5. The gaps ----------------------------------------------
    const gaps = buildGaps(live, seasonalCmp, seasonalSup, runId);
    await db.del('season_gaps', 'id=not.is.null');
    if (gaps.length) await db.insert('season_gaps', gaps);

    await db.patch('sourcing_runs', 'id=eq.' + runId, {
      status: 'complete',
      finished_at: new Date().toISOString(),
      supplier_products: scored.length,
      opportunities_created: kept.length,
      error: waiting.length
        ? waiting.length + ' season(s) skipped, waiting on lead times: ' +
          waiting.map(w => w.season).join(', ')
        : null
    });

    return json(200, {
      ok: true,
      seasons_live: live.length,
      seasons_waiting: waiting.map(w => w.season),
      shortlisted: kept.length,
      gaps: gaps.length
    });

  } catch (err) {
    console.error('build-seasonal failed', err);
    if (runId) {
      await db.patch('sourcing_runs', 'id=eq.' + runId, {
        status: 'failed',
        finished_at: new Date().toISOString(),
        error: String(err.message).slice(0, 1000)
      }).catch(() => {});
    }
    return json(500, { error: 'Seasonal build failed' });
  }
};


// ---------------------------------------------------------------- gaps

// "Four shops are selling shamrock accessories and not one of our
// suppliers lists anything matching." That is the answer worth
// having, and it is only worth having while there is still time to
// go and find a supplier — hence it being computed against the same
// order-by dates as the shortlist.
//
// Every figure here is counted from listings that have actually been
// read. Nothing is inferred and nothing is AI.
function buildGaps(live, competitorRows, supplierRows, runId) {
  const cmpBySeason = groupBy(competitorRows, 'season_id');
  const supBySeason = groupBy(supplierRows, 'season_id');
  const out = [];

  for (const entry of live) {
    const cmp = cmpBySeason[entry.season.id] || [];
    const sup = supBySeason[entry.season.id] || [];

    const byTerm    = groupBy(cmp, 'matched_term');
    const supByTerm = groupBy(sup, 'matched_term');

    for (const term of Object.keys(byTerm)) {
      const rows   = byTerm[term];
      const stores = new Set(rows.map(r => r.competitor_id));
      const prices = rows.map(r => r.price_pence).filter(p => typeof p === 'number');

      out.push({
        run_id: runId,
        season_id: entry.season.id,
        term: term,
        n_competitor_stores: stores.size,
        n_competitor_products: rows.length,
        competitor_median_pence: M.median(prices),
        n_supplier_products: (supByTerm[term] || []).length,
        // A handful of real listings, so a gap can be looked at
        // rather than taken on trust.
        examples: rows.slice(0, 5).map(r => ({
          title: r.title,
          price_pence: r.price_pence,
          url: r.product_url
        }))
      });
    }
  }

  // The gaps first: what several shops sell and we cannot.
  return out.sort((a, b) => {
    const aGap = a.n_supplier_products === 0 ? 1 : 0;
    const bGap = b.n_supplier_products === 0 ? 1 : 0;
    if (aGap !== bGap) return bGap - aGap;
    return b.n_competitor_stores - a.n_competitor_stores;
  });
}


// ---------------------------------------------------------------- helpers

// Top N per season rather than top N overall, for the same reason
// build-opportunities does it per category: without it Christmas
// fills the entire list every autumn and St Patrick's Day is never
// looked at until it has gone.
//
// Blocked rows are carried separately and always shown. "We cannot
// sell this and here is why" is worth knowing once.
function topPerSeason(rows, n) {
  const bySeason = {};
  for (const r of rows) {
    (bySeason[r.season_id] = bySeason[r.season_id] || []).push(r);
  }

  const out = [];
  for (const key of Object.keys(bySeason)) {
    const list = bySeason[key];
    const blocked = list.filter(r => r.compliance_status === 'blocked');
    const rest    = list.filter(r => r.compliance_status !== 'blocked')
                        .sort((a, b) => b.score - a.score)
                        .slice(0, n);
    out.push(...rest, ...blocked);
  }
  return out;
}

// Collapses the several words a product matched into one row,
// keeping all of them so the shortlist can say why it was picked
// up. Sorted so the same product always reports its words in the
// same order rather than in whatever order the database returned.
function dedupeByProduct(links) {
  const byProduct = new Map();
  for (const l of links) {
    const existing = byProduct.get(l.supplier_product_id);
    if (existing) existing.terms.push(l.matched_term);
    else byProduct.set(l.supplier_product_id, {
      supplier_product_id: l.supplier_product_id,
      terms: [l.matched_term]
    });
  }
  return Array.from(byProduct.values()).map(p => ({
    supplier_product_id: p.supplier_product_id,
    matched_term: p.terms.sort().join(', ')
  }));
}

function groupBy(rows, key) {
  const out = {};
  for (const r of rows || []) (out[r[key]] = out[r[key]] || []).push(r);
  return out;
}

function index(rows, key) {
  const out = {};
  for (const r of rows || []) out[r[key]] = r;
  return out;
}

function camel(row) {
  const out = {};
  for (const k of Object.keys(row || {})) {
    out[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = row[k];
  }
  return out;
}

async function authorise(event, url, serviceKey) {
  const secret = process.env.SOURCING_CRON_SECRET;
  if (secret && event.headers['x-sourcing-secret'] === secret) return true;

  try {
    if (JSON.parse(event.body || '{}').next_run) return true;
  } catch { /* not JSON */ }

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
    apikey: serviceKey,
    authorization: 'Bearer ' + serviceKey,
    'content-type': 'application/json'
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
    insert: (table, row) => call('POST', table, row, 'return=representation'),
    patch:  (table, query, row) => call('PATCH', table + '?' + query, row),
    del:    (table, query) => call('DELETE', table + '?' + query)
  };
}

function json(statusCode, obj) {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) };
}

exports._internal = { topPerSeason, buildGaps, groupBy, dedupeByProduct };
