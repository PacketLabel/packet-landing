// ============================================================
// Packet — Netlify Function: outlet-shopify
// Built from the AXRIK starter kit under licence. Kit v1.1.0.
// ============================================================
// Keeps the Shopify shop in step with Outlet stock (015_outlet_shopify.sql).
//
//   An item Packet puts on sale becomes a product in the shop, tagged
//   "outlet" so it lands in the Outlet collection. Other sizes of the
//   same thing join that product as sizes (core: groupKey). After that only the
//   price, the number left and whether it shows are ever changed here —
//   Shopify owns the wording and photos (Decision 3).
//
//   A parcel the brand has marked as posted is marked fulfilled in
//   Shopify, with the tracking number, so Shopify emails the customer.
//
// Runs every ten minutes (netlify.toml) and whenever the admin presses
// a button. Owner or staff login required for button presses.
//
// POST { action }:
//   status            what is set up, what is waiting, what went wrong
//   setup             (owner) find the stock location and Online Store,
//                     make the Outlet collection, sign up for order
//                     notifications. Safe to press again.
//   sync  { itemId }  bring one item into line now
//   syncAll           everything that is out of date, then fulfilments
//
// Environment: see _shared/shopify-client.js.
// ============================================================

const crypto = require('crypto');
const S = require('./_shared/shopify-client.js');
const C = require('./_shared/outlet-shopify-core.js');

const WEBHOOK_TOPICS = ['ORDERS_PAID', 'ORDERS_CANCELLED'];

exports.handler = async (event) => {
  return run(event, false);
};

// The ten-minute run comes in through outlet-shopify-cron.js, which
// calls this directly. Nothing arriving over the web is ever treated
// as the scheduler, whatever it says in its body.
exports.runScheduled = (event) => run(event, true);

async function run(event, scheduled) {
  if (!S.supabaseConfigured()) return S.json(503, { error: 'Supabase is not configured on this site.' });
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { /* ignore */ }

  let caller = null;
  if (!scheduled) {
    if (event.httpMethod !== 'POST') return S.json(405, { error: 'Method not allowed' });
    caller = await S.staffCaller(event);
    if (!caller) return S.json(401, { error: 'Not signed in as Packet.' });
  }

  const action = scheduled ? 'syncAll' : body.action;
  const db = S.restClient();

  try {
    if (action === 'status') return S.json(200, await status(db));
    if (!S.shopifyConfigured()) {
      return S.json(503, { error: 'Shopify is not connected yet: SHOPIFY_SHOP, SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET need adding in Netlify.' });
    }
    if (action === 'setup') {
      if (caller.role !== 'owner') return S.json(403, { error: 'Owners only.' });
      return S.json(200, await setup(db, event));
    }
    if (action === 'sync') {
      if (!/^[0-9a-f-]{36}$/i.test(String(body.itemId || ''))) return S.json(400, { error: 'Which item?' });
      const settings = await readSettings(db);
      const rows = await db.select('outlet_items', 'select=*&id=eq.' + body.itemId);
      if (!rows.length) return S.json(404, { error: 'No such item.' });
      const brands = await brandNames(db);
      const r = await syncItem(db, settings, rows[0], brands[rows[0].brand_id]);
      return S.json(200, r);
    }
    if (action === 'syncAll') {
      const budget = Date.now() + (scheduled ? 22000 : 8000);   // Netlify allows 30s scheduled, 10s otherwise
      return S.json(200, await syncAll(db, budget));
    }
    return S.json(400, { error: 'Unknown action' });
  } catch (err) {
    console.error('outlet-shopify', action, err);
    return S.json(502, { error: err.message || 'That did not work.' });
  }
}

// ── Settings ────────────────────────────────────────────────
async function readSettings(db) {
  const rows = await db.select('app_settings', 'select=key,value&key=like.shopify_*');
  const s = {};
  rows.forEach(function (r) { s[r.key] = r.value; });
  return s;
}
async function writeSetting(db, key, value) {
  await db.upsert('app_settings', [{ key: key, value: String(value || '') }], 'key', 'resolution=merge-duplicates,return=minimal');
}
async function brandNames(db) {
  const rows = await db.select('brands', 'select=id,name');
  const m = {};
  rows.forEach(function (b) { m[b.id] = b.name; });
  return m;
}

