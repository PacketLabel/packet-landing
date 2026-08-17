// ============================================================
// Packet — Netlify Function: send-code
// ============================================================
// Emails someone the discount code they have just been issued.
//
// WHY THIS IS SERVER-SIDE
// The Resend key can send mail as info@packetlabel.com. If it went in
// the page, anyone could take it out of the source and send email as
// Packet. So the key lives only in a Netlify environment variable and
// the browser never sees it.
//
// WHY IT VERIFIES BEFORE SENDING
// The endpoint is public — anyone can POST to it. Left open it would
// be a free relay for sending mail to arbitrary strangers from a
// verified domain, which would burn Packet's sending reputation in an
// afternoon. So it will only ever send to an address that already has
// a matching code in the assessments table. You cannot make it email
// anyone who has not just finished the assessment.
//
// WHY IT ONLY SENDS ONCE
// code_emailed_at is set after a successful send and checked before
// the next one. Refreshing the page, resubmitting, or a retry cannot
// produce a second email.
//
// THIS EMAIL IS TRANSACTIONAL, NOT MARKETING
// It is sent because the person asked for a code, so it goes to
// everyone who finishes — tick box or not. It contains no promotion
// of anything beyond the code they requested. Do not add offers,
// product news or a "while you're here" to this template: that would
// turn it into marketing and it would then need consent, which the
// people who left the box unticked have not given.
//
// SETUP: Netlify -> Environment variables ->
//   RESEND_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// No npm dependencies — native fetch against the Supabase REST API,
// the same as manage-users.js. Keeping the functions folder dependency
// free means there is no package.json, no lockfile and no install step
// to go stale. Do not reach for @supabase/supabase-js here.
// ============================================================

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const apiKey      = process.env.RESEND_API_KEY;
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // Degrade quietly. The person already has their code on screen, so a
  // missing variable must never surface to them as a broken page.
  if (!apiKey || !supabaseUrl || !serviceKey) {
    console.error('send-code not configured', {
      resend: !!apiKey, url: !!supabaseUrl, service: !!serviceKey
    });
    return json(200, { sent: false, reason: 'not_configured' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const email = String(body.email || '').trim().toLowerCase();
  const code  = String(body.code  || '').trim().toUpperCase();

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(400, { error: 'Invalid email' });
  if (!/^[A-Z0-9-]{4,32}$/.test(code))           return json(400, { error: 'Invalid code' });

  const rest = (path) => `${supabaseUrl}/rest/v1/${path}`;
  const headers = {
    apikey: serviceKey,
    authorization: `Bearer ${serviceKey}`,
    'content-type': 'application/json',
  };

  try {
    // The gate. Both must match the same row, so knowing an address is
    // not enough and knowing a code is not enough.
    const lookup = await fetch(rest(
      `assessments?discount_code=eq.${encodeURIComponent(code)}` +
      `&email=eq.${encodeURIComponent(email)}` +
      `&select=id,email,discount_code,consent_marketing,code_emailed_at&limit=1`
    ), { headers });

    if (!lookup.ok) {
      console.error('lookup failed', lookup.status, await lookup.text());
      return json(200, { sent: false, reason: 'lookup_failed' });
    }

    const rows = await lookup.json();
    const row  = rows && rows[0];

    // Deliberately the same answer as a successful send. Telling a
    // caller "no such code" lets them probe for valid ones.
    if (!row) return json(200, { sent: false, reason: 'no_match' });
    if (row.code_emailed_at) return json(200, { sent: false, reason: 'already_sent' });

    const settings = await getSettings(rest, headers);

    const subResp = await fetch(rest(
      `subscribers?email=eq.${encodeURIComponent(email)}&select=unsubscribe_token&limit=1`
    ), { headers });
    const subRows = subResp.ok ? await subResp.json() : [];
    const sub     = subRows && subRows[0];

    // Only people who actually opted in get an unsubscribe link. Showing
    // one to someone who never subscribed invites them to unsubscribe
    // from something they are not on, which is just confusing.
    const unsubUrl = (row.consent_marketing && sub && sub.unsubscribe_token)
      ? 'https://packetlabel.com/unsubscribe.html?token=' + sub.unsubscribe_token
      : null;

    const html = buildHtml(code, settings, unsubUrl);
    const text = buildText(code, settings, unsubUrl);

    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        from: settings.email_from_name + ' <' + settings.email_from_address + '>',
        to: [email],
        reply_to: settings.email_reply_to,
        subject: 'Your ' + settings.discount_percent + '% code — ' + code,
        html,
        text,
        // Stops Resend sending twice if Netlify retries this invocation.
        headers: { 'Resend-Idempotency-Key': 'packet-code-' + code },
      }),
    });

    const mark = (patch) => fetch(
      rest(`assessments?id=eq.${encodeURIComponent(row.id)}`),
      { method: 'PATCH', headers, body: JSON.stringify(patch) }
    );

    if (!resp.ok) {
      const detail = await resp.text();
      console.error('Resend error', resp.status, detail);
      await mark({ code_email_error: String(resp.status) + ' ' + detail.slice(0, 300) });
      return json(200, { sent: false, reason: 'send_failed' });
    }

    await mark({ code_emailed_at: new Date().toISOString(), code_email_error: null });

    return json(200, { sent: true });
  } catch (err) {
    console.error('send-code error', err);
    return json(200, { sent: false, reason: 'error' });
  }
};


