// ============================================================
// Packet — Netlify Function: build-opportunities
// Built from the AXRIK starter kit under licence. Kit v1.1.0.
// ============================================================
// Turns "here is what our suppliers sell and what our competitors
// charge" into "here are five things worth considering this week,
// and here is exactly why".
//
// It writes rows to opportunities with status 'new'. That is all it
// does. It cannot approve anything, it cannot price anything live,
// and it does not touch Shopify. A human reads the shortlist and
// decides, which is the whole design.
//
// The order of work matters:
//   1. Refuse outright if the commercial settings are not filled in.
//      A margin built on invented fees is worse than no margin.
//   2. Rebuild the matches between supplier and competitor products.
//   3. Compliance first, arithmetic second. There is no point
//      pricing something Packet cannot lawfully sell.
//   4. Keep the top few per category, not the top few overall, so
//      one strong category cannot crowd out the rest.
//
// SETUP: Netlify -> Environment variables ->
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SOURCING_CRON_SECRET
// Scheduled from netlify.toml. No npm dependencies — native fetch.
// ============================================================

const M = require('../admin/packet-margin.js');

const FUZZY_THRESHOLD = 0.45;

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
      // Deliberately a hard stop with a plain reason, not a silent
      // empty result. Somebody opening the admin should be told the
      // engine is waiting on them, not left wondering why the
      // shortlist is blank.
      await db.patch('sourcing_runs', 'id=eq.' + runId, {
        status: 'blocked',
        finished_at: new Date().toISOString(),
        blocked_reason: 'Waiting on: ' + missing.join(', ') +
          '. Fill these in under Sourcing → Settings. They are blank on purpose — ' +
          'a made-up fee turns into a made-up margin.'
      });
      return json(200, { ok: false, blocked: true, missing });
    }

    // ---- 2. Rebuild the matches ----------------------------------
    const matchesMade = await db.rpc('build_product_matches', { min_similarity: FUZZY_THRESHOLD });

    // ---- 3. Score everything -------------------------------------
    const categories = index(await db.select('category_settings', 'select=*'), 'category');
    const candidates = await db.select('sourcing_candidates', 'select=*');

    const scored = [];

    for (const c of candidates) {
      const category = categories[c.category] || {};

      const compliance = M.complianceCheck({
        name: c.supplier_name,
        is_uk_responsible_person: c.is_uk_responsible_person,
        rp_evidence: c.rp_evidence,
        ships_from_country: c.ships_from_country
      }, category);

      const result = M.evaluate({
        costPricePence:   c.cost_price_pence,
        deliveryCostPence: c.delivery_cost_pence,
        competitorPrices: c.competitor_prices || [],
        weeksObserved:    Number(c.weeks_observed) || 0,
        settings:         settings,
        category:         {
          category: c.category,
          returnRate: category.return_rate,
          returnHandlingCostPence: category.return_handling_cost_pence
        }
      });

      // Unpriceable is not a shortlist entry. It is silence.
      if (!result.ok) continue;

      const notes = result.confidenceNotes.slice();

      // How much of this rests on a guess. On unbranded goods every
      // comparison is a title match, and a title match means "similar
      // sort of thing" rather than "the same item".
      if (c.fuzzy_matches > 0) {
        notes.push(
          c.fuzzy_matches + ' of ' + c.total_matches + ' comparisons were matched on the ' +
          'title rather than a barcode. Confirm them before trusting the price.');
        if (result.confidence === 'good') result.confidence = 'partial';
      }

      // Supplier proving. Not a block — Phil's call is that commodity
      // goods do not each need a sample — but it belongs on the row,
      // because a sample proves the supplier, not the product.
      if (['approved', 'sample_passed'].indexOf(c.supplier_status) === -1) {
        notes.push(
          c.supplier_name + ' has not passed a sample order yet (' + c.supplier_status + '). ' +
          'Dispatch time, packaging and quality are all still unverified.');
      }

      if (!c.in_stock) notes.push('The supplier is showing this as out of stock.');

      scored.push({
        run_id: runId,
        supplier_product_id: c.supplier_product_id,
        category: c.category,

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
        // A blocked row still gets stored and still gets scored, so it
        // shows up on the screen as a thing that was considered and
        // refused. Deleting it would just mean rediscovering it, and
        // arguing about it, every single week.
        score: compliance.status === 'blocked' ? 0 : result.score,

        compliance_status: compliance.status,
        compliance_reason: compliance.reason,

        data_confidence: result.confidence,
        confidence_notes: notes,

        breakdown: {
          supplier:       c.supplier_name,
          product:        c.title,
          sku:            c.sku,
          product_url:    c.product_url,
          price_source:   result.priceSource,
          cost:           result.costBreakdown,
          fees:           result.feeBreakdown,
          net_revenue:    result.netRevenuePence,
          vat_due:        result.vatDuePence,
          return_rate_known: result.returnRateKnown,
          cpa_pence:      result.cpaPence,
          meets_minimum:  result.meetsMinimum,
          meets_target:   result.meetsTarget,
          matches:        { total: c.total_matches, fuzzy: c.fuzzy_matches },
          settings_used:  settings
        }
      });
    }

    // ---- 4. Keep the best few per category ------------------------
    const perCategory = raw.max_candidates_per_category || 5;
    const kept = topPerCategory(scored, perCategory);

    // Clear last week's undecided rows. Anything a human has touched —
    // shortlisted, approved, rejected — is left exactly where it is.
    // Rejections in particular must survive, or the same product comes
    // back every week and gets argued about again.
    await db.del('opportunities', 'status=eq.new');
    if (kept.length) await db.insert('opportunities', kept);

    await db.patch('sourcing_runs', 'id=eq.' + runId, {
      status: 'complete',
      finished_at: new Date().toISOString(),
      supplier_products: candidates.length,
      matches_made: matchesMade || 0,
      opportunities_created: kept.length
    });

    return json(200, {
      ok: true,
      considered: candidates.length,
      shortlisted: kept.length,
      blocked: kept.filter(k => k.compliance_status === 'blocked').length
    });

  } catch (err) {
    console.error('build-opportunities failed', err);
    if (runId) {
      await db.patch('sourcing_runs', 'id=eq.' + runId, {
        status: 'failed',
        finished_at: new Date().toISOString(),
        error: String(err.message).slice(0, 1000)
      }).catch(() => {});
    }
    return json(500, { error: 'Build failed' });
  }
};