// ── Status ──────────────────────────────────────────────────
async function status(db) {
  const settings = await readSettings(db);
  const items = await db.select('outlet_items',
    'select=id,status,quantity,updated_at,shopify_product_id,shopify_synced_at,shopify_sync_error&or=(status.eq.live,shopify_product_id.not.is.null)');
  const orders = await db.select('outlet_orders',
    'select=id,shopify_order_id,status,shopify_fulfilled_at,shopify_fulfil_error,oversold&shopify_order_id=not.is.null');
  const out = {
    configured: S.shopifyConfigured(),
    shop: S.shopifyConfigured() ? S.shopHost() : null,
    connected_at: settings.shopify_connected_at || null,
    location_set: !!settings.shopify_location_id,
    online_store_set: !!settings.shopify_publication_id,
    collection_set: !!settings.shopify_outlet_collection_id,
    items_in_shop: items.filter(function (i) { return i.shopify_product_id; }).length,
    items_waiting: items.filter(C.needsSync).length,
    item_errors: items.filter(function (i) { return i.shopify_sync_error; }).map(function (i) { return { id: i.id, error: i.shopify_sync_error }; }),
    shop_orders: orders.length,
    fulfil_errors: orders.filter(function (o) { return o.shopify_fulfil_error; }).length,
    oversold: orders.filter(function (o) { return o.oversold; }).length,
    webhooks: null,
    access_problem: null
  };
  if (out.configured) {
    try {
      const d = await S.gql('{ webhookSubscriptions(first: 25) { nodes { topic uri } } }');
      out.webhooks = d.webhookSubscriptions.nodes.map(function (w) { return w.topic; });
    } catch (err) { out.access_problem = err.message; }
  }
  return out;
}

// ── Setup ───────────────────────────────────────────────────
async function setup(db, event) {
  const done = [];

  // Where stock is counted. The shop's first active location; AW
  // Dropship keeps its own stock elsewhere and is not touched.
  const loc = await S.gql('{ locations(first: 10) { nodes { id name isActive } } }');
  const active = loc.locations.nodes.filter(function (l) { return l.isActive; });
  if (!active.length) throw new Error('The shop has no active location to count Outlet stock at.');
  const preferred = active.filter(function (l) { return !/aw|dropship/i.test(l.name); })[0] || active[0];
  await writeSetting(db, 'shopify_location_id', preferred.id);
  done.push('Stock counted at "' + preferred.name + '"');

  // The Online Store sales channel, so new products show on the website.
  const pubId = await onlineStorePublication();
  if (pubId) { await writeSetting(db, 'shopify_publication_id', pubId); done.push('Found the Online Store'); }
  else done.push('Could not find the Online Store sales channel — products will need publishing by hand');

  // The Outlet collection: everything tagged "outlet", automatically.
  let collId = null;
  const found = await S.gql('{ collections(first: 10, query: "title:Outlet") { nodes { id handle title } } }');
  const existing = found.collections.nodes.filter(function (c) { return c.handle === 'outlet'; })[0];
  if (existing) { collId = existing.id; done.push('Outlet collection already there'); }
  else {
    const made = await S.gql(`mutation c($input: CollectionInput!) {
        collectionCreate(input: $input) { collection { id } userErrors { field message } } }`,
      { input: { title: 'Outlet', handle: 'outlet',
                 descriptionHtml: '<p>Returns, end-of-season and sample stock from independent brands, at outlet prices. Sent to you direct from the brand.</p>',
                 ruleSet: { appliedDisjunctively: false, rules: [{ column: 'TAG', relation: 'EQUALS', condition: 'outlet' }] } } });
    S.must(made.collectionCreate, 'Making the Outlet collection');
    collId = made.collectionCreate.collection.id;
    done.push('Made the Outlet collection (shop address /collections/outlet)');
  }
  await writeSetting(db, 'shopify_outlet_collection_id', collId);
  if (pubId && collId) await publish(collId, pubId).catch(function (e) { done.push('Collection not published: ' + e.message); });

  // Order notifications.
  const host = (process.env.URL || ('https://' + (event.headers.host || 'admin.packetlabel.com'))).replace(/\/$/, '');
  const uri = host + '/.netlify/functions/shopify-webhook';
  const have = await S.gql('{ webhookSubscriptions(first: 25) { nodes { id topic uri } } }');
  for (const topic of WEBHOOK_TOPICS) {
    const match = have.webhookSubscriptions.nodes.filter(function (w) { return w.topic === topic; });
    if (match.some(function (w) { return w.uri === uri; })) { done.push(topic + ' notifications already on'); continue; }
    const r = await S.gql(`mutation w($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
        webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) { webhookSubscription { id } userErrors { field message } } }`,
      { topic: topic, sub: { uri: uri, format: 'JSON' } });
    S.must(r.webhookSubscriptionCreate, 'Signing up for ' + topic);
    done.push(topic + ' notifications switched on');
  }

  await writeSetting(db, 'shopify_connected_at', new Date().toISOString());
  return { ok: true, done: done, webhook_address: uri };
}

