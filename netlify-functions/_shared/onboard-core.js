// ============================================================
// Packet — onboarding a brand: the plain logic
// Built from the AXRIK starter kit under licence. Kit v1.1.0.
// ============================================================
// No network calls here, so test/onboard.test.js can check every
// rule without a database or an email account.
// netlify-functions/brand-onboard.js does the talking.
// ============================================================

const PLATFORMS = ['shopify', 'woocommerce', 'wix', 'squarespace', 'bigcommerce', 'etsy', 'other', 'none'];
const CATEGORIES = ['clothing', 'footwear', 'accessories', 'jewellery', 'beauty', 'home', 'kids', 'pets', 'other'];
const STOCK_KINDS = ['returns', 'end_of_season', 'samples', 'seconds', 'damaged_packaging', 'overstock'];

// Not a list of where Packet will trade — a list the form offers. Any
// other two-letter code is accepted too. Outside GB, nothing goes on
// sale until an owner ticks cross-border settled (017).
const COUNTRIES = [
  ['GB', 'United Kingdom (Great Britain)'], ['IE', 'Ireland'], ['GB-NIR', 'Northern Ireland'],
  ['FR', 'France'], ['DE', 'Germany'], ['NL', 'Netherlands'], ['ES', 'Spain'], ['IT', 'Italy'],
  ['DK', 'Denmark'], ['SE', 'Sweden'], ['PT', 'Portugal'], ['BE', 'Belgium'], ['US', 'United States'], ['OTHER', 'Somewhere else']
];

function clean(v, max) {
  return String(v === null || v === undefined ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 200);
}
function cleanBlock(v, max) {
  return String(v === null || v === undefined ? '' : v).replace(/\r/g, '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ').trim().slice(0, max || 3000);
}

// "hotsquash.com", "www.hotsquash.com/", "https://hotsquash.com/shop" -> "https://hotsquash.com"
function normaliseWebsite(v) {
  let s = clean(v, 300).toLowerCase();
  if (!s) return null;
  if (!/^https?:\/\//.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(u.hostname)) return null;
    return 'https://' + u.hostname.replace(/^www\./, '');
  } catch (e) { return null; }
}

function normaliseEmail(v) {
  const s = clean(v, 254).toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(s) ? s : null;
}

// Northern Ireland posts from the UK but not from Great Britain, and
// the goods rules differ. Kept as its own answer so nobody has to
// guess later; stored as GB with a note, since ISO has no NI code.
function countryCode(v) {
  const s = clean(v, 10).toUpperCase();
  if (s === 'GB-NIR') return { code: 'GB', note: 'Posts from Northern Ireland' };
  if (s === 'UK') return { code: 'GB', note: null };
  if (/^[A-Z]{2}$/.test(s)) return { code: s, note: null };
  return { code: null, note: null };
}

function list(v, allowed) {
  const arr = Array.isArray(v) ? v : String(v || '').split(',');
  const out = [];
  arr.forEach(function (x) { const s = clean(x, 40).toLowerCase(); if (allowed.indexOf(s) > -1 && out.indexOf(s) === -1) out.push(s); });
  return out;
}

