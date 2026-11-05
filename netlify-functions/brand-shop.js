// ============================================================
// Packet — Netlify Function: brand-shop  (the shop link)
// Built from the AXRIK starter kit under licence. Kit v1.1.0.
// ============================================================
// Plugs a brand's own Shopify shop into Packet Outlet (016_brand_shop_link.sql).
// The plain logic lives in _shared/brand-shop-core.js and is tested.
//
// GET  — Shopify sends the brand's browser here when they install the
//        app, and again after they approve it. Both are signed by
//        Shopify and checked. On approval the shop's key is stored and
//        the first read happens straight away.
//
// POST { action } — needs a Packet login:
//   Packet staff:  list | save { brand_id, shop, client_id?, client_secret?,
//                  default_condition?, default_category?, lowest_pct? }
//                  | sync { brand_id } | disconnect { brand_id }
//   A brand (their own shop only, added 4 Nov 2026 for 017):
//                  sync
//                  connect_shopify { shop, client_id?, client_secret? }
//                     With their own app's keys: connected straight away
//                     where Shopify allows it, otherwise an install link.
//                     With no keys and Packet's shared app set up: an
//                     install link. With neither: Packet is emailed to
//                     make the app, and the brand sees "waiting for Packet".
//                  connect_woo { site }  -> WooCommerce's approve screen
//                  defaults { default_condition, default_category, lowest_pct }
//                  disconnect
//
// POST ?woo=callback — WooCommerce itself, carrying the keys the brand
//        approved. Matched to the brand by a one-off code we gave it.
//
// Every ten minutes brand-shop-cron.js runs every connected shop:
//   1. takes Packet sales off the brand's Shopify stock (and puts
//      cancelled ones back);
//   2. reads the products tagged packet-outlet and brings the Outlet
//      into line.
//
// Environment (Netlify):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   already set
//   URL                                       set by Netlify itself
//   SHOPIFY_LINK_CLIENT_ID / _SECRET          optional: one shared app
//                                             once Shopify has approved one.
//                                             Until then each brand's own app
//                                             keys are saved per brand.
// ============================================================

const S = require('./_shared/shopify-client.js');
const L = require('./_shared/brand-shop-core.js');

const SITE = () => (process.env.URL || 'https://admin.packetlabel.com').replace(/\/$/, '');
const CALLBACK = () => SITE() + '/.netlify/functions/brand-shop';
const API = () => S.API_VERSION;

exports.handler = async (event) => {
  if (!S.supabaseConfigured()) return S.json(503, { error: 'Supabase is not configured on this site.' });
  try {
    if (event.httpMethod === 'GET') return await fromShopify(event);
    if (event.httpMethod !== 'POST') return S.json(405, { error: 'Method not allowed' });
    const qs = event.queryStringParameters || {};
    if (qs.woo === 'callback') return await fromWoo(event);
    return await fromScreen(event);
  } catch (err) {
    console.error('brand-shop', err);
    return S.json(500, { error: String(err.message || err).slice(0, 300) });
  }
};

exports.runScheduled = async () => {
  const db = S.restClient();
  const budget = Date.now() + 22000;
  const conns = await db.select('brand_shops', 'select=*&status=in.(connected,error)&or=(access_token.not.is.null,consumer_key.not.is.null)&order=last_sync_at.asc.nullsfirst');
  const out = [];
  for (const c of conns) {
    if (Date.now() > budget) break;
    out.push(Object.assign({ brand_id: c.brand_id }, await syncShop(db, c, budget)));
  }
  return S.json(200, { shops: out });
};

