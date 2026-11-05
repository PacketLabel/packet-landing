// Packet — the shop link, end to end against a stand-in Shopify and database.
// Run: node test/brand-shop-flow.test.js   (no network, nothing real touched)
var crypto = require('crypto');
process.env.SUPABASE_URL = 'https://db.test'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc'; process.env.URL = 'https://admin.packetlabel.com';
var pass = 0, fail = 0;
function check(n, a, e) { var ok = JSON.stringify(a) === JSON.stringify(e); ok ? pass++ : fail++; console.log((ok ? '  PASS  ' : '  FAIL  ') + n + (ok ? '' : '\n        expected ' + JSON.stringify(e) + '\n        got      ' + JSON.stringify(a))); }

// ── stand-in database ──
var T = { brand_shops: [{ id: 'c1', brand_id: 'b1', shop_domain: 'hotsquash.myshopify.com', client_id: 'cid', client_secret: 'sec',
  status: 'waiting', outlet_tag: 'packet-outlet', default_condition: 'returned_as_new', default_category: 'clothing', lowest_pct: 50, access_token: null }],
  outlet_items: [], outlet_orders: [] };
var nid = 1;
function match(row, q) {
  return q.every(function (c) {
    var m = c.match(/^(\w+)=(eq|in|is|not\.is)\.(.*)$/); if (!m) return true;
    var v = row[m[1]], arg = decodeURIComponent(m[3]);
    if (m[2] === 'eq') return String(v) === arg;
    if (m[2] === 'in') return arg.replace(/[()]/g, '').split(',').indexOf(String(v)) > -1;
    if (m[2] === 'is') return v == null;
    if (m[2] === 'not.is') return v != null;
  });
}
function rest(method, url, body) {
  var u = new URL(url), table = u.pathname.split('/').pop();
  var q = u.search.slice(1).split('&').filter(function (x) { return !/^(select|order|limit|on_conflict)=/.test(x); });
  var rows = T[table];
  if (method === 'GET') return rows.filter(function (r) { return match(r, q); });
  if (method === 'POST') { body.forEach(function (r) { rows.push(Object.assign({ id: 'i' + (nid++), sale_minor: null }, r)); }); return null; }
  if (method === 'PATCH') { rows.filter(function (r) { return match(r, q); }).forEach(function (r) { Object.assign(r, body); }); return null; }
}