async function onlineStorePublication() {
  // Publication.name is on its way out in favour of catalog.title. Try
  // the newer shape first and fall back, so a Shopify version change
  // does not break the button.
  const tries = [
    '{ publications(first: 25) { nodes { id catalog { title } } } }',
    '{ publications(first: 25) { nodes { id name } } }'
  ];
  for (const q of tries) {
    try {
      const d = await S.gql(q);
      const hit = d.publications.nodes.filter(function (p) {
        const t = (p.catalog && p.catalog.title) || p.name || '';
        return /online store/i.test(t);
      })[0];
      if (hit) return hit.id;
    } catch (err) { console.warn('publications query', err.message); }
  }
  return null;
}

async function publish(id, pubId) {
  const r = await S.gql(`mutation p($id: ID!, $input: [PublicationInput!]!) {
      publishablePublish(id: $id, input: $input) { userErrors { field message } } }`,
    { id: id, input: [{ publicationId: pubId }] });
  S.must(r.publishablePublish, 'Publishing to the Online Store');
}

// ── Items ───────────────────────────────────────────────────
async function syncItem(db, settings, item, brandName) {
  try {
    if (!settings.shopify_location_id) throw new Error('Press Connect Shopify on the Outlet page first.');
    let patch;
    if (!item.shopify_product_id) {
      if (item.status !== 'live') {
        patch = { shopify_synced_at: item.updated_at, shopify_sync_error: null };
      } else {
        patch = await listItem(db, settings, item, brandName);
        await ensureBrandCollection(db, settings, item.brand_id, brandName).catch(function (e) { console.warn('brand collection', e.message); });
      }
    } else {
      try {
        await updateProduct(db, settings, item);
        patch = { shopify_synced_at: item.updated_at, shopify_sync_error: null };
      } catch (err) {
        // Deleted by hand in Shopify: forget it for every size that was on
        // it, and list this one afresh if it should be on sale. The other
        // sizes join it as they come round.
        if (/does not exist|not found|invalid id/i.test(err.message)) {
          await db.patch('outlet_items', 'shopify_product_id=eq.' + encodeURIComponent(item.shopify_product_id) + '&id=neq.' + item.id,
            { shopify_product_id: null, shopify_variant_id: null, shopify_inventory_item_id: null, shopify_synced_at: null });
          patch = item.status === 'live'
            ? await listItem(db, settings, item, brandName)
            : { shopify_product_id: null, shopify_variant_id: null, shopify_inventory_item_id: null, shopify_synced_at: item.updated_at, shopify_sync_error: null };
        } else throw err;
      }
    }
    await db.patch('outlet_items', 'id=eq.' + item.id, patch);
    return { ok: true, id: item.id, in_shop: !!(patch.shopify_product_id || item.shopify_product_id), showing: C.shopStatus(item) === 'ACTIVE' };
  } catch (err) {
    console.error('sync item', item.id, err.message);
    await db.patch('outlet_items', 'id=eq.' + item.id, { shopify_sync_error: String(err.message).slice(0, 500) }).catch(function () {});
    return { ok: false, id: item.id, error: err.message };
  }
}