// ── The brand's browser, sent by Shopify ─────────────────────────
async function fromShopify(event) {
  const q = event.queryStringParameters || {};
  const shop = L.normaliseShop(q.shop);
  if (!shop) return page(400, 'Something is missing', 'This link has to be opened from Shopify. Please try installing again.');

  const db = S.restClient();
  const rows = await db.select('brand_shops', 'select=*&shop_domain=eq.' + encodeURIComponent(shop));
  const conn = rows[0];
  if (!conn) return page(404, 'Not set up yet', 'Packet has not set up a link for ' + shop + ' yet. Please email info@packetlabel.com and we will sort it.');

  const keys = appKeys(conn);
  if (!keys) return page(500, 'Not quite ready', 'Packet has not finished setting up your link. Please email info@packetlabel.com.');
  if (!L.verifyQueryHmac(q, keys.secret)) return page(403, 'That did not check out', 'Shopify\'s signature on this link did not match, so nothing has been changed. Please try installing again.');
  if (q.timestamp && Math.abs(Date.now() / 1000 - Number(q.timestamp)) > 600) {
    return page(403, 'That link has run out', 'Please go back to Shopify and try again.');
  }

  // Step 2: the brand has approved. Swap the one-off code for the key.
  if (q.code) {
    if (!conn.oauth_state || q.state !== conn.oauth_state) {
      return page(403, 'That did not check out', 'This approval did not match the request we sent. Please try installing again.');
    }
    const tok = await tokenRequest(shop, { client_id: keys.id, client_secret: keys.secret, code: q.code });
    const conn2 = Object.assign({}, conn, storeToken(tok), { status: 'connected', oauth_state: null,
      connected_at: new Date().toISOString(), last_error: null });
    await db.patch('brand_shops', 'id=eq.' + conn.id, pick(conn2,
      ['access_token', 'refresh_token', 'token_expires_at', 'scopes', 'status', 'oauth_state', 'connected_at', 'last_error']));
    const r = await syncShop(db, conn2, Date.now() + 7000).catch(function (e) { return { error: e.message }; });
    return page(200, 'Your shop is connected',
      'Packet can now see the products you tag <b>' + esc(conn.outlet_tag) + '</b> in Shopify. ' +
      (r && r.error ? 'The first read did not finish (' + esc(r.error) + '); it will try again within ten minutes.'
        : (r.added || 0) + ' new item' + (r.added === 1 ? '' : 's') + ' came across just now.') +
      ' You can close this window and see them in your Packet account.');
  }

  // Step 1: Shopify has opened the app. Ask the brand to approve access.
  const state = L.newState();
  await db.patch('brand_shops', 'id=eq.' + conn.id, { oauth_state: state, updated_at: new Date().toISOString() });
  return { statusCode: 302, headers: { location: L.installUrl(shop, keys.id, CALLBACK(), state) }, body: '' };
}

// ── Packet's screens ───────────────────────────────────────────
async function fromScreen(event) {
  const who = await caller(event);
  if (!who) return S.json(401, { error: 'Please sign in again.' });
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { /* ignore */ }
  const db = S.restClient();
  const uuid = function (v) { return /^[0-9a-f-]{36}$/i.test(String(v || '')); };

  if (who.role === 'brand') return brandAction(db, who, body);

  if (body.action === 'list') {
    const rows = await db.select('brand_shops', 'select=brand_id,platform,shop_domain,site_url,status,outlet_tag,default_condition,default_category,lowest_pct,connected_at,last_sync_at,last_error,last_warnings,items_linked,client_id,needs_packet_app');
    return S.json(200, {
      shops: rows.map(function (r) { const o = Object.assign({}, r, { own_app: !!r.client_id }); delete o.client_id; return o; }),
      app_url: CALLBACK(), redirect_url: CALLBACK(), shared_app: !!(process.env.SHOPIFY_LINK_CLIENT_ID && process.env.SHOPIFY_LINK_CLIENT_SECRET)
    });
  }

  if (body.action === 'save') {
    if (!uuid(body.brand_id)) return S.json(400, { error: 'Which brand?' });
    const shop = L.normaliseShop(body.shop);
    if (!shop) return S.json(400, { error: 'That is not a Shopify shop address. It ends .myshopify.com — the brand can find it in Shopify under Settings → Domains.' });
    const row = { brand_id: body.brand_id, platform: 'shopify', shop_domain: shop, site_url: null, updated_at: new Date().toISOString() };
    if (body.client_id) row.client_id = String(body.client_id).trim();
    if (body.client_secret) row.client_secret = String(body.client_secret).trim();
    if (row.client_id && row.client_secret) { row.needs_packet_app = false; row.token_grant = 'oauth'; }
    if (body.default_condition) row.default_condition = body.default_condition;
    if (body.default_category) row.default_category = body.default_category;
    if (body.lowest_pct) row.lowest_pct = Math.max(1, Math.min(100, parseInt(body.lowest_pct, 10) || 50));
    const existing = await db.select('brand_shops', 'select=id,client_id&brand_id=eq.' + body.brand_id);
    if (existing.length) await db.patch('brand_shops', 'id=eq.' + existing[0].id, row);
    else await db.insert('brand_shops', [row], 'return=minimal');
    const hasKeys = !!(row.client_id || (existing[0] && existing[0].client_id) || process.env.SHOPIFY_LINK_CLIENT_ID);
    return S.json(200, { ok: true, shop: shop, has_keys: hasKeys, app_url: CALLBACK(), redirect_url: CALLBACK() });
  }

  if (body.action === 'sync') {
    if (!uuid(body.brand_id)) return S.json(400, { error: 'Which brand?' });
    const rows = await db.select('brand_shops', 'select=*&brand_id=eq.' + body.brand_id);
    if (!rows.length || !connectedish(rows[0])) return S.json(400, { error: 'That shop is not connected yet.' });
    return S.json(200, await syncShop(db, rows[0], Date.now() + 8000));
  }

  if (body.action === 'disconnect') {
    if (who.role !== 'owner') return S.json(403, { error: 'Owners only.' });
    if (!uuid(body.brand_id)) return S.json(400, { error: 'Which brand?' });
    await db.patch('brand_shops', 'brand_id=eq.' + body.brand_id, {
      status: 'disconnected', access_token: null, refresh_token: null, token_expires_at: null,
      consumer_key: null, consumer_secret: null, updated_at: new Date().toISOString()
    });
    return S.json(200, { ok: true });
  }

  return S.json(400, { error: 'Unknown action.' });
}