// What the public form sends -> a row for brand_applications, or the
// problems in plain words. The honeypot field ("company_fax") is
// invisible to people; anything that fills it in is a bot.
function readApplication(body) {
  const b = body || {};
  const problems = [];
  if (clean(b.company_fax)) return { spam: true };

  const row = {
    company_name: clean(b.company_name, 200),
    website: normaliseWebsite(b.website),
    contact_name: clean(b.contact_name, 120),
    contact_email: normaliseEmail(b.contact_email),
    contact_phone: clean(b.contact_phone, 40) || null,
    platform: PLATFORMS.indexOf(clean(b.platform, 20).toLowerCase()) > -1 ? clean(b.platform, 20).toLowerCase() : 'other',
    categories: list(b.categories, CATEGORIES),
    stock_kinds: list(b.stock_kinds, STOCK_KINDS),
    approx_units: clean(b.approx_units, 60) || null,
    instagram_handle: clean(b.instagram_handle, 60).replace(/^@/, '') || null,
    message: cleanBlock(b.message, 3000) || null
  };
  const c = countryCode(b.country || 'GB');
  if (c.note) row.message = (row.message ? row.message + '\n\n' : '') + '[' + c.note + ']';
  row.country = c.code;

  const rp = clean(b.uk_rp, 10).toLowerCase();
  row.uk_rp = row.categories.indexOf('beauty') > -1 ? (['yes', 'no'].indexOf(rp) > -1 ? rp : 'unknown') : 'n_a';

  if (!row.company_name) problems.push('Put in your brand or company name.');
  if (!row.website) problems.push('Put in your website address, e.g. yourbrand.com.');
  if (!row.contact_name) problems.push('Put in your name.');
  if (!row.contact_email) problems.push('That email address does not look right.');
  if (!row.country) problems.push('Choose where you post from.');
  if (!row.categories.length) problems.push('Tick at least one thing you sell.');
  if (b.agree_contact !== true && b.agree_contact !== 'true' && b.agree_contact !== 'on') {
    problems.push('Tick the box so we can contact you about your application.');
  }
  return problems.length ? { problems: problems } : { row: row };
}

// What Packet types when approving. Commission is required — there is
// no default. Discount and auto-list are optional.
function readTerms(body) {
  const b = body || {};
  const problems = [];
  const pct = Number(String(b.commission_pct === undefined ? '' : b.commission_pct).replace('%', '').trim());
  if (String(b.commission_pct === undefined ? '' : b.commission_pct).trim() === '' || !isFinite(pct) || pct < 0 || pct > 100) {
    problems.push('Put in the percentage Packet keeps (0 to 100).');
  }
  let disc = null;
  const ds = String(b.discount_pct === undefined || b.discount_pct === null ? '' : b.discount_pct).replace('%', '').trim();
  if (ds !== '') {
    disc = Number(ds);
    if (!isFinite(disc) || disc < 0 || disc >= 100) problems.push('The normal Outlet discount must be between 0 and 99%.');
  }
  const auto = b.auto_list === true || b.auto_list === 'true' || b.auto_list === 'on';
  if (auto && disc === null) problems.push('Set a normal Outlet discount so items that list themselves have a price.');
  return problems.length ? { problems: problems } : { commission_pct: pct, discount_pct: disc, auto_list: auto };
}

// Supabase's admin generate_link has answered in two shapes over the
// years: the link at the top level, or inside "properties".
function actionLink(resp) {
  if (!resp) return null;
  return resp.action_link || (resp.properties && resp.properties.action_link) || null;
}

function strongPassword(cryptoMod) {
  // Never shown to anyone: the brand sets their own from the link.
  return cryptoMod.randomBytes(24).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 28) + 'aA1!';
}

// ── Emails ─────────────────────────────────────────────────────
// Tables and inline styles, as send-code.js, so Outlook behaves.
function esc(s) {
  return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c];
  });
}

function frame(title, bodyHtml, preheader) {
  return '<!DOCTYPE html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' +
    esc(title) + '</title></head><body style="margin:0;padding:0;background:#F6EFE6;">' +
    '<div style="display:none;max-height:0;overflow:hidden;opacity:0;">' + esc(preheader || '') + '</div>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F6EFE6;"><tr><td align="center" style="padding:36px 16px;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:540px;background:#FFFCF7;border:1px solid #E4DAD0;">' +
    '<tr><td style="padding:34px 34px 8px 34px;font-family:Georgia,serif;font-size:13px;letter-spacing:3px;text-transform:uppercase;color:#C0623F;">Packet Outlet</td></tr>' +
    '<tr><td style="padding:6px 34px 30px 34px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#3A2E27;">' + bodyHtml + '</td></tr>' +
    '</table><p style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#6B5B50;margin:16px 0 0;">Packet Label Limited · registered in England and Wales, 17392293</p>' +
    '</td></tr></table></body></html>';
}