// ---------------------------------------------------------------- helpers

// Top N per category rather than top N overall. Without this, one
// category with fat margins fills the whole list every week and the
// others are never looked at — which defeats the point of watching
// several categories at once.
//
// Blocked rows are carried separately and always shown, because
// "we cannot sell this and here is why" is information worth having
// once, not a thing to be quietly filtered out.
function topPerCategory(rows, n) {
  const byCategory = {};
  for (const r of rows) {
    const key = r.category || 'uncategorised';
    (byCategory[key] = byCategory[key] || []).push(r);
  }

  const out = [];
  for (const key of Object.keys(byCategory)) {
    const list = byCategory[key];
    const blocked = list.filter(r => r.compliance_status === 'blocked');
    const rest    = list.filter(r => r.compliance_status !== 'blocked')
                        .sort((a, b) => b.score - a.score)
                        .slice(0, n);
    out.push(...rest, ...blocked);
  }
  return out;
}

// sourcing_settings uses snake_case; the margin engine takes camelCase.
function camel(row) {
  const out = {};
  for (const k of Object.keys(row || {})) {
    out[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = row[k];
  }
  return out;
}

function index(rows, key) {
  const out = {};
  for (const r of rows || []) out[r[key]] = r;
  return out;
}

// Same gate as scan-competitors: the scheduler, a shared secret, or a
// signed-in owner or staff account. This one writes recommendations
// rather than reading public pages, but it still cannot approve or
// publish anything, and it returns counts only.
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
    del:    (table, query) => call('DELETE', table + '?' + query),
    rpc:    (fn, args) => call('POST', 'rpc/' + fn, args)
  };
}

function json(statusCode, obj) {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) };
}

exports._internal = { topPerCategory, camel };
