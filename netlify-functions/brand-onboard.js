// ============================================================
// Packet — Netlify Function: brand-onboard
// Built from the AXRIK starter kit under licence. Kit v1.1.0.
// ============================================================
// Getting a new Outlet brand from "yes" to "selling" without anyone
// typing SQL or making logins by hand (017_brand_onboarding.sql).
// The plain rules live in _shared/onboard-core.js and are tested.
//
// POST { action, ... }
//
//   Anyone (the public apply page, admin.packetlabel.com/apply.html):
//     apply { company_name, website, contact_name, contact_email, ... }
//         Checked, rate-limited, stored in brand_applications. Packet
//         is emailed; so is the brand, to say it arrived.
//
//   Packet staff (owner or staff login):
//     list                          applications, newest first
//     decline { id, reason, tell }  optional email to the brand
//     spam    { id }
//
//   Owners only (these make logins):
//     approve { id, commission_pct, discount_pct?, auto_list? }
//         Makes (or finds) the brand, records the offer, makes the
//         login, and emails the brand a link to set their password.
//     invite  { company_name, website, contact_name, contact_email,
//               country?, platform?, categories?, commission_pct, ... }
//         The same, for a brand met in person: no application needed.
//     resend  { brand_id }          a fresh set-your-password link
//
// The commission is never defaulted. Approving without one is refused.
//
// Environment (Netlify): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// RESEND_API_KEY (already set for send-code.js). Without Resend the
// invite link is handed back to the screen to send by hand.
// ============================================================

const crypto = require('crypto');
const S = require('./_shared/shopify-client.js');
const C = require('./_shared/onboard-core.js');
const L = require('./_shared/brand-login.js');

const SITE = () => (process.env.URL || 'https://admin.packetlabel.com').replace(/\/$/, '');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return S.json(405, { error: 'Method not allowed' });
  if (!S.supabaseConfigured()) return S.json(503, { error: 'Not configured on this site yet.' });
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return S.json(400, { error: 'That did not arrive properly. Please try again.' }); }
  const db = S.restClient();
  try {
    if (body.action === 'apply') return await apply(db, body);

    const who = await S.staffCaller(event);
    if (!who) return S.json(401, { error: 'Please sign in again.' });
    switch (body.action) {
      case 'list':    return S.json(200, { applications: await db.select('brand_applications', 'select=*&order=created_at.desc&limit=200') });
      case 'decline': return await decline(db, who, body);
      case 'spam':    return await markSpam(db, who, body);
    }
    if (who.role !== 'owner') return S.json(403, { error: 'Only an owner can give a brand a login.' });
    switch (body.action) {
      case 'approve': return await approve(db, who, body);
      case 'invite':  return await invite(db, who, body);
      case 'resend':  return await resend(db, body);
    }
    return S.json(400, { error: 'Unknown action.' });
  } catch (err) {
    console.error('brand-onboard', err);
    return S.json(500, { error: String(err.message || err).slice(0, 300) });
  }
};

// ── Public: an application ─────────────────────────────────────
async function apply(db, body) {
  const r = C.readApplication(body);
  // A bot that filled in the hidden field is told it worked and nothing is stored.
  if (r.spam) return S.json(200, { ok: true });
  if (r.problems) return S.json(400, { error: r.problems.join(' '), problems: r.problems });
  const row = r.row;

  const dayAgo = new Date(Date.now() - 864e5).toISOString();
  const hourAgo = new Date(Date.now() - 36e5).toISOString();
  const mine = await db.select('brand_applications', 'select=id&contact_email=eq.' + encodeURIComponent(row.contact_email) + '&created_at=gt.' + dayAgo);
  if (mine.length >= 3) return S.json(429, { error: 'We already have your application. We will be in touch within two working days.' });
  const recent = await db.select('brand_applications', 'select=id&created_at=gt.' + hourAgo + '&limit=41');
  if (recent.length >= 40) return S.json(429, { error: 'We are getting a lot of applications right now. Please try again in an hour, or email info@packetlabel.com.' });

  const saved = await db.insert('brand_applications', [Object.assign({}, row, { source: 'apply page' })]);
  const app = saved[0];

  const settings = await mailSettings(db);
  const toPacket = settings.outlet_notify_email || settings.email_from_address;
  await send(settings, toPacket, C.newApplicationEmail(app, SITE() + '/#outlet'), 'packet-app-' + app.id, app.contact_email).catch(logMail);
  await send(settings, app.contact_email, C.receivedEmail(app), 'packet-app-ack-' + app.id).catch(logMail);
  return S.json(200, { ok: true });
}