// ── Each brand's own page in the shop (017) ─────────────────
// /collections/outlet-<brand>: everything from that brand in the
// Outlet, kept up to date by Shopify itself (vendor + the outlet tag).
// Made the first time one of their items goes on sale, so a brand can
// be sent a link to "your page on Packet" without anyone building it.
const made = {};
async function ensureBrandCollection(db, settings, brandId, brandName) {
  if (!brandName || made[brandId]) return;
  let row;
  try { row = (await db.select('brands', 'select=shopify_collection_id&id=eq.' + brandId))[0]; }
  catch (e) { return; }                                  // 017 not run: skip quietly
  if (!row || row.shopify_collection_id) { made[brandId] = true; return; }
  const handle = 'outlet-' + C.slug(brandName);
  const found = await S.gql('query($q: String!) { collections(first: 5, query: $q) { nodes { id handle } } }', { q: 'handle:' + handle });
  let id = (found.collections.nodes.filter(function (c) { return c.handle === handle; })[0] || {}).id;
  if (!id) {
    const r = await S.gql(`mutation c($input: CollectionInput!) {
        collectionCreate(input: $input) { collection { id } userErrors { field message } } }`,
      { input: C.brandCollectionInput(brandName, handle) });
    S.must(r.collectionCreate, 'Making ' + brandName + '\'s page');
    id = r.collectionCreate.collection.id;
    if (settings.shopify_publication_id) await publish(id, settings.shopify_publication_id).catch(function (e) { console.warn('publish', e.message); });
  }
  await db.patch('brands', 'id=eq.' + brandId, { shopify_collection_id: id });
  made[brandId] = true;
}

// A new size of something already in the shop joins that product;
// anything else becomes a product of its own.
async function listItem(db, settings, item, brandName) {
  if (C.groupKey(item)) {
    const inShop = await db.select('outlet_items',
      'select=id,brand_id,title,colour,size,condition,condition_note,shopify_product_id&brand_id=eq.' + item.brand_id + '&shopify_product_id=not.is.null');
    const productId = C.productToJoin(item, inShop);
    if (productId) return addSize(settings, item, productId);
  }
  return createProduct(settings, item, brandName);
}

async function addSize(settings, item, productId) {
  const r = await S.gql(`mutation a($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkCreate(productId: $productId, variants: $variants) {
        productVariants { id inventoryItem { id } } userErrors { field message } } }`,
    { productId: C.gid('Product', productId), variants: [C.sizeVariantInput(item, settings.shopify_location_id)] });
  S.must(r.productVariantsBulkCreate, 'Adding size ' + item.size + ' to Shopify');
  const v = (r.productVariantsBulkCreate.productVariants || [])[0];
  // It may have been hidden while every other size was sold out.
  const u = await S.gql(`mutation u($product: ProductUpdateInput!) {
      productUpdate(product: $product) { product { id } userErrors { field message } } }`,
    { product: { id: C.gid('Product', productId), status: 'ACTIVE' } });
  S.must(u.productUpdate, 'Showing it');
  return {
    shopify_product_id: productId,
    shopify_variant_id: v ? v.id : null,
    shopify_inventory_item_id: v && v.inventoryItem ? v.inventoryItem.id : null,
    shopify_synced_at: item.updated_at,
    shopify_sync_error: null
  };
}

async function createProduct(settings, item, brandName) {
  const input = C.productInput(item, brandName, settings.shopify_location_id);
  const r = await S.gql(`mutation s($input: ProductSetInput!) {
      productSet(input: $input, synchronous: true) {
        product { id variants(first: 1) { nodes { id inventoryItem { id } } } }
        userErrors { field message } } }`, { input: input });
  S.must(r.productSet, 'Adding it to Shopify');
  const p = r.productSet.product;
  const v = p.variants.nodes[0];
  if (settings.shopify_publication_id) {
    await publish(p.id, settings.shopify_publication_id).catch(function (e) { console.warn('publish', e.message); });
  }
  return {
    shopify_product_id: p.id,
    shopify_variant_id: v ? v.id : null,
    shopify_inventory_item_id: v && v.inventoryItem ? v.inventoryItem.id : null,
    shopify_synced_at: item.updated_at,
    shopify_sync_error: null
  };
}

