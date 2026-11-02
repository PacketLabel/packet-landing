// ============================================================
// Packet — Netlify Function: shopify-webhook
// Built from the AXRIK starter kit under licence. Kit v1.1.0.
// ============================================================
// Shopify calls this when an order is paid or cancelled. Signed up for
// by the Connect Shopify button (outlet-shopify.js, action "setup").
//
//   orders/paid       every Outlet line becomes a row in outlet_orders,
//                     which the brand sees on their Orders page. The
//                     brand is emailed that something has sold — no
//                     customer details in the email, just "sign in".
//                     Gift-set lines (AW Dropship) are ignored here.
//   orders/cancelled  Outlet lines not yet posted are cancelled, and
//                     the stock goes back on the brand's count.
//
// Nothing is trusted unless Shopify's signature checks out against the
// app's client secret. Shopify resends anything that does not get a
// 200 back, so a failure here is retried, and the same line is never
// recorded twice (the unique key on shopify_line_item_id, 015).
// ============================================================

const S = require('./_shared/shopify-client.js');
const C = require('./_shared/outlet-shopify-core.js');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return S.json(405, { error: 'Method not allowed' });
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET || process.env.SHOPIFY_CLIENT_SECRET;
  if (!secret || !S.supabaseConfigured()) return S.json(503, { error: 'Not configured' });

  const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
  const h = lower(event.headers);
  if (!C.verifyHmac(raw, h['x-shopify-hmac-sha256'], secret)) return S.json(401, { error: 'Bad signature' });

  let order;
  try { order = JSON.parse(raw); } catch { return S.json(400, { error: 'Bad JSON' }); }

  const topic = h['x-shopify-topic'];
  const db = S.restClient();
  try {
    if (topic === 'orders/paid') return S.json(200, await paid(db, order));
    if (topic === 'orders/cancelled') return S.json(200, await cancelled(db, order));
    return S.json(200, { ignored: topic });
  } catch (err) {
    console.error('shopify-webhook', topic, order && order.name, err);
    return S.json(500, { error: 'Will retry' });         // Shopify tries again
  }
};

async function paid(db, order) {
  const ids = [];
  (order.line_items || []).forEach(function (li) {
    const id = C.itemIdFromSku(li.sku);
    if (id && ids.indexOf(id) === -1) ids.push(id);
  });
  if (!ids.length) return { outlet_lines: 0 };

  const items = await db.select('outlet_items', 'select=id,brand_id,title&id=in.(' + ids.join(',') + ')');
  const byId = {};
  items.forEach(function (i) { byId[i.id] = i; });

  const built = C.orderRows(order, byId);
  built.problems.forEach(function (p) { console.error('shopify-webhook', p); });

  // Lines already recorded on an earlier delivery of this notification.
  const lineIds = built.rows.map(function (r) { return r.shopify_line_item_id; });
  const have = lineIds.length
    ? await db.select('outlet_orders', 'select=shopify_line_item_id&shopify_line_item_id=in.(' + lineIds.join(',') + ')')
    : [];
  const seen = {};
  have.forEach(function (r) { seen[r.shopify_line_item_id] = true; });

  let added = 0;
  const brandsWithNew = {};
  for (const row of built.rows) {
    if (seen[row.shopify_line_item_id]) continue;
    try {
      await db.insert('outlet_orders', row, 'return=minimal');
      added++;
      brandsWithNew[row.brand_id] = true;
    } catch (err) {
      if (/409|23505|duplicate/i.test(err.message)) continue;   // a second delivery got there first
      throw err;
    }
  }

  for (const brandId of Object.keys(brandsWithNew)) {
    await tellBrand(db, brandId, order.name).catch(function (e) { console.error('tellBrand', e.message); });
  }
  return { outlet_lines: built.rows.length, added: added, problems: built.problems.length };
}

async function cancelled(db, order) {
  await db.patch('outlet_orders',
    'shopify_order_id=eq.' + encodeURIComponent(String(order.id)) + '&status=eq.to_ship',
    { status: 'cancelled' });
  return { ok: true };
}

// "Something has sold, please sign in and post it." Sent to every login
// the brand has. Only if Resend is set up (it already is for discount
// codes); otherwise the order simply waits on their Orders page.
async function tellBrand(db, brandId, orderName) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return;
  const settings = {};
  (await db.select('app_settings', 'select=key,value&key=in.(email_from_name,email_from_address)'))
    .forEach(function (r) { settings[r.key] = r.value; });
  if (!settings.email_from_address) return;

  const profiles = await db.select('user_profiles', 'select=id&role=eq.brand&brand_id=eq.' + brandId);
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const emails = [];
  for (const p of profiles) {
    const r = await fetch(url + '/auth/v1/admin/users/' + p.id, { headers: { apikey: key, authorization: 'Bearer ' + key } });
    if (r.ok) { const u = await r.json(); if (u.email) emails.push(u.email); }
  }
  if (!emails.length) return;

  const text = 'Good news: something of yours has sold on Packet Outlet (order ' + orderName + ').\n\n' +
    'Please sign in to see what it is and where it is going, post it, and add the tracking number:\n' +
    'https://admin.packetlabel.com/brand.html\n\n' +
    'Thank you,\nPacket';
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: (settings.email_from_name || 'Packet') + ' <' + settings.email_from_address + '>',
      to: emails,
      subject: 'You have a Packet Outlet order to post (' + orderName + ')',
      text: text
    })
  });
  if (!resp.ok) throw new Error('Resend ' + resp.status + ' ' + (await resp.text()).slice(0, 200));
}

function lower(headers) {
  const out = {};
  Object.keys(headers || {}).forEach(function (k) { out[k.toLowerCase()] = headers[k]; });
  return out;
}