// ── stand-in Shopify ──
var stock = { 'gid://shopify/InventoryItem/111': 3 }; var adjusts = [];
function shopify(body) {
  var b = JSON.parse(body);
  if (/products\(/.test(b.query)) return { data: { products: { pageInfo: { hasNextPage: false }, nodes: [{
    id: 'gid://shopify/Product/1', title: 'Wrap dress', productType: 'Dress', descriptionHtml: '<p>Jersey.</p>',
    tags: ['packet-outlet'], images: { nodes: [{ url: 'https://cdn.shopify.com/d.jpg' }] },
    variants: { nodes: [{ id: 'gid://shopify/ProductVariant/11', sku: 'WD-10', price: '75.00', compareAtPrice: null,
      inventoryQuantity: stock['gid://shopify/InventoryItem/111'], selectedOptions: [{ name: 'Size', value: '10' }],
      inventoryItem: { id: 'gid://shopify/InventoryItem/111', tracked: true } }] } }] } } };
  if (/inventoryLevels/.test(b.query)) return { data: { inventoryItem: { inventoryLevels: { nodes: [
    { location: { id: 'L1' }, quantities: [{ quantity: stock[b.variables.id] }] }] } } } };
  if (/inventoryAdjustQuantities/.test(b.query)) {
    var ch = b.variables.input.changes[0]; adjusts.push(ch.delta); stock[ch.inventoryItemId] += ch.delta;
    return { data: { inventoryAdjustQuantities: { userErrors: [] } } };
  }
  return { errors: [{ message: 'unexpected query' }] };
}
global.fetch = async function (url, opt) {
  opt = opt || {}; var out, status = 200;
  if (url.indexOf('https://db.test/rest/v1/') === 0) out = rest(opt.method || 'GET', url, opt.body ? JSON.parse(opt.body) : null);
  else if (/oauth\/access_token/.test(url)) { var p = JSON.parse(opt.body); out = p.code === 'good' && p.client_secret === 'sec' ? { access_token: 'tok', scope: 'read_products' } : (status = 400, { error: 'bad code' }); }
  else if (/graphql\.json/.test(url)) out = shopify(opt.body);
  else if (/auth\/v1\/user/.test(url)) out = { id: 'u1' };
  else throw new Error('unexpected ' + url);
  return { ok: status < 300, status: status, text: async function () { return out == null ? '' : JSON.stringify(out); }, json: async function () { return out; } };
};

function signed(q) {
  var keys = Object.keys(q).sort(), msg = keys.map(function (k) { return k + '=' + q[k]; }).join('&');
  return Object.assign({}, q, { hmac: crypto.createHmac('sha256', 'sec').update(msg).digest('hex') });
}
var F = require('../netlify-functions/brand-shop.js');
var ts = String(Math.floor(Date.now() / 1000));

(async function () {
  console.log('install');
  var r = await F.handler({ httpMethod: 'GET', queryStringParameters: signed({ shop: 'hotsquash.myshopify.com', timestamp: ts }), headers: {} });
  check('Shopify opening the app sends the brand to approve', [r.statusCode, /\/admin\/oauth\/authorize/.test(r.headers.location)], [302, true]);
  var state = T.brand_shops[0].oauth_state;
  var forged = await F.handler({ httpMethod: 'GET', queryStringParameters: Object.assign(signed({ shop: 'hotsquash.myshopify.com', timestamp: ts }), { shop: 'evil.myshopify.com' }), headers: {} });
  check('a forged link is refused', forged.statusCode === 404 || forged.statusCode === 403, true);
  var wrongState = await F.handler({ httpMethod: 'GET', queryStringParameters: signed({ shop: 'hotsquash.myshopify.com', timestamp: ts, code: 'good', state: 'nope' }), headers: {} });
  check('an approval that is not ours is refused', wrongState.statusCode, 403);

  console.log('approval and first read');
  r = await F.handler({ httpMethod: 'GET', queryStringParameters: signed({ shop: 'hotsquash.myshopify.com', timestamp: ts, code: 'good', state: state }), headers: {} });
  check('connected page shown', [r.statusCode, /Your shop is connected/.test(r.body), /1 new item/.test(r.body)], [200, true, true]);
  check('key stored, status connected', [T.brand_shops[0].access_token, T.brand_shops[0].status], ['tok', 'connected']);
  var it = T.outlet_items[0];
  check('item came across for Packet to price', [it.title, it.size, it.quantity, it.floor_minor, it.condition, it.status, it.source], ['Wrap dress', '10', 3, 3750, 'returned_as_new', 'submitted', 'shopify']);

  console.log('a Packet sale');
  it.quantity = 2;   // what the order trigger does
  T.outlet_orders.push({ id: 'o1', brand_id: 'b1', item_id: it.id, quantity: 1, order_ref: 'PK-1001', status: 'to_ship', is_test: false });
  await F.runScheduled();
  check('taken off their Shopify stock once', [adjusts, stock['gid://shopify/InventoryItem/111']], [[-1], 2]);
  check('order marked done; Outlet still shows 2', [!!T.outlet_orders[0].brand_stock_taken_at, it.quantity], [true, 2]);
  await F.runScheduled();
  check('a second run does not take it twice', adjusts, [-1]);

  console.log('they sell one on their own site');
  stock['gid://shopify/InventoryItem/111'] = 1;
  await F.runScheduled();
  check('Outlet follows to 1', it.quantity, 1);

  console.log('the Packet order is cancelled');
  T.outlet_orders[0].status = 'cancelled';
  await F.runScheduled();
  check('put back on their Shopify stock', [adjusts, stock['gid://shopify/InventoryItem/111'], !!T.outlet_orders[0].brand_stock_returned_at], [[-1, 1], 2, true]);

  console.log('they take the tag off');
  var orig = shopify; shopify = function (b) { var d = orig(b); if (d.data && d.data.products) d.data.products.nodes = []; return d; };
  await F.runScheduled();
  check('Outlet goes to 0', it.quantity, 0);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(function (e) { console.error(e); process.exit(1); });