async function updateProduct(db, settings, item) {
  const productId = C.gid('Product', item.shopify_product_id);
  // Shows while any size on it is on sale with some left.
  const peers = await db.select('outlet_items', 'select=id,status,quantity,sale_minor&shopify_product_id=eq.' + encodeURIComponent(item.shopify_product_id));
  const st = C.groupStatus(peers.filter(function (p) { return p.id !== item.id; }).concat([item]));

  const u = await S.gql(`mutation u($product: ProductUpdateInput!) {
      productUpdate(product: $product) { product { id } userErrors { field message } } }`,
    { product: { id: productId, status: st } });
  S.must(u.productUpdate, 'Changing whether it shows');

  if (item.sale_minor && item.shopify_variant_id) {
    const p = await S.gql(`mutation v($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) { userErrors { field message } } }`,
      { productId: productId, variants: [{ id: item.shopify_variant_id, price: C.pounds(item.sale_minor) }] });
    S.must(p.productVariantsBulkUpdate, 'Changing the price');
  }

  if (item.shopify_inventory_item_id) {
    const q = await S.gql(`mutation q($input: InventorySetQuantitiesInput!, $key: String!) {
        inventorySetQuantities(input: $input) @idempotent(key: $key) { userErrors { field message } } }`,
      { key: crypto.randomUUID(),
        input: { name: 'available', reason: 'correction',
                 quantities: [{ inventoryItemId: item.shopify_inventory_item_id, locationId: settings.shopify_location_id,
                                quantity: C.shopQuantity(item), changeFromQuantity: null }] } });
    S.must(q.inventorySetQuantities, 'Changing the number left');
  }
}

// ── Everything out of date, then parcels that have gone ─────
async function syncAll(db, budget) {
  const settings = await readSettings(db);
  const result = { items_done: 0, items_failed: 0, items_left: 0, fulfilled: 0, fulfil_failed: 0 };
  if (!settings.shopify_location_id) { result.note = 'Not connected yet — press Connect Shopify.'; return result; }

  const brands = await brandNames(db);
  const items = (await db.select('outlet_items',
    'select=*&or=(status.eq.live,shopify_product_id.not.is.null)&order=updated_at.asc&limit=500')).filter(C.needsSync);
  const queue = C.orderForSync(items);

  for (const item of queue) {
    if (Date.now() > budget) { result.items_left++; continue; }
    const r = await syncItem(db, settings, item, brands[item.brand_id]);
    if (r.ok) result.items_done++; else result.items_failed++;
  }

  const posted = await db.select('outlet_orders',
    'select=id,shopify_order_id,shopify_line_item_id,quantity,carrier,tracking_number' +
    '&status=eq.shipped&shopify_order_id=not.is.null&shopify_fulfilled_at=is.null&shopify_fulfil_error=is.null&limit=20');
  for (const o of posted) {
    if (Date.now() > budget) break;
    try {
      await fulfil(o);
      await db.patch('outlet_orders', 'id=eq.' + o.id, { shopify_fulfilled_at: new Date().toISOString() });
      result.fulfilled++;
    } catch (err) {
      console.error('fulfil', o.id, err.message);
      await db.patch('outlet_orders', 'id=eq.' + o.id, { shopify_fulfil_error: String(err.message).slice(0, 500) }).catch(function () {});
      result.fulfil_failed++;
    }
  }
  return result;
}

async function fulfil(o) {
  const d = await S.gql(`query f($id: ID!) { order(id: $id) {
      fulfillmentOrders(first: 20) { nodes { id status
        lineItems(first: 50) { nodes { id remainingQuantity lineItem { id } } } } } } }`,
    { id: C.gid('Order', o.shopify_order_id) });
  if (!d.order) throw new Error('Shopify no longer has that order.');
  const want = C.gid('LineItem', o.shopify_line_item_id);
  let target = null;
  d.order.fulfillmentOrders.nodes.forEach(function (fo) {
    fo.lineItems.nodes.forEach(function (li) {
      if (li.lineItem && li.lineItem.id === want && li.remainingQuantity > 0 && !target) {
        target = { fo: fo.id, line: li.id, qty: Math.min(li.remainingQuantity, o.quantity) };
      }
    });
  });
  if (!target) return;                       // already fulfilled in Shopify by hand: nothing to do
  const tracking = { company: o.carrier || 'Other' };
  if (o.tracking_number) tracking.number = o.tracking_number;
  const r = await S.gql(`mutation c($f: FulfillmentInput!) {
      fulfillmentCreate(fulfillment: $f) { fulfillment { id } userErrors { field message } } }`,
    { f: { notifyCustomer: true, trackingInfo: tracking,
           lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: target.fo,
             fulfillmentOrderLineItems: [{ id: target.line, quantity: target.qty }] }] } });
  S.must(r.fulfillmentCreate, 'Marking it sent in Shopify');
}