function button(href, label) {
  return '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0;"><tr><td style="background:#C0623F;">' +
    '<a href="' + esc(href) + '" style="display:inline-block;padding:13px 22px;font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#FFFCF7;text-decoration:none;">' +
    esc(label) + '</a></td></tr></table>';
}

function inviteEmail(o) {
  // o: { brand, contact_name, link, login_url, commission_pct }
  const first = clean(o.contact_name, 120).split(' ')[0] || 'there';
  const subject = 'Your Packet Outlet login for ' + o.brand;
  const html = frame(subject,
    '<h1 style="font-family:Georgia,serif;font-weight:400;font-size:24px;margin:0 0 14px;">Welcome to Packet Outlet</h1>' +
    '<p style="margin:0 0 12px;">Hi ' + esc(first) + ',</p>' +
    '<p style="margin:0 0 12px;">We&rsquo;d love to sell ' + esc(o.brand) + '&rsquo;s returns and end-of-season stock on Packet Outlet. Your login is ready. Press the button to choose a password and get set up.</p>' +
    button(o.link, 'Set your password') +
    '<p style="margin:0 0 12px;">Setting up takes about ten minutes:</p>' +
    '<ol style="margin:0 0 14px 18px;padding:0;"><li>Your business details and returns address.</li>' +
    '<li>Read and accept the Outlet terms' + (o.commission_pct !== null && o.commission_pct !== undefined ? ' (Packet keeps ' + esc(o.commission_pct) + '% of each sale; you keep the rest)' : '') + '.</li>' +
    '<li>Connect your shop, upload your product file, or add items one at a time.</li></ol>' +
    '<p style="margin:0 0 12px;">You never send us stock. When something sells, the order appears in your login and you post it straight to the customer.</p>' +
    '<p style="margin:0 0 12px;font-size:13px;color:#6B5B50;">This link works once and runs out after a while. If it has, go to <a href="' + esc(o.login_url) + '" style="color:#C0623F;">' + esc(o.login_url) + '</a> and press &ldquo;Forgotten your password?&rdquo;.</p>' +
    '<p style="margin:0;">Any questions, just reply.<br>The Packet team</p>',
    'Your login is ready — set a password and get set up in about ten minutes.');
  const text = 'Hi ' + first + ',\n\nWe\'d love to sell ' + o.brand + '\'s returns and end-of-season stock on Packet Outlet. Your login is ready.\n\n' +
    'Set your password: ' + o.link + '\n\nSetting up takes about ten minutes: your business details, the Outlet terms, then connect your shop or upload your products.\n\n' +
    'If the link has run out, go to ' + o.login_url + ' and press "Forgotten your password?".\n\nThe Packet team';
  return { subject: subject, html: html, text: text };
}

function receivedEmail(o) {
  // o: { company_name, contact_name }
  const first = clean(o.contact_name, 120).split(' ')[0] || 'there';
  const subject = 'We have your Packet Outlet application';
  const html = frame(subject,
    '<p style="margin:0 0 12px;">Hi ' + esc(first) + ',</p>' +
    '<p style="margin:0 0 12px;">Thanks for applying to sell ' + esc(o.company_name) + '&rsquo;s stock on Packet Outlet. We read every application ourselves and will reply within two working days.</p>' +
    '<p style="margin:0 0 12px;">If it&rsquo;s a fit, you&rsquo;ll get an email with your own login. Nothing is agreed until you&rsquo;ve read and accepted the terms there.</p>' +
    '<p style="margin:0;">The Packet team</p>', 'Thanks — we will reply within two working days.');
  const text = 'Hi ' + first + ',\n\nThanks for applying to sell ' + o.company_name + '\'s stock on Packet Outlet. We read every application ourselves and will reply within two working days.\n\nThe Packet team';
  return { subject: subject, html: html, text: text };
}