// ── A brand connecting their own shop ──────────────────────────
async function brandAction(db, who, body) {
  const mine = (await db.select('brand_shops', 'select=*&brand_id=eq.' + who.brand_id))[0] || null;
  const now = new Date().toISOString();

  if (body.action === 'sync') {
    if (!mine || !connectedish(mine)) return S.json(400, { error: 'Your shop is not connected yet.' });
    return S.json(200, await syncShop(db, mine, Date.now() + 8000));
  }

  if (body.action === 'defaults') {
    if (!mine) return S.json(400, { error: 'Connect your shop first.' });
    const patch = { updated_at: now };
    if (L.CONDITIONS.indexOf(body.default_condition) > -1) patch.default_condition = body.default_condition;
    if (L.CATEGORIES.indexOf(body.default_category) > -1) patch.default_category = body.default_category;
    if (body.lowest_pct !== undefined) patch.lowest_pct = Math.max(1, Math.min(100, parseInt(body.lowest_pct, 10) || 50));
    await db.patch('brand_shops', 'id=eq.' + mine.id, patch);
    return S.json(200, { ok: true });
  }

  if (body.action === 'disconnect') {
    if (!mine) return S.json(200, { ok: true });
    await db.patch('brand_shops', 'id=eq.' + mine.id, { status: 'disconnected', access_token: null, refresh_token: null,
      token_expires_at: null, consumer_key: null, consumer_secret: null, updated_at: now });
    // Items from it stop following the shop, so take them off sale
    // rather than leave numbers nobody is keeping right.
    await db.patch('outlet_items', 'brand_id=eq.' + who.brand_id + '&source=eq.' + mine.platform + '&quantity=gt.0', { quantity: 0 });
    return S.json(200, { ok: true });
  }

  if (body.action === 'connect_shopify') {
    const shop = L.normaliseShop(body.shop);
    if (!shop) return S.json(400, { error: 'That is not a Shopify shop address. It ends .myshopify.com — find it in Shopify under Settings → Domains.' });
    const taken = await db.select('brand_shops', 'select=brand_id&shop_domain=eq.' + encodeURIComponent(shop));
    if (taken.length && taken[0].brand_id !== who.brand_id) return S.json(400, { error: 'That shop is already linked to another Packet account. Email info@packetlabel.com.' });

    const row = { brand_id: who.brand_id, platform: 'shopify', shop_domain: shop, site_url: null, consumer_key: null, consumer_secret: null,
      status: 'waiting', last_error: null, updated_at: now };
    const ownId = String(body.client_id || '').trim(), ownSecret = String(body.client_secret || '').trim();
    if (ownId && ownSecret) { row.client_id = ownId; row.client_secret = ownSecret; row.needs_packet_app = false; }
    else if (!(mine && mine.client_id) && !sharedApp()) row.needs_packet_app = true;
    const conn = await saveConn(db, mine, row);

    // Their own app, in their own Shopify: Packet can ask for a key directly.
    if (ownId && ownSecret) {
      try {
        const tok = await clientCredentials(shop, ownId, ownSecret);
        const c2 = Object.assign({}, conn, storeToken(tok), { token_grant: 'client_credentials', status: 'connected', connected_at: now });
        await db.patch('brand_shops', 'id=eq.' + conn.id, pick(c2, ['access_token', 'refresh_token', 'token_expires_at', 'scopes', 'token_grant', 'status', 'connected_at']));
        const r = await syncShop(db, c2, Date.now() + 7000).catch(function (e) { return { ok: false, error: e.message }; });
        return S.json(200, { ok: true, connected: true, result: r });
      } catch (e) {
        // Not allowed for this app: fall through to the install link.
        console.warn('client credentials refused', shop, e.message);
      }
    }
    const keys = appKeys(conn);
    if (!keys) {
      // Awaited: a Netlify function can be frozen the moment it replies.
      await notifyPacket(db, who.brand_id, shop).catch(function (e) { console.error('notify', e.message); });
      return S.json(200, { ok: true, waiting: true });
    }
    const state = L.newState();
    await db.patch('brand_shops', 'id=eq.' + conn.id, { oauth_state: state, token_grant: 'oauth' });
    return S.json(200, { ok: true, install_url: L.installUrl(shop, keys.id, CALLBACK(), state) });
  }

  if (body.action === 'connect_woo') {
    const site = L.normaliseSite(body.site);
    if (!site) return S.json(400, { error: 'Put in your shop\'s web address. It must start https:// — WooCommerce will only connect over a secure link.' });
    const taken = await db.select('brand_shops', 'select=brand_id&site_url=ilike.' + encodeURIComponent(site));
    if (taken.length && taken[0].brand_id !== who.brand_id) return S.json(400, { error: 'That shop is already linked to another Packet account. Email info@packetlabel.com.' });
    const state = L.newState();
    await saveConn(db, mine, { brand_id: who.brand_id, platform: 'woocommerce', site_url: site, shop_domain: null,
      client_id: null, client_secret: null, access_token: null, refresh_token: null, token_expires_at: null,
      status: 'waiting', oauth_state: state, needs_packet_app: false, last_error: null, updated_at: now });
    return S.json(200, { ok: true, install_url: L.wooAuthUrl(site, state, SITE() + '/brand.html', CALLBACK() + '?woo=callback') });
  }

  return S.json(403, { error: 'Not allowed.' });
}

