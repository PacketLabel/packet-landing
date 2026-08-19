// ============================================================
// Packet — Netlify Function: sourcing-assistant
// Built from the AXRIK starter kit under licence. Kit v1.1.0.
// ============================================================
// The ask box. Either owner types an ordinary sentence into the
// admin and the sourcing tool works out which of a fixed set of
// changes was meant, writes it back in plain English, and waits
// to be told to go ahead.
//
// ── Three separate jobs, deliberately separated ─────────────
//
//   1. UNDERSTAND. Turn a sentence into a list of proposed
//      actions. This is the only part that is AI, and it is the
//      part that is allowed to be wrong, because nothing it
//      produces is trusted.
//
//   2. VALIDATE. Check every proposed action against a hard
//      allow-list, in ordinary code, here. Anything unrecognised
//      is dropped, not "interpreted". Every string is trimmed
//      and length-capped, every number is bounds-checked, every
//      URL has to look like a URL.
//
//   3. DESCRIBE, then wait. The sentence shown to the person
//      before they confirm is generated from the VALIDATED
//      actions by the plain code below — never from the model's
//      own prose. If those two ever disagreed, the person would
//      be approving one thing and getting another, which is the
//      failure that matters most in this whole feature.
//
// ── What it cannot do, at all ───────────────────────────────
// It cannot touch a fee, a rate, a margin threshold or the
// Responsible Person flag. Those are not omitted from the prompt
// — they are absent from the allow-list here and absent from the
// CHECK constraint in migration 008. Three layers, because the
// prompt is the only one of the three that can be argued with.
//
// ── The non-AI path ─────────────────────────────────────────
// Per the kit rule, no AI feature is ever the only path. If
// ANTHROPIC_API_KEY is missing or the call fails, a small pattern
// parser handles the obvious phrasings. If that cannot understand
// it either, the answer is "I did not understand that, here is
// where to do it by hand" — never a guess.
//
// SETUP: Netlify -> Environment variables ->
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   ANTHROPIC_API_KEY (optional — without it the pattern parser
//   is used and the box says so)
// No npm dependencies — native fetch.
// ============================================================

const MAX_QUESTION = 500;
const MAX_ACTIONS  = 12;
const MAX_TEXT     = 120;

// Everything the box is permitted to do. Mirrors the CHECK
// constraint in 008 exactly. If you add one here, add it there.
const ALLOWED = [
  'add_competitor',
  'pause_competitor',
  'resume_competitor',
  'add_supplier',
  'add_season',
  'pause_season',
  'resume_season',
  'add_season_term',
  'remove_season_term',
  'set_season_lead_times'
];


exports.handler = async (event) => {
  const url        = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return json(503, { error: 'Supabase not configured' });

  const who = await whoami(event, url, serviceKey);
  if (!who) return json(401, { error: 'Not authorised' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const db = restClient(url, serviceKey);

  try {
    if (body.confirm && body.requestId) return await applyRequest(db, body.requestId, who);
    if (body.reject  && body.requestId) return await rejectRequest(db, body.requestId);
    return await proposeRequest(db, body.question, who);
  } catch (err) {
    console.error('sourcing-assistant failed', err);
    return json(500, { error: 'That did not work. Nothing has been changed.' });
  }
};


// ---------------------------------------------------------------- 1. propose

async function proposeRequest(db, question, who) {
  const q = String(question || '').trim().slice(0, MAX_QUESTION);
  if (!q) return json(400, { error: 'Nothing was asked.' });

  // Context so the model can refer to things by the names actually
  // in use. Names and slugs only — no cost prices, no margins, no
  // settings. There is no reason for any of that to leave the
  // database for this.
  const [competitors, seasons] = await Promise.all([
    db.select('competitors', 'select=name,active'),
    db.select('seasons', 'select=slug,name,active,source_lead_weeks,sell_from_weeks_before')
  ]);

  let parsed = await askModel(q, competitors, seasons);
  let parsedBy = 'ai';

  if (!parsed) {
    parsed = patternParse(q);
    parsedBy = parsed.length ? 'pattern' : 'none';
  }

  const { actions, dropped } = validateActions(parsed);

  if (!actions.length) {
    const row = await db.insert('assistant_requests', {
      question: q,
      asked_by: who.id,
      actions: [],
      preview: null,
      parsed_by: 'none',
      status: 'not_understood'
    });
    return json(200, {
      ok: false,
      understood: false,
      requestId: row && row[0] && row[0].id,
      message: notUnderstoodMessage(dropped)
    });
  }

  const preview = describe(actions);

  const row = await db.insert('assistant_requests', {
    question: q,
    asked_by: who.id,
    actions: actions,
    preview: preview,
    parsed_by: parsedBy,
    status: 'proposed'
  });

  return json(200, {
    ok: true,
    understood: true,
    requestId: row && row[0] && row[0].id,
    preview: preview,
    actions: actions,
    parsedBy: parsedBy,
    dropped: dropped
  });
}

function notUnderstoodMessage(dropped) {
  var base = 'I did not understand that as a change I am allowed to make. ';
  if (dropped.length) {
    base += 'The nearest thing I got was ' + dropped.slice(0, 3).join(', ') +
            ', which is outside what this box can do. ';
  }
  return base +
    'This box handles competitors, suppliers, seasons and the words that make a product ' +
    'seasonal. It cannot change any fee, rate or margin setting, and it cannot change ' +
    'whether a supplier holds the Responsible Person role — those are typed in by hand ' +
    'under Settings and Suppliers, on purpose.';
}


// ---------------------------------------------------------------- 2. validate

// Nothing from the model is trusted. Each action is rebuilt field
// by field from scratch: if a field is not explicitly copied
// across here, it does not exist as far as the rest of the system
// is concerned.
function validateActions(raw) {
  const actions = [];
  const dropped = [];

  const list = Array.isArray(raw) ? raw.slice(0, MAX_ACTIONS) : [];

  for (const a of list) {
    if (!a || typeof a !== 'object') { dropped.push('an unreadable instruction'); continue; }
    const type = String(a.type || '').trim();

    if (ALLOWED.indexOf(type) === -1) {
      dropped.push('"' + type.slice(0, 40) + '"');
      continue;
    }

    const built = buildAction(type, a);
    if (built) actions.push(built);
    else dropped.push('"' + type + '" without enough detail to act on');
  }

  return { actions, dropped };
}

function buildAction(type, a) {
  switch (type) {
    case 'add_competitor': {
      const name = text(a.name), website = website_(a.website);
      if (!name || !website) return null;
      return { type, name, website, platform: platform_(a.platform) };
    }

    case 'pause_competitor':
    case 'resume_competitor': {
      const name = text(a.name);
      return name ? { type, name } : null;
    }

    case 'add_supplier': {
      const name = text(a.name);
      if (!name) return null;
      // Note what is NOT copied across: is_uk_responsible_person.
      // A supplier created this way always starts as not holding
      // the role, which means the compliance gate keeps refusing
      // their cosmetics until a human ticks the box with evidence.
      const out = { type, name };
      const w = website_(a.website);
      if (w) out.website = w;
      return out;
    }

    case 'add_season': {
      const name = text(a.name);
      const slug = slug_(a.slug || a.name);
      const rule = ['fixed', 'nth_weekday', 'easter_offset'].indexOf(String(a.date_rule)) > -1
        ? String(a.date_rule) : null;
      if (!name || !slug || !rule) return null;

      const out = { type, slug, name, date_rule: rule, day_offset: int_(a.day_offset, -60, 60) || 0 };

      if (rule === 'fixed') {
        out.event_month = int_(a.event_month, 1, 12);
        out.event_day   = int_(a.event_day, 1, 31);
        if (out.event_month === null || out.event_day === null) return null;
      } else if (rule === 'nth_weekday') {
        out.event_month   = int_(a.event_month, 1, 12);
        out.event_weekday = int_(a.event_weekday, 0, 6);
        out.event_nth     = int_(a.event_nth, -1, 5);
        if (out.event_month === null || out.event_weekday === null || out.event_nth === null) return null;
      }
      // Deliberately absent: source_lead_weeks and
      // sell_from_weeks_before. A new season starts with no lead
      // time, exactly like the seeded ones, and the calendar says
      // so until somebody has actually asked a supplier.
      return out;
    }

    case 'pause_season':
    case 'resume_season': {
      const slug = slug_(a.slug);
      return slug ? { type, slug } : null;
    }

    case 'add_season_term':
    case 'remove_season_term': {
      const slug = slug_(a.slug), term = text(a.term);
      return slug && term ? { type, slug, term: term.toLowerCase() } : null;
    }

    case 'set_season_lead_times': {
      const slug = slug_(a.slug);
      if (!slug) return null;
      const out = { type, slug };
      const lead = int_(a.source_lead_weeks, 0, 104);
      const sell = int_(a.sell_from_weeks_before, 0, 104);
      const tail = int_(a.sell_until_days_after, 0, 120);
      if (lead !== null) out.source_lead_weeks = lead;
      if (sell !== null) out.sell_from_weeks_before = sell;
      if (tail !== null) out.sell_until_days_after = tail;
      // Nothing to set is not an instruction.
      if (lead === null && sell === null && tail === null) return null;
      return out;
    }

    default:
      return null;
  }
}

function text(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
  return s.length ? s : null;
}

function slug_(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).toLowerCase().trim()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return s.length ? s : null;
}

// Only http and https, and only something shaped like a host.
// Anything else — a file path, a javascript: URL, a bare word —
// is not a website and is refused rather than repaired.
function website_(v) {
  if (v === null || v === undefined) return null;
  let s = String(v).trim().slice(0, 200);
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname)) return null;
    return u.origin;
  } catch {
    return null;
  }
}

