// Packet — sizes joining one Shopify product, end to end, with a
// stand-in shop and database. Run: node test/shopify-sizes-flow.test.js
var path = require('path');
var pass = 0, fail = 0;
function check(n, a, e) { var ok = JSON.stringify(a) === JSON.stringify(e); ok ? pass++ : fail++; console.log((ok ? '  PASS  ' : '  FAIL  ') + n + (ok ? '' : '\n        expected ' + JSON.stringify(e) + '\n        got      ' + JSON.stringify(a))); }

// ── stand-in database ───────────────────────────────────────
var rows = { outlet_items: [], app_settings: [{ key: 'shopify_location_id', value: 'gid://shopify/Location/1' }], brands: [{ id: 'b1', name: 'Fern', shopify_collection_id: 'C' }], outlet_orders: [] };
function match(r, q) {
  return q.split('&').every(function (part) {
    var m = part.match(/^([a-z_]+)=(eq|neq|not\.is|is|like)\.(.*)$/); if (!m) return true;
    var v = decodeURIComponent(m[3]), f = r[m[1]];
    if (m[1] === 'or') return true;
    if (m[2] === 'eq') return String(f) === v;
    if (m[2] === 'neq') return String(f) !== v;
    if (m[2] === 'not.is') return f !== null && f !== undefined;
    if (m[2] === 'is') return f === null || f === undefined;
    if (m[2] === 'like') return new RegExp('^' + v.replace(/\*/g, '.*') + '$').test(String(f));
    return true;
  });
}
var db = {
  select: async function (t, q) {
    var list = rows[t].filter(function (r) { return match(r, q.replace(/^select=[^&]*&?/, '').replace(/&?order=[^&]*/, '').replace(/&?limit=[^&]*/, '')); });
    if (/or=\(status\.eq\.live,shopify_product_id\.not\.is\.null\)/.test(q)) list = rows[t].filter(function (r) { return r.status === 'live' || r.shopify_product_id; });
    return JSON.parse(JSON.stringify(list));
  },
  patch: async function (t, q, p) { rows[t].filter(function (r) { return match(r, q); }).forEach(function (r) { Object.assign(r, p); }); },
  upsert: async function () {}
};

// ── stand-in shop ───────────────────────────────────────────
var shop = { products: {}, n: 0 };
async function gql(q, vars) {
  if (/productSet/.test(q)) {
    var id = 'gid://shopify/Product/' + (++shop.n), vid = 'gid://shopify/ProductVariant/' + id.split('/').pop() + '01';
    shop.products[id] = { status: vars.input.status, title: vars.input.title, sizes: [{ size: vars.input.variants[0].optionValues[0].name, sku: vars.input.variants[0].inventoryItem.sku, qty: vars.input.variants[0].inventoryQuantities[0].quantity, vid: vid }] };
    return { productSet: { product: { id: id, variants: { nodes: [{ id: vid, inventoryItem: { id: 'inv-' + vid } }] } }, userErrors: [] } };
  }
  if (/productVariantsBulkCreate/.test(q)) {
    var p = shop.products[vars.productId]; if (!p) return { productVariantsBulkCreate: { productVariants: null, userErrors: [{ message: 'Product does not exist' }] } };
    var nv = vars.variants[0], id2 = vars.productId + '-v' + (p.sizes.length + 1);
    p.sizes.push({ size: nv.optionValues[0].name, sku: nv.inventoryItem.sku, qty: nv.inventoryQuantities[0].availableQuantity, vid: id2 });
    return { productVariantsBulkCreate: { productVariants: [{ id: id2, inventoryItem: { id: 'inv-' + id2 } }], userErrors: [] } };
  }
  if (/productUpdate/.test(q)) {
    var pp = shop.products[vars.product.id]; if (!pp) return { productUpdate: { product: null, userErrors: [{ message: 'Product does not exist' }] } };
    pp.status = vars.product.status; return { productUpdate: { product: { id: vars.product.id }, userErrors: [] } };
  }
  if (/productVariantsBulkUpdate/.test(q)) return { productVariantsBulkUpdate: { userErrors: [] } };
  if (/inventorySetQuantities/.test(q)) {
    var inv = vars.input.quantities[0];
    Object.keys(shop.products).forEach(function (k) { shop.products[k].sizes.forEach(function (s) { if ('inv-' + s.vid === inv.inventoryItemId) s.qty = inv.quantity; }); });
    return { inventorySetQuantities: { userErrors: [] } };
  }
  if (/collections/.test(q)) return { collections: { nodes: [] } };
  return {};
}

var clientPath = path.resolve(__dirname, '../netlify-functions/_shared/shopify-client.js');
var real = require(clientPath);
require.cache[clientPath].exports = Object.assign({}, real, {
  gql: gql, restClient: function () { return db; },
  supabaseConfigured: function () { return true; }, shopifyConfigured: function () { return true; }
});
var F = require('../netlify-functions/outlet-shopify.js');