// ── Staff ─────────────────────────────────────────────────────
async function decline(db, who, body) {
  const app = await oneApp(db, body.id);
  if (!app) return S.json(404, { error: 'That application has gone.' });
  const reason = C.clean(body.reason, 1000) || null;
  await db.patch('brand_applications', 'id=eq.' + app.id, { status: 'declined', decline_reason: reason, reviewed_by: who.id, reviewed_at: new Date().toISOString() });
  let emailed = false;
  if (body.tell) {
    const settings = await mailSettings(db);
    emailed = await send(settings, app.contact_email, C.declinedEmail({ company_name: app.company_name, contact_name: app.contact_name, reason: reason }),
      'packet-decline-' + app.id).then(function () { return true; }, function (e) { logMail(e); return false; });
  }
  return S.json(200, { ok: true, emailed: emailed });
}

async function markSpam(db, who, body) {
  const app = await oneApp(db, body.id);
  if (!app) return S.json(404, { error: 'That application has gone.' });
  await db.patch('brand_applications', 'id=eq.' + app.id, { status: 'spam', reviewed_by: who.id, reviewed_at: new Date().toISOString() });
  return S.json(200, { ok: true });
}

// ── Owners: approve, invite, resend ───────────────────────────
async function invite(db, who, body) {
  const r = C.readApplication(Object.assign({}, body, { agree_contact: true, company_fax: '' }));
  if (r.problems) return S.json(400, { error: r.problems.join(' ') });
  const t = C.readTerms(body);
  if (t.problems) return S.json(400, { error: t.problems.join(' ') });
  const saved = await db.insert('brand_applications', [Object.assign({}, r.row, { source: 'invited by Packet' })]);
  return approveApp(db, who, saved[0], t);
}

async function approve(db, who, body) {
  const app = await oneApp(db, body.id);
  if (!app) return S.json(404, { error: 'That application has gone.' });
  if (app.status === 'approved' && app.brand_id) return S.json(400, { error: 'Already approved. Use "Send a new link" on the brand if they need one.' });
  const t = C.readTerms(body);
  if (t.problems) return S.json(400, { error: t.problems.join(' ') });
  return approveApp(db, who, app, t);
}