function declinedEmail(o) {
  const first = clean(o.contact_name, 120).split(' ')[0] || 'there';
  const subject = 'Your Packet Outlet application';
  const reason = cleanBlock(o.reason, 1000);
  const html = frame(subject,
    '<p style="margin:0 0 12px;">Hi ' + esc(first) + ',</p>' +
    '<p style="margin:0 0 12px;">Thank you for applying to sell ' + esc(o.company_name) + '&rsquo;s stock on Packet Outlet. We&rsquo;re not able to take it on at the moment.</p>' +
    (reason ? '<p style="margin:0 0 12px;">' + esc(reason).replace(/\n/g, '<br>') + '</p>' : '') +
    '<p style="margin:0;">With best wishes,<br>The Packet team</p>', 'About your application.');
  const text = 'Hi ' + first + ',\n\nThank you for applying to sell ' + o.company_name + '\'s stock on Packet Outlet. We\'re not able to take it on at the moment.\n\n' +
    (reason ? reason + '\n\n' : '') + 'The Packet team';
  return { subject: subject, html: html, text: text };
}

function newApplicationEmail(row, adminUrl) {
  const subject = 'New Outlet application: ' + row.company_name;
  const lines = [
    ['Brand', row.company_name], ['Website', row.website], ['Contact', row.contact_name + ' <' + row.contact_email + '>'],
    ['Phone', row.contact_phone || '—'], ['Posts from', row.country], ['Their shop runs on', row.platform],
    ['Sells', (row.categories || []).join(', ')], ['Stock', (row.stock_kinds || []).join(', ') || '—'],
    ['Roughly', row.approx_units || '—'], ['UK Responsible Person', row.uk_rp], ['Instagram', row.instagram_handle || '—']
  ];
  const html = frame(subject,
    '<p style="margin:0 0 12px;">A brand has applied to sell on Packet Outlet.</p><table cellpadding="4" style="font-size:14px;">' +
    lines.map(function (l) { return '<tr><td style="color:#6B5B50;vertical-align:top;">' + esc(l[0]) + '</td><td>' + esc(l[1]) + '</td></tr>'; }).join('') +
    '</table>' + (row.message ? '<p style="margin:14px 0 0;white-space:pre-line;">' + esc(row.message) + '</p>' : '') +
    button(adminUrl, 'Review it in the admin'), 'New application from ' + row.company_name);
  const text = 'A brand has applied to sell on Packet Outlet.\n\n' + lines.map(function (l) { return l[0] + ': ' + l[1]; }).join('\n') +
    (row.message ? '\n\n' + row.message : '') + '\n\nReview it: ' + adminUrl;
  return { subject: subject, html: html, text: text };
}

function needsAppEmail(o, adminUrl) {
  const subject = o.brand + ' wants their Shopify shop connected';
  const html = frame(subject,
    '<p style="margin:0 0 12px;">' + esc(o.brand) + ' has asked Packet to set up their Shopify shop link for <b>' + esc(o.shop) + '</b>.</p>' +
    '<p style="margin:0 0 12px;">Make the app in the Shopify Dev Dashboard (about ten minutes — the steps are on the Outlet page under Shop links), then save its keys against the brand.</p>' +
    button(adminUrl, 'Open the Outlet page'), 'Shop link request');
  return { subject: subject, html: html, text: subject + '\n\n' + adminUrl };
}

module.exports = {
  PLATFORMS, CATEGORIES, STOCK_KINDS, COUNTRIES,
  clean, normaliseWebsite, normaliseEmail, countryCode, readApplication, readTerms, actionLink, strongPassword,
  inviteEmail, receivedEmail, declinedEmail, newApplicationEmail, needsAppEmail, esc
};