var t = 0;
function item(id, size, extra) {
  return Object.assign({ id: id, brand_id: 'b1', title: 'Linen wrap dress', colour: 'Sage', size: size, condition: 'returned_as_new', condition_note: null,
    category: 'clothing', status: 'live', quantity: 2, sale_minor: 7600, floor_minor: 5000, photos: [], shopify_product_id: null,
    updated_at: new Date(Date.UTC(2026, 10, 6, 10, 0, t++)).toISOString(), shopify_synced_at: null }, extra || {});
}
async function run() { return JSON.parse((await F.runScheduled({ body: '{}' })).body); }

(async function () {
  console.log('two sizes listed in one run');
  rows.outlet_items.push(item('a0000000-0000-4000-8000-000000000010', '10'), item('a0000000-0000-4000-8000-000000000012', '12', { quantity: 1 }));
  var r = await run();
  check('both synced', r.items_done, 2);
  check('one product in the shop', Object.keys(shop.products).length, 1);
  var P = shop.products['gid://shopify/Product/1'];
  check('with both sizes', P.sizes.map(function (s) { return s.size + ':' + s.qty; }), ['10:2', '12:1']);
  check('both items point at it', rows.outlet_items.map(function (i) { return i.shopify_product_id; }), ['gid://shopify/Product/1', 'gid://shopify/Product/1']);
  check('each item has its own variant', rows.outlet_items[0].shopify_variant_id !== rows.outlet_items[1].shopify_variant_id, true);

  console.log('a third size later, and a faulty one apart');
  rows.outlet_items.push(item('a0000000-0000-4000-8000-000000000014', '14'));
  rows.outlet_items.push(item('a0000000-0000-4000-8000-0000000000f1', '12', { condition: 'minor_fault', condition_note: 'Pull on hem' }));
  await run();
  check('size 14 joined', P.sizes.map(function (s) { return s.size; }), ['10', '12', '14']);
  check('the faulty one is its own listing', Object.keys(shop.products).length, 2);

  console.log('selling out and taking back');
  var i10 = rows.outlet_items[0], i12 = rows.outlet_items[1], i14 = rows.outlet_items[2];
  Object.assign(i10, { quantity: 0, updated_at: '2026-11-06T11:00:00Z' });
  await run();
  check('size 10 sold out, product still showing', [P.sizes[0].qty, P.status], [0, 'ACTIVE']);
  Object.assign(i12, { status: 'withdrawn', updated_at: '2026-11-06T11:01:00Z' });
  await run();
  check('taken-back size 12 cannot be bought', P.sizes[1].qty, 0);
  check('still showing for size 14', P.status, 'ACTIVE');
  Object.assign(i14, { quantity: 0, updated_at: '2026-11-06T11:02:00Z' });
  await run();
  check('every size gone: product hidden', P.status, 'DRAFT');

  console.log('back in stock');
  Object.assign(i14, { quantity: 3, updated_at: '2026-11-06T11:03:00Z' });
  await run();
  check('shows again with 3 of size 14', [P.status, P.sizes[2].qty], ['ACTIVE', 3]);

  console.log('deleted by hand in Shopify');
  delete shop.products['gid://shopify/Product/1'];
  Object.assign(i14, { updated_at: '2026-11-06T11:04:00Z' });
  await run();
  check('relisted as a fresh product', Object.keys(shop.products).length, 2);
  check('the other sizes let go of the old one', [i10.shopify_product_id, i12.shopify_product_id], [null, null]);
  check('size 14 on the new product', !!shop.products[i14.shopify_product_id], true);

  console.log('the brand preview groups the same way as the shop');
  var O = require('../admin/packet-outlet.js'), CC = require('../netlify-functions/_shared/outlet-shopify-core.js');
  var cases = [item('x1', '10'), item('x2', '12', { title: ' LINEN wrap  dress' }), item('x3', '10', { colour: 'Navy' }), item('x4', ''),
    item('x5', '10', { condition: 'minor_fault', condition_note: 'x' }), item('x6', '10', { condition_note: 'belt missing' }), item('x7', 'M', { brand_id: 'b2' })];
  check('same answer for every case', cases.map(O.groupKey), cases.map(CC.groupKey));
  check('sizes in a sensible order', ['12', '8', '10', '6'].sort(O.sizeOrder).concat(['L', 'XS', 'M', 'S'].sort(O.sizeOrder)), ['6', '8', '10', '12', 'XS', 'S', 'M', 'L']);

  console.log('sizes go up smallest first');
  var q = CC.orderForSync([item('s12', '12'), item('o1', '', { title: 'Tote' }), item('s8', '8'), item('s10', '10')]);
  check('8, 10, 12 together, others kept in place', q.map(function (x) { return x.id; }), ['s8', 's10', 's12', 'o1']);
  check('core and preview order sizes alike', ['14', '6', 'XL', 'S'].map(function (v, k, a) { return a.slice().sort(CC.sizeOrder); })[0], ['14', '6', 'XL', 'S'].sort(O.sizeOrder));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(function (e) { console.error(e); process.exit(1); });