async function saveConn(db, existing, row) {
  if (existing) {
    await db.patch('brand_shops', 'id=eq.' + existing.id, row);
    return Object.assign({}, existing, row);
  }
  const made = await db.insert('brand_shops', [row], 'return=representation');
  return made[0];
}

function sharedApp() { return !!(process.env.SHOPIFY_LINK_CLIENT_ID && process.env.SHOPIFY_LINK_CLIENT_SECRET); }
function connectedish(c) { return c.status !== 'waiting' && c.status !== 'disconnected' && (c.access_token || c.consumer_key); }

async function notifyPacket(db, brandId, shop) {
  if (!process.env.RESEND_API_KEY) return;
  const C = require('./_shared/onboard-core.js');
  const b = (await db.select('brands', 'select=name&id=eq.' + brandId))[0] || { name: 'A brand' };
  const st = await db.select('app_settings', 'select=key,value&key=in.(email_from_name,email_from_address,outlet_notify_email)');
  const set = {}; st.forEach(function (r) { set[r.key] = r.value; });
  const from = (set.email_from_name || 'Packet') + ' <' + (set.email_from_address || 'info@packetlabel.com') + '>';
  const mail = C.needsAppEmail({ brand: b.name, shop: shop }, SITE() + '/#outlet');
  await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + process.env.RESEND_API_KEY },
    body: JSON.stringify({ from: from, to: [set.outlet_notify_email || set.email_from_address || 'info@packetlabel.com'],
      subject: mail.subject, html: mail.html, text: mail.text, headers: { 'Resend-Idempotency-Key': 'packet-needsapp-' + brandId + '-' + shop } })
  });
}