function platform_(v) {
  const s = String(v || '').toLowerCase();
  return ['shopify', 'woocommerce', 'other', 'unknown'].indexOf(s) > -1 ? s : 'unknown';
}

function int_(v, min, max) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!isFinite(n) || Math.floor(n) !== n) return null;
  if (n < min || n > max) return null;
  return n;
}


// ---------------------------------------------------------------- 3. describe

// The sentence the person reads before pressing the button.
// Generated here, from the validated actions, in ordinary code —
// so what is described and what would happen cannot come apart.
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December'];
const ORDINAL = { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', 5: 'fifth', '-1': 'last' };

function describe(actions) {
  return actions.map(describeOne).map((s, i) => (i + 1) + '. ' + s).join('\n');
}

function describeOne(a) {
  switch (a.type) {
    case 'add_competitor':
      return 'Start watching ' + a.name + ' at ' + a.website +
             (a.platform === 'shopify'
               ? ' as a Shopify shop, so the weekly scan can read their prices automatically.'
               : ' as a ' + a.platform + ' shop. Only Shopify shops can be read automatically, ' +
                 'so this one will need watching by hand until the platform is set.');

    case 'pause_competitor':
      return 'Stop scanning ' + a.name + '. Everything already recorded about them is kept.';

    case 'resume_competitor':
      return 'Start scanning ' + a.name + ' again.';

    case 'add_supplier':
      return 'Add ' + a.name + ' as a supplier' + (a.website ? ' (' + a.website + ')' : '') +
             ', at prospect stage, not holding the UK Responsible Person role. ' +
             'That last part cannot be set from here — until somebody ticks it by hand with ' +
             'evidence, the tool will refuse to shortlist any cosmetics from them.';

    case 'add_season': {
      let when;
      if (a.date_rule === 'fixed') {
        when = 'on ' + a.event_day + ' ' + MONTHS[a.event_month - 1] + ' each year';
      } else if (a.date_rule === 'nth_weekday') {
        when = 'on the ' + (ORDINAL[a.event_nth] || a.event_nth + 'th') + ' ' +
               WEEKDAYS[a.event_weekday] + ' in ' + MONTHS[a.event_month - 1];
      } else {
        when = a.day_offset === 0 ? 'on Easter Sunday'
             : Math.abs(a.day_offset) + ' days ' + (a.day_offset < 0 ? 'before' : 'after') + ' Easter';
      }
      if (a.day_offset && a.date_rule !== 'easter_offset') {
        when += ', shifted by ' + a.day_offset + ' day' + (Math.abs(a.day_offset) === 1 ? '' : 's');
      }
      return 'Add "' + a.name + '" to the calendar, falling ' + when +
             '. It will have no lead time, so the calendar will list it as waiting on you ' +
             'for how many weeks a supplier needs and how early people start buying.';
    }

    case 'pause_season':
      return 'Stop looking for products for "' + a.slug + '".';

    case 'resume_season':
      return 'Start looking for products for "' + a.slug + '" again.';

    case 'add_season_term':
      return 'Treat a product as belonging to "' + a.slug + '" when its title contains "' +
             a.term + '".';

    case 'remove_season_term':
      return 'Stop treating "' + a.term + '" as a sign that a product belongs to "' + a.slug + '".';

    case 'set_season_lead_times': {
      const bits = [];
      if (a.source_lead_weeks !== undefined) {
        bits.push('a sourcing lead time of ' + a.source_lead_weeks + ' week' +
                  (a.source_lead_weeks === 1 ? '' : 's'));
      }
      if (a.sell_from_weeks_before !== undefined) {
        bits.push('selling from ' + a.sell_from_weeks_before + ' week' +
                  (a.sell_from_weeks_before === 1 ? '' : 's') + ' before the day');
      }
      if (a.sell_until_days_after !== undefined) {
        bits.push('keeping it up for ' + a.sell_until_days_after + ' day' +
                  (a.sell_until_days_after === 1 ? '' : 's') + ' afterwards');
      }
      return 'Set "' + a.slug + '" to ' + bits.join(', ') +
             '. This is the number the order-by date is calculated from, so put in what a ' +
             'supplier has actually told you rather than an estimate.';
    }

    default:
      return 'Something unrecognised, which will not be carried out.';
  }
}


// ---------------------------------------------------------------- the model

// Returns an array of proposed actions, or null so the caller
// falls back to the pattern parser. Never throws.
async function askModel(question, competitors, seasons) {
  const base = process.env.URL || process.env.DEPLOY_URL;
  if (!base) return null;

  const system =
    'You turn a shop owner\'s instruction into a list of actions for a product sourcing tool. ' +
    'Reply with JSON only: an array of objects, each with a "type" field. No prose, no code fence.\n\n' +
    'The ONLY permitted types are:\n' +
    'add_competitor {name, website, platform: "shopify"|"other"|"unknown"}\n' +
    'pause_competitor {name}\n' +
    'resume_competitor {name}\n' +
    'add_supplier {name, website}\n' +
    'add_season {slug, name, date_rule: "fixed"|"nth_weekday"|"easter_offset", event_month, event_day, event_weekday (0=Sunday), event_nth (-1=last), day_offset}\n' +
    'pause_season {slug}\n' +
    'resume_season {slug}\n' +
    'add_season_term {slug, term}\n' +
    'remove_season_term {slug, term}\n' +
    'set_season_lead_times {slug, source_lead_weeks, sell_from_weeks_before, sell_until_days_after}\n\n' +
    'If the instruction asks for anything else — changing a fee, a VAT rate, a margin, a ' +
    'threshold, whether a supplier is a UK Responsible Person, approving or rejecting a ' +
    'product, or anything to do with users or customers — return an empty array []. Do not ' +
    'substitute a similar action. An empty array is the correct and expected answer for ' +
    'anything outside the list.\n\n' +
    'Never invent a lead time. Only include set_season_lead_times if the instruction states ' +
    'the number explicitly.\n' +
    'Return [] if you are unsure.';

  const prompt =
    'Competitors already tracked: ' +
      (competitors.map(c => c.name).join(', ') || 'none') + '\n' +
    'Seasons already on the calendar (slug — name): ' +
      (seasons.map(s => s.slug + ' — ' + s.name).join('; ') || 'none') + '\n\n' +
    'Instruction: ' + question;

  try {
    const resp = await fetch(base + '/.netlify/functions/ai', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ system, prompt, max_tokens: 900 })
    });
    const data = await resp.json();
    if (!resp.ok || data.fallback || !data.text) return null;

    const cleaned = String(data.text).replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : null;
  } catch (err) {
    console.error('assistant model unavailable', err && err.message);
    return null;
  }
}