// Defaults are here so a missing settings row degrades to something
// sensible rather than sending an email with blanks in it.
async function getSettings(rest, headers) {
  const defaults = {
    discount_percent:   '10',
    discount_terms:     '',
    email_from_name:    'Packet',
    email_from_address: 'info@packetlabel.com',
    email_reply_to:     'info@packetlabel.com',
  };
  const keys = Object.keys(defaults).map(encodeURIComponent).join(',');
  const out  = Object.assign({}, defaults);

  try {
    const r = await fetch(rest(`app_settings?key=in.(${keys})&select=key,value`), { headers });
    if (r.ok) {
      (await r.json() || []).forEach((s) => { if (s.value) out[s.key] = s.value; });
    }
  } catch (e) {
    console.error('settings lookup failed, using defaults', e);
  }
  return out;
}


// ── The email ───────────────────────────────────────────────
// Tables and inline styles throughout, because Outlook still does not
// do modern CSS and this has to look right in it. Colours are Packet's:
// cream F6EFE6, panel FFFCF7, brown 3A2E27, terracotta C0623F.
function buildHtml(code, s, unsubUrl) {
  return `<!DOCTYPE html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Your ${esc(s.discount_percent)}% code</title>
</head>
<body style="margin:0;padding:0;background:#F6EFE6;">
<!-- Shows in the inbox list under the subject, so it earns its place. -->
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Here it is — keep this email and use the code whenever we open.</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F6EFE6;">
<tr><td align="center" style="padding:36px 16px;">

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;">

    <tr><td align="center" style="padding-bottom:26px;">
      <!-- The inline styles on the img are for the ALT TEXT, not the image.
           Outlook and some others block remote images until the reader
           clicks "show images", and most clients render alt text using the
           img's own styling. Without this, a blocked logo reads as tiny blue
           Times New Roman next to a broken-image icon. With it, the fallback
           is the word Packet in the right serif, size and colour — so the
           email still looks like Packet either way. -->
      <img src="https://packetlabel.com/assets/packet-wordmark.png" width="132" alt="Packet"
           style="display:block;border:0;width:132px;height:auto;
                  font-family:Georgia,'Times New Roman',serif;font-size:26px;
                  color:#3A2E27;text-decoration:none;">
    </td></tr>

    <tr><td style="background:#FFFCF7;border:1px solid rgba(58,46,39,0.16);border-radius:3px;padding:32px 28px;">

      <p style="margin:0 0 8px;font-family:Georgia,'Times New Roman',serif;font-size:23px;line-height:1.3;color:#3A2E27;">
        Here it is<span style="color:#C0623F;">.</span>
      </p>
      <p style="margin:0 0 24px;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#6B5B50;">
        Thanks for answering those questions. Your ${esc(s.discount_percent)}% code is below — keep this email and use it whenever we open.
      </p>

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr><td align="center" style="background:rgba(192,98,63,0.08);border:1px solid rgba(192,98,63,0.30);border-radius:3px;padding:22px 16px;">
        <p style="margin:0 0 8px;font-family:Helvetica,Arial,sans-serif;font-size:11px;letter-spacing:1.6px;text-transform:uppercase;color:#C0623F;">
          Your ${esc(s.discount_percent)}% code
        </p>
        <p style="margin:0;font-family:'Courier New',Courier,monospace;font-size:29px;letter-spacing:3px;color:#3A2E27;font-weight:bold;">
          ${esc(code)}
        </p>
      </td></tr>
      </table>

      ${s.discount_terms ? `
      <p style="margin:22px 0 0;padding-top:18px;border-top:1px solid rgba(58,46,39,0.14);font-family:Helvetica,Arial,sans-serif;font-size:12.5px;line-height:1.6;color:#8A7A6E;">
        ${esc(s.discount_terms)}
      </p>` : ''}

    </td></tr>

    <tr><td align="center" style="padding:24px 8px 0;">
      <p style="margin:0 0 6px;font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:1.65;color:#8A7A6E;">
        Packet is a trading name of Phil Munro.
      </p>
      <p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:1.65;color:#8A7A6E;">
        <a href="https://packetlabel.com/privacy.html" style="color:#8A7A6E;">Privacy notice</a>${unsubUrl ? `
        &nbsp;&middot;&nbsp; <a href="${unsubUrl}" style="color:#8A7A6E;">Unsubscribe</a>` : ''}
      </p>
    </td></tr>

  </table>

</td></tr>
</table>
</body>
</html>`;
}

// Plain-text alternative. Not optional — a message with no text part
// scores worse with spam filters and is unreadable on a watch.
function buildText(code, s, unsubUrl) {
  return [
    'Here it is.',
    '',
    'Thanks for answering those questions. Your ' + s.discount_percent +
      '% code is below — keep this email and use it whenever we open.',
    '',
    '  ' + code,
    '',
    s.discount_terms || '',
    '',
    '—',
    'Packet is a trading name of Phil Munro.',
    'Privacy notice: https://packetlabel.com/privacy.html',
    unsubUrl ? 'Unsubscribe: ' + unsubUrl : '',
  ].filter(Boolean).join('\n');
}

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function json(statusCode, obj) {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) };
}