// ── WooCommerce hands over the keys ─────────────────────────────
// It posts { key_id, user_id, consumer_key, consumer_secret, key_permissions }.
// user_id is the one-off code we put in the approve link.
async function fromWoo(event) {
  let b = {};
  try { b = JSON.parse(event.body || '{}'); } catch (e) { return S.json(400, { error: 'bad body' }); }
  const state = String(b.user_id || '');
  if (!/^[0-9a-f]{36}$/.test(state) || !b.consumer_key || !b.consumer_secret) return S.json(400, { error: 'missing' });
  const db = S.restClient();
  const conn = (await db.select('brand_shops', 'select=*&platform=eq.woocommerce&oauth_state=eq.' + state))[0];
  if (!conn) return S.json(404, { error: 'unknown' });
  if (b.key_permissions && b.key_permissions !== 'read_write') return S.json(400, { error: 'Packet needs read and write access' });
  const c2 = Object.assign({}, conn, { consumer_key: String(b.consumer_key), consumer_secret: String(b.consumer_secret),
    status: 'connected', oauth_state: null, connected_at: new Date().toISOString(), last_error: null });
  await db.patch('brand_shops', 'id=eq.' + conn.id, pick(c2, ['consumer_key', 'consumer_secret', 'status', 'oauth_state', 'connected_at', 'last_error']));
  // The first read happens on the next ten-minute run, or when the brand
  // presses "Check my shop now" — WooCommerce is waiting on this reply.
  return S.json(200, { ok: true });
}

// ── One shop, one run ───────────────────────────────────────────
async function syncShop(db, conn, budget) {
  const now = new Date().toISOString();
  try {
    conn = await freshToken(db, conn);
    await checkCurrency(conn);
    const stock = await takeStock(db, conn, budget);

    const pendingRows = await db.select('outlet_orders',
      'select=item_id,quantity&brand_id=eq.' + conn.brand_id + '&brand_stock_taken_at=is.null&is_test=eq.false&status=in.(to_ship,shipped)&item_id=not.is.null');
    const pending = {};
    pendingRows.forEach(function (o) { pending[o.item_id] = (pending[o.item_id] || 0) + o.quantity; });

    const products = conn.platform === 'woocommerce' ? await wooProducts(conn, budget) : await taggedProducts(conn, budget);
    const existing = await db.select('outlet_items',
      'select=id,source_ref,quantity,rrp_minor,floor_minor,sale_minor,condition,condition_note,uk_rp_confirmed,brand_sku,title,size' +
      '&brand_id=eq.' + conn.brand_id + '&source=eq.' + (conn.platform === 'woocommerce' ? 'woocommerce' : 'shopify'));
    const plan = L.planSync(products, existing, conn, pending);

    if (plan.inserts.length) await db.insert('outlet_items', plan.inserts, 'return=minimal');
    let failed = 0;
    for (const u of plan.updates) {
      try { await db.patch('outlet_items', 'id=eq.' + u.id, u.patch); }
      catch (e) { failed++; plan.warnings.push('Could not update an item: ' + String(e.message).slice(0, 120)); }
    }
    const warnings = stock.warnings.concat(plan.warnings).slice(0, 25);
    await db.patch('brand_shops', 'id=eq.' + conn.id, {
      status: 'connected', last_sync_at: now, last_error: null, last_warnings: warnings,
      items_linked: plan.seen, updated_at: now
    });
    return { ok: true, added: plan.inserts.length, updated: plan.updates.length - failed, stock_taken: stock.taken,
      stock_returned: stock.returned, warnings: warnings, seen: plan.seen };
  } catch (err) {
    const msg = String(err.message || err).slice(0, 300);
    const gone = /\b401\b|Invalid API key|access token|woocommerce_rest_cannot|consumer key/i.test(msg);
    await db.patch('brand_shops', 'id=eq.' + conn.id, {
      status: gone ? 'disconnected' : 'error', last_error: gone ? 'The shop no longer lets Packet in. Has the app been removed?' : msg,
      last_sync_at: now, updated_at: now
    }).catch(function () {});
    return { ok: false, error: msg };
  }
}