async function approveApp(db, who, app, terms) {
  const now = new Date().toISOString();

  // The brand: one that is already on the Brands page (same website)
  // is reused, so the pipeline history is kept.
  let brand = null;
  if (app.brand_id) brand = (await db.select('brands', 'select=*&id=eq.' + app.brand_id))[0];
  if (!brand) {
    const host = app.website.replace(/^https?:\/\//, '').replace(/^www\./, '');
    const candidates = await db.select('brands', 'select=*&website=ilike.*' + encodeURIComponent(host) + '*');
    brand = candidates.filter(function (b) { return C.normaliseWebsite(b.website) === app.website; })[0] || null;
  }
  if (!brand) {
    const cats = await db.select('category_settings', 'select=category').catch(function () { return []; });
    const known = cats.map(function (c) { return c.category; });
    const category = (app.categories || []).filter(function (c) { return known.indexOf(c) > -1; })[0] || null;
    const made = await db.insert('brands', [{
      name: app.company_name, website: app.website, category: category,
      instagram_handle: app.instagram_handle, contact_name: app.contact_name, contact_email: app.contact_email,
      found_via: 'application', status: 'invited', country: app.country,
      uk_based: app.country === 'GB' ? 'yes' : 'no',
      uk_rp: app.uk_rp,
      notes: '[' + app.source + ', ' + now.slice(0, 10) + '] ' + (app.message || '')
    }]);
    brand = made[0];
  }

  const patch = {
    outlet_commission_offered_pct: terms.commission_pct,
    outlet_discount_pct: terms.discount_pct,
    outlet_auto_list: terms.auto_list,
    outlet_invited_at: now,
    outlet_login_email: app.contact_email,
    updated_at: now
  };
  if (!brand.country) patch.country = app.country;
  if (['candidate', 'contacted', 'replied', 'soft_yes', 'declined'].indexOf(brand.status) > -1) patch.status = 'invited';
  await db.patch('brands', 'id=eq.' + brand.id, patch);

  // The login. An email that already belongs to staff or another brand
  // is refused rather than repointed.
  const existing = await L.findUserByEmail(app.contact_email);
  if (existing) {
    const meta = existing.app_metadata || {};
    if (meta.packet_role !== 'brand' || meta.brand_id !== brand.id) {
      await db.patch('brand_applications', 'id=eq.' + app.id, { brand_id: brand.id });
      return S.json(400, { error: app.contact_email + ' already has a Packet login for something else. Use a different email for this brand.' });
    }
  } else {
    await L.createBrandLogin({ email: app.contact_email, password: C.strongPassword(crypto), full_name: app.contact_name, brandId: brand.id });
  }

  await db.patch('brand_applications', 'id=eq.' + app.id, { status: 'approved', brand_id: brand.id, reviewed_by: who.id, reviewed_at: now });

  const out = await sendInvite(db, { id: brand.id, name: brand.name, commission: terms.commission_pct }, app.contact_email, app.contact_name);
  return S.json(200, Object.assign({ ok: true, brand_id: brand.id, brand: brand.name, email: app.contact_email }, out));
}

async function resend(db, body) {
  if (!/^[0-9a-f-]{36}$/i.test(String(body.brand_id || ''))) return S.json(400, { error: 'Which brand?' });
  const brand = (await db.select('brands', 'select=id,name,contact_name,outlet_login_email,outlet_commission_offered_pct,outlet_commission_pct&id=eq.' + body.brand_id))[0];
  if (!brand) return S.json(404, { error: 'That brand has gone.' });
  let email = brand.outlet_login_email;
  if (!email) {
    // A login made by hand before 017: find it through its profile.
    const prof = (await db.select('user_profiles', 'select=id&role=eq.brand&brand_id=eq.' + brand.id + '&limit=1'))[0];
    if (prof) {
      const E = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
      const r = await fetch(E.url + '/auth/v1/admin/users/' + prof.id, { headers: { apikey: E.key, authorization: 'Bearer ' + E.key } });
      if (r.ok) email = (await r.json()).email;
    }
  }
  if (!email) return S.json(400, { error: 'This brand has no login yet. Approve or invite them first.' });
  const out = await sendInvite(db, { id: brand.id, name: brand.name,
    commission: brand.outlet_commission_offered_pct !== null ? brand.outlet_commission_offered_pct : brand.outlet_commission_pct }, email, brand.contact_name);
  return S.json(200, Object.assign({ ok: true, email: email }, out));
}

// The set-your-password link, emailed. Without Resend, handed back so
// a person can send it — the screen shows it once and says so.
async function sendInvite(db, brand, email, contactName) {
  const link = await L.setPasswordLink(email, SITE() + '/brand.html');
  const mail = C.inviteEmail({ brand: brand.name, contact_name: contactName, link: link, login_url: SITE() + '/brand.html',
    commission_pct: brand.commission === null || brand.commission === undefined ? null : Number(brand.commission) });
  const settings = await mailSettings(db);
  if (!process.env.RESEND_API_KEY) return { emailed: false, link: link, note: 'Email is not set up on this site, so send them this link yourself.' };
  try {
    await send(settings, email, mail, 'packet-invite-' + brand.id + '-' + Date.now());
    return { emailed: true };
  } catch (e) {
    logMail(e);
    return { emailed: false, link: link, note: 'The email did not send (' + String(e.message).slice(0, 120) + '). Send them this link yourself.' };
  }
}

// ── Small things ──────────────────────────────────────────────
async function oneApp(db, id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) return null;
  return (await db.select('brand_applications', 'select=*&id=eq.' + id))[0] || null;
}

async function mailSettings(db) {
  const out = { email_from_name: 'Packet', email_from_address: 'info@packetlabel.com', email_reply_to: 'info@packetlabel.com', outlet_notify_email: '' };
  try {
    const rows = await db.select('app_settings', 'select=key,value&key=in.(email_from_name,email_from_address,email_reply_to,outlet_notify_email)');
    rows.forEach(function (r) { if (r.value) out[r.key] = r.value; });
  } catch (e) { console.error('settings', e.message); }
  return out;
}

async function send(settings, to, mail, idemKey, replyTo) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY not set');
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify({
      from: settings.email_from_name + ' <' + settings.email_from_address + '>',
      to: [to], reply_to: replyTo || settings.email_reply_to,
      subject: mail.subject, html: mail.html, text: mail.text,
      headers: { 'Resend-Idempotency-Key': idemKey }
    })
  });
  if (!resp.ok) throw new Error('Resend ' + resp.status + ' ' + (await resp.text()).slice(0, 200));
}

function logMail(e) { console.error('brand-onboard email', e && e.message); }

exports._test = { apply, approveApp };