// ---------------------------------------------------------------- the fallback

// The non-AI path. Handles the phrasings people actually use most,
// and nothing more. Anything it cannot match returns an empty list,
// which becomes an honest "I did not understand that" rather than a
// guess. Guessing here would mean changing the wrong shop's record.
function patternParse(question) {
  const q = String(question || '').trim();
  const out = [];

  // add competitor <name> <url>   /   watch <url> as <name>
  let m = q.match(/^\s*(?:add|watch|track)\s+(?:a\s+)?(?:new\s+)?competitor\s+(.+)$/i);
  if (m) {
    const rest = m[1];
    const urlM = rest.match(/(https?:\/\/\S+|\b[a-z0-9-]+\.[a-z]{2,}(?:\.[a-z]{2,})?\b)/i);
    const name = rest.replace(/(https?:\/\/\S+|\b[a-z0-9-]+\.[a-z]{2,}(?:\.[a-z]{2,})?\b)/i, '')
                     .replace(/\b(called|named|at|as|the)\b/gi, ' ').trim();
    if (urlM) {
      out.push({
        type: 'add_competitor',
        name: name || urlM[1].replace(/^https?:\/\//i, '').replace(/^www\./i, ''),
        website: urlM[1],
        platform: /woo/i.test(rest) ? 'woocommerce' : /shopify/i.test(rest) ? 'shopify' : 'unknown'
      });
      return out;
    }
  }

  // stop / pause watching <name>
  m = q.match(/^\s*(?:stop|pause)\s+(?:watching|scanning|tracking)\s+(.+?)\s*$/i);
  if (m) { out.push({ type: 'pause_competitor', name: m[1] }); return out; }

  // add supplier <name>
  m = q.match(/^\s*add\s+(?:a\s+)?(?:new\s+)?supplier\s+(?:called\s+|named\s+)?(.+?)\s*$/i);
  if (m) { out.push({ type: 'add_supplier', name: m[1] }); return out; }

  // add the word <term> to <slug>
  m = q.match(/^\s*add\s+(?:the\s+)?(?:word|term|keyword)\s+["“]?(.+?)["”]?\s+to\s+(.+?)\s*$/i);
  if (m) { out.push({ type: 'add_season_term', slug: m[2], term: m[1] }); return out; }

  // remove the word <term> from <slug>
  m = q.match(/^\s*(?:remove|delete|drop)\s+(?:the\s+)?(?:word|term|keyword)\s+["“]?(.+?)["”]?\s+from\s+(.+?)\s*$/i);
  if (m) { out.push({ type: 'remove_season_term', slug: m[2], term: m[1] }); return out; }

  // stop looking for <slug>
  m = q.match(/^\s*(?:stop|pause)\s+(?:looking for|sourcing for|doing)\s+(.+?)\s*$/i);
  if (m) { out.push({ type: 'pause_season', slug: m[1] }); return out; }

  return out;
}


// ---------------------------------------------------------------- 4. apply

async function applyRequest(db, requestId, who) {
  const rows = await db.select('assistant_requests', 'select=*&id=eq.' + encodeURIComponent(requestId));
  const req = rows && rows[0];
  if (!req) return json(404, { error: 'That request no longer exists.' });
  if (req.status !== 'proposed') {
    return json(409, { error: 'That request has already been dealt with (' + req.status + ').' });
  }

  // Re-validated on the way out as well as on the way in. The row
  // in the database is the only thing trusted here, and it is
  // checked again anyway — the cost is nothing and it means a
  // hand-edited row still cannot widen what is possible.
  const { actions } = validateActions(req.actions);
  if (!actions.length) {
    await db.patch('assistant_requests', 'id=eq.' + requestId, {
      status: 'failed', result: 'Nothing valid left to carry out.'
    });
    return json(400, { error: 'There was nothing valid left to carry out.' });
  }

  const done = [];
  const problems = [];

  for (const a of actions) {
    try {
      const line = await applyOne(db, a);
      done.push(line);
    } catch (err) {
      problems.push(describeOne(a) + ' — ' + (err.message || 'failed'));
    }
  }

  const result = done.concat(problems.map(p => 'DID NOT WORK: ' + p)).join('\n');

  await db.patch('assistant_requests', 'id=eq.' + requestId, {
    status: problems.length && !done.length ? 'failed' : 'applied',
    applied_by: who.id,
    result: result.slice(0, 4000)
  });

  return json(200, { ok: !problems.length, done, problems, result });
}

async function applyOne(db, a) {
  switch (a.type) {
    case 'add_competitor':
      await db.insert('competitors', {
        name: a.name, website: a.website, platform: a.platform
      });
      return 'Added ' + a.name + ' to the competitor list.';

    case 'pause_competitor':
    case 'resume_competitor': {
      const on = a.type === 'resume_competitor';
      const rows = await db.patch(
        'competitors', 'name=eq.' + encodeURIComponent(a.name), { active: on });
      if (!rows || !rows.length) throw new Error('No competitor called "' + a.name + '".');
      return (on ? 'Resumed ' : 'Paused ') + a.name + '.';
    }

    case 'add_supplier':
      await db.insert('suppliers', {
        name: a.name,
        website: a.website || null,
        status: 'prospect'
        // is_uk_responsible_person is left at its default of false.
        // It is not settable from here by design.
      });
      return 'Added ' + a.name + ' as a supplier at prospect stage, without Responsible Person status.';

    case 'add_season':
      await db.insert('seasons', {
        slug: a.slug, name: a.name, date_rule: a.date_rule,
        event_month: a.event_month ?? null,
        event_day: a.event_day ?? null,
        event_weekday: a.event_weekday ?? null,
        event_nth: a.event_nth ?? null,
        day_offset: a.day_offset || 0
      });
      return 'Added "' + a.name + '" to the calendar. It still needs its lead times.';

    case 'pause_season':
    case 'resume_season': {
      const on = a.type === 'resume_season';
      const rows = await db.patch('seasons', 'slug=eq.' + encodeURIComponent(a.slug), { active: on });
      if (!rows || !rows.length) throw new Error('No season with the name "' + a.slug + '".');
      return (on ? 'Resumed ' : 'Paused ') + a.slug + '.';
    }

    case 'add_season_term': {
      const season = await findSeason(db, a.slug);
      await db.insert('season_terms', { season_id: season.id, term: a.term });
      return 'Added the word "' + a.term + '" to ' + season.name + '.';
    }

    case 'remove_season_term': {
      const season = await findSeason(db, a.slug);
      await db.del('season_terms',
        'season_id=eq.' + season.id + '&term=eq.' + encodeURIComponent(a.term));
      return 'Removed the word "' + a.term + '" from ' + season.name + '.';
    }

    case 'set_season_lead_times': {
      const season = await findSeason(db, a.slug);
      const patch = {};
      if (a.source_lead_weeks !== undefined) patch.source_lead_weeks = a.source_lead_weeks;
      if (a.sell_from_weeks_before !== undefined) patch.sell_from_weeks_before = a.sell_from_weeks_before;
      if (a.sell_until_days_after !== undefined) patch.sell_until_days_after = a.sell_until_days_after;
      await db.patch('seasons', 'id=eq.' + season.id, patch);
      return 'Updated the lead times on ' + season.name + '.';
    }

    default:
      throw new Error('Not something this box can do.');
  }
}

// Seasons are referred to by slug or by name, because a person
// typing a sentence will use the name.
async function findSeason(db, slug) {
  let rows = await db.select('seasons', 'select=id,name,slug&slug=eq.' + encodeURIComponent(slug));
  if (rows && rows[0]) return rows[0];
  rows = await db.select('seasons', 'select=id,name,slug&name=ilike.' + encodeURIComponent(slug));
  if (rows && rows[0]) return rows[0];
  throw new Error('No season with the name "' + slug + '".');
}

async function rejectRequest(db, requestId) {
  await db.patch('assistant_requests', 'id=eq.' + encodeURIComponent(requestId), {
    status: 'rejected', result: 'Not carried out.'
  });
  return json(200, { ok: true });
}


// ---------------------------------------------------------------- plumbing

// Unlike the scan functions, there is no scheduler path and no
// shared-secret path into this one. A person has to be signed in,
// because a person pressing a button is the entire point of it.
async function whoami(event, url, serviceKey) {
  const token = (event.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;

  try {
    const resp = await fetch(url + '/auth/v1/user', {
      headers: { apikey: serviceKey, authorization: 'Bearer ' + token }
    });
    if (!resp.ok) return null;
    const user = await resp.json();
    if (!user || !user.id) return null;

    const pr = await fetch(url + '/rest/v1/user_profiles?select=role&id=eq.' + user.id, {
      headers: { apikey: serviceKey, authorization: 'Bearer ' + serviceKey }
    });
    const rows = await pr.json();
    const role = rows && rows[0] && rows[0].role;
    if (['owner', 'staff'].indexOf(role) === -1) return null;
    return { id: user.id, role: role };
  } catch (err) {
    console.error('whoami failed', err);
    return null;
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
      headers: Object.assign({}, headers, { prefer: prefer || 'return=representation' }),
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await resp.text();
    if (!resp.ok) {
      // Surfaced to the person, so it has to read like English
      // rather than like Postgres.
      if (/duplicate key/i.test(text)) throw new Error('that is already on the list');
      throw new Error(String(text).slice(0, 200));
    }
    return text ? JSON.parse(text) : null;
  }

  return {
    select: (table, query) => call('GET', table + '?' + query),
    insert: (table, row) => call('POST', table, row),
    patch:  (table, query, row) => call('PATCH', table + '?' + query, row),
    del:    (table, query) => call('DELETE', table + '?' + query)
  };
}

function json(statusCode, obj) {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) };
}

// Exposed so the validator and the plain-English preview can be
// tested without a network or a database. Not part of what this
// function promises to callers.
exports._internal = {
  validateActions, describe, describeOne, patternParse,
  website_, slug_, int_, text, ALLOWED
};