// Packet sales → off the brand's Shopify stock. Cancelled → back on.
async function takeStock(db, conn, budget) {
  const res = { taken: 0, returned: 0, warnings: [] };
  const toTake = await db.select('outlet_orders',
    'select=id,item_id,quantity,order_ref&brand_id=eq.' + conn.brand_id +
    '&brand_stock_taken_at=is.null&is_test=eq.false&status=in.(to_ship,shipped)&item_id=not.is.null&limit=40');
  const toReturn = await db.select('outlet_orders',
    'select=id,item_id,quantity,order_ref&brand_id=eq.' + conn.brand_id +
    '&brand_stock_taken_at=not.is.null&brand_stock_returned_at=is.null&status=eq.cancelled&item_id=not.is.null&limit=40');
  const ids = toTake.concat(toReturn).map(function (o) { return o.item_id; });
  if (!ids.length) return res;
  const items = await db.select('outlet_items', 'select=id,source,source_inventory_ref&id=in.(' + ids.join(',') + ')');
  const inv = {};
  items.forEach(function (i) { if (i.source === (conn.platform || 'shopify') && i.source_inventory_ref) inv[i.id] = i.source_inventory_ref; });

  const jobs = toTake.map(function (o) { return { o: o, delta: -o.quantity, col: 'brand_stock_taken_at' }; })
    .concat(toReturn.map(function (o) { return { o: o, delta: o.quantity, col: 'brand_stock_returned_at' }; }));
  for (const j of jobs) {
    if (Date.now() > budget) break;
    const ref = inv[j.o.item_id];
    if (!ref) {
      // Not from their shop: nothing to take off. Mark it so it is not asked again.
      if (j.col === 'brand_stock_taken_at') await db.patch('outlet_orders', 'id=eq.' + j.o.id, { brand_stock_taken_at: new Date().toISOString(), brand_stock_error: 'not from the shop link' });
      continue;
    }
    try {
      if (conn.platform === 'woocommerce') await adjustWoo(conn, ref, j.delta);
      else await adjust(conn, ref, j.delta, j.o.id + (j.delta > 0 ? '-back' : ''));
      const patch = {}; patch[j.col] = new Date().toISOString(); patch.brand_stock_error = null;
      await db.patch('outlet_orders', 'id=eq.' + j.o.id, patch);
      if (j.delta < 0) res.taken++; else res.returned++;
    } catch (e) {
      const msg = String(e.message).slice(0, 200);
      await db.patch('outlet_orders', 'id=eq.' + j.o.id, { brand_stock_error: msg });
      res.warnings.push('Order ' + j.o.order_ref + ': could not ' + (j.delta < 0 ? 'take it off' : 'put it back on') +
        ' your shop\'s stock (' + msg + '). Please change it by hand in your shop.');
    }
  }
  return res;
}

async function adjust(conn, inventoryItemId, delta, key) {
  const lv = await gqlShop(conn, `query($id: ID!) { inventoryItem(id: $id) { inventoryLevels(first: 20) { nodes {
      location { id } quantities(names: ["available"]) { quantity } } } } }`, { id: inventoryItemId });
  const levels = lv.inventoryItem ? lv.inventoryItem.inventoryLevels.nodes : [];
  const loc = L.pickLocation(levels);
  if (!loc) throw new Error('no stock location found for it');
  const current = (levels.filter(function (l) { return l.location.id === loc; })[0].quantities[0] || {}).quantity;

  // Shopify has been tightening this mutation version by version: newer
  // versions want an idempotency key and the quantity we expect to
  // change from. Try the strictest form first and step back only on a
  // "this version doesn't know that" answer.
  const forms = [[true, true], [true, false], [false, true], [false, false]];
  let lastErr;
  for (const f of forms) {
    const change = { inventoryItemId: inventoryItemId, locationId: loc, delta: delta };
    if (f[1] && typeof current === 'number') change.changeFromQuantity = current;
    const m = 'mutation($input: InventoryAdjustQuantitiesInput!' + (f[0] ? ', $key: String!' : '') + ') {' +
      ' inventoryAdjustQuantities(input: $input)' + (f[0] ? ' @idempotent(key: $key)' : '') + ' { userErrors { field message } } }';
    try {
      const d = await gqlShop(conn, m, Object.assign({ input: { reason: 'correction', name: 'available', changes: [change] } }, f[0] ? { key: 'packet-' + key } : {}));
      S.must(d.inventoryAdjustQuantities, 'Shopify stock');
      return;
    } catch (e) {
      lastErr = e;
      if (!/idempotent|changeFromQuantity|undefined|not defined|isn't defined|unknown|Unknown/i.test(e.message)) throw e;
    }
  }
  throw lastErr;
}

async function taggedProducts(conn, budget) {
  const out = [];
  let cursor = null;
  const q = 'tag:\'' + String(conn.outlet_tag || L.DEFAULT_TAG).replace(/'/g, '') + '\' AND status:active';
  for (let page = 0; page < 40; page++) {
    if (Date.now() > budget) throw new Error('ran out of time reading your products; it will carry on next time');
    const d = await gqlShop(conn, `query($q: String!, $after: String) {
      products(first: 25, after: $after, query: $q) {
        pageInfo { hasNextPage endCursor }
        nodes { id title productType tags descriptionHtml
          images(first: 8) { nodes { url } }
          variants(first: 100) { nodes { id sku price compareAtPrice inventoryQuantity
            selectedOptions { name value } inventoryItem { id tracked } } } } } }`, { q: q, after: cursor });
    out.push.apply(out, d.products.nodes);
    if (!d.products.pageInfo.hasNextPage) break;
    cursor = d.products.pageInfo.endCursor;
  }
  return out;
}

// ── Talking to the brand's shop ──────────────────────────────────
async function gqlShop(conn, query, variables) {
  const resp = await fetch('https://' + conn.shop_domain + '/admin/api/' + API() + '/graphql.json', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-shopify-access-token': conn.access_token },
    body: JSON.stringify({ query: query, variables: variables || {} })
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error('Shopify ' + resp.status + ': ' + text.slice(0, 200));
  const data = JSON.parse(text);
  if (data.errors && data.errors.length) throw new Error('Shopify: ' + data.errors.map(function (e) { return e.message; }).join('; ').slice(0, 300));
  return data.data;
}

function appKeys(conn) {
  const id = conn.client_id || process.env.SHOPIFY_LINK_CLIENT_ID;
  const secret = conn.client_secret || process.env.SHOPIFY_LINK_CLIENT_SECRET;
  return id && secret ? { id: id, secret: secret } : null;
}

async function tokenRequest(shop, params) {
  const resp = await fetch('https://' + shop + '/admin/oauth/access_token', {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(params)
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error('Shopify would not give Packet a key (' + resp.status + '): ' + text.slice(0, 200));
  return JSON.parse(text);
}

function storeToken(tok) {
  return {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token || null,
    token_expires_at: tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000).toISOString() : null,
    scopes: tok.scope || null
  };
}

// Keys that expire are swapped for fresh ones a few minutes early.
async function freshToken(db, conn) {
  if (conn.platform === 'woocommerce') return conn;   // WooCommerce keys do not expire
  if (conn.token_grant === 'client_credentials' && conn.client_id && conn.client_secret &&
      (!conn.access_token || !conn.token_expires_at || new Date(conn.token_expires_at).getTime() - Date.now() < 5 * 60 * 1000)) {
    const t = storeToken(await clientCredentials(conn.shop_domain, conn.client_id, conn.client_secret));
    await db.patch('brand_shops', 'id=eq.' + conn.id, t);
    return Object.assign({}, conn, t);
  }
  if (!conn.token_expires_at || !conn.refresh_token) return conn;
  if (new Date(conn.token_expires_at).getTime() - Date.now() > 5 * 60 * 1000) return conn;
  const keys = appKeys(conn);
  const tok = await tokenRequest(conn.shop_domain, { client_id: keys.id, client_secret: keys.secret,
    grant_type: 'refresh_token', refresh_token: conn.refresh_token });
  const t = storeToken(tok);
  await db.patch('brand_shops', 'id=eq.' + conn.id, t);
  return Object.assign({}, conn, t);
}

async function clientCredentials(shop, id, secret) {
  const resp = await fetch('https://' + shop + '/admin/oauth/access_token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }).toString()
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error('Shopify would not give Packet a key (' + resp.status + '): ' + text.slice(0, 200));
  return JSON.parse(text);
}

// Packet Outlet sells in pounds. A shop priced in anything else would
// bring its numbers across as if they were pounds, so it is stopped
// here with a reason the brand can act on.
async function checkCurrency(conn) {
  let cur = null;
  try {
    if (conn.platform === 'woocommerce') {
      const d = await woo(conn, 'settings/general/woocommerce_currency');
      cur = d && d.value;
    } else {
      const d = await gqlShop(conn, '{ shop { currencyCode } }');
      cur = d && d.shop && d.shop.currencyCode;
    }
  } catch (e) { console.warn('currency check', e.message); return; }   // cannot tell: carry on
  if (cur && String(cur).toUpperCase() !== 'GBP') {
    throw new Error('Your shop\'s prices are in ' + cur + '. Packet Outlet sells in pounds, so for now please upload your products as a file with £ prices instead.');
  }
}

// ── Talking to WooCommerce ──────────────────────────────────────
async function woo(conn, path, method, body) {
  const base = conn.site_url.replace(/\/$/, '') + '/wp-json/wc/v3/' + path;
  const auth = 'Basic ' + Buffer.from(conn.consumer_key + ':' + conn.consumer_secret).toString('base64');
  const opts = { method: method || 'GET', headers: { 'content-type': 'application/json', accept: 'application/json', authorization: auth } };
  if (body) opts.body = JSON.stringify(body);
  let resp = await fetch(base, opts);
  // Some hosts strip the Authorization header. WooCommerce accepts the
  // keys in the address instead, over https only.
  if (resp.status === 401) {
    const sep = base.indexOf('?') > -1 ? '&' : '?';
    const o2 = Object.assign({}, opts, { headers: { 'content-type': 'application/json', accept: 'application/json' } });
    resp = await fetch(base + sep + 'consumer_key=' + encodeURIComponent(conn.consumer_key) + '&consumer_secret=' + encodeURIComponent(conn.consumer_secret), o2);
  }
  const text = await resp.text();
  if (!resp.ok) throw new Error('WooCommerce ' + resp.status + ': ' + text.slice(0, 200));
  return wrap(text, resp);
}
function wrap(text, resp) {
  const d = text ? JSON.parse(text) : null;
  if (d && typeof d === 'object') Object.defineProperty(d, '_pages', { value: parseInt(resp.headers.get('x-wp-totalpages') || '1', 10) });
  return d;
}

async function wooProducts(conn, budget) {
  const tags = await woo(conn, 'products/tags?slug=' + encodeURIComponent(L.tagSlug(conn.outlet_tag)));
  if (!tags || !tags.length) return [];
  const tagId = tags[0].id;
  const products = [];
  for (let page = 1; page <= 40; page++) {
    if (Date.now() > budget) throw new Error('ran out of time reading your products; it will carry on next time');
    const batch = await woo(conn, 'products?status=publish&per_page=50&page=' + page + '&tag=' + tagId);
    products.push.apply(products, batch || []);
    if (!batch || batch.length < 50 || page >= (batch._pages || 1)) break;
  }
  const variations = {};
  for (const p of products) {
    if (p.type !== 'variable') continue;
    if (Date.now() > budget) throw new Error('ran out of time reading your products; it will carry on next time');
    variations[p.id] = (await woo(conn, 'products/' + p.id + '/variations?per_page=100')) || [];
  }
  return L.wooToProducts(products, variations);
}

// WooCommerce has no "change by" — read the number, write the new one.
async function adjustWoo(conn, ref, delta) {
  const r = L.wooRef(ref);
  if (!r) throw new Error('not a WooCommerce stock record');
  const path = r.variation ? 'products/' + r.product + '/variations/' + r.variation : 'products/' + r.product;
  const cur = await woo(conn, path);
  if (!cur || cur.manage_stock !== true) throw new Error('your shop does not count stock for it');
  await woo(conn, path, 'PUT', { stock_quantity: Math.max(0, (cur.stock_quantity | 0) + delta) });
}

// ── Who is asking ───────────────────────────────────────────────
async function caller(event) {
  const auth = event.headers.authorization || event.headers.Authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const r = await fetch(url + '/auth/v1/user', { headers: { apikey: key, authorization: 'Bearer ' + token } });
  if (!r.ok) return null;
  const user = await r.json();
  if (!user || !user.id) return null;
  const pr = await fetch(url + '/rest/v1/user_profiles?select=role,brand_id&id=eq.' + user.id,
    { headers: { apikey: key, authorization: 'Bearer ' + key } });
  const row = ((await pr.json()) || [])[0];
  if (row && (row.role === 'owner' || row.role === 'staff')) return { id: user.id, role: row.role };
  if (row && row.role === 'brand' && row.brand_id) return { id: user.id, role: 'brand', brand_id: row.brand_id };
  return null;
}

// ── Small things ────────────────────────────────────────────────
function pick(o, keys) { const r = {}; keys.forEach(function (k) { r[k] = o[k]; }); return r; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]; }); }

function page(status, title, html) {
  return {
    statusCode: status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    body: '<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>' + esc(title) + ' — Packet</title><style>body{margin:0;background:#F6EFE6;color:#3A2E27;font:16px/1.6 Inter,-apple-system,Segoe UI,sans-serif}' +
      '.c{max-width:520px;margin:12vh auto;padding:36px;background:#FFFCF7;border:1px solid rgba(58,46,39,.14)}' +
      'h1{font:400 26px Georgia,serif;margin:0 0 12px}.k{font-size:11px;letter-spacing:.22em;color:#C0623F;text-transform:uppercase;margin-bottom:14px}' +
      'a{color:#C0623F}</style></head><body><div class="c"><div class="k">Packet Outlet · shop link</div><h1>' + esc(title) + '</h1><p>' + html +
      '</p><p><a href="' + SITE() + '/brand.html">Go to your Packet account</a></p></div></body></html>'
  };
}
