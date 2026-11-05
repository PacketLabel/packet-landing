// Packet — onboarding any brand, end to end, against stand-ins for the
// database, Supabase logins, Resend, WooCommerce and Shopify.
// Run: node test/onboarding-flow.test.js   (no network, nothing real touched)
process.env.SUPABASE_URL = 'https://db.test'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc';
process.env.URL = 'https://admin.packetlabel.com'; process.env.RESEND_API_KEY = 're_test';
delete process.env.SHOPIFY_LINK_CLIENT_ID; delete process.env.SHOPIFY_LINK_CLIENT_SECRET;
var pass = 0, fail = 0;
function check(n, a, e) { var ok = JSON.stringify(a) === JSON.stringify(e); ok ? pass++ : fail++; console.log((ok ? '  PASS  ' : '  FAIL  ') + n + (ok ? '' : '\n        expected ' + JSON.stringify(e) + '\n        got      ' + JSON.stringify(a))); }

// ── stand-in database ──
var T = {
  brands: [], brand_applications: [], brand_shops: [], outlet_items: [], outlet_orders: [], category_settings: [{ category: 'clothing' }],
  user_profiles: [{ id: 'owner1', role: 'owner' }, { id: 'staff1', role: 'staff' }],
  app_settings: [{ key: 'email_from_address', value: 'info@packetlabel.com' }, { key: 'outlet_notify_email', value: 'phil@packetlabel.com' }]
};
var nid = 1;
function match(row, q) {
  return q.every(function (c) {
    if (/^or=/.test(c)) return true;
    var m = c.match(/^(\w+)=(eq|in|is|not\.is|ilike|gt)\.(.*)$/); if (!m) return true;
    var v = row[m[1]], arg = decodeURIComponent(m[3]);
    if (m[2] === 'eq') return String(v) === arg;
    if (m[2] === 'in') return arg.replace(/[()]/g, '').split(',').indexOf(String(v)) > -1;
    if (m[2] === 'is') return v == null;
    if (m[2] === 'not.is') return v != null;
    if (m[2] === 'gt') return v > arg || (typeof v === 'number' && v > Number(arg));
    if (m[2] === 'ilike') return new RegExp('^' + arg.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i').test(String(v || ''));
  });
}
function rest(method, url, body) {
  var u = new URL(url), table = u.pathname.split('/').pop();
  var q = u.search.slice(1).split('&').filter(function (x) { return x && !/^(select|order|limit|on_conflict)=/.test(x); });
  var rows = T[table];
  if (!rows) throw new Error('no table ' + table);
  if (method === 'GET') return rows.filter(function (r) { return match(r, q); });
  if (method === 'POST') {
    if (!Array.isArray(body)) body = [body];
    var made = body.map(function (r) {
      var ex = table === 'user_profiles' ? rows.filter(function (x) { return x.id === r.id; })[0] : null;
      if (ex) { Object.assign(ex, r); return ex; }
      var defaults = table === 'brand_applications' ? { status: 'new' } : table === 'brand_shops' ? { status: 'waiting', outlet_tag: 'packet-outlet', default_condition: 'new_with_tags', default_category: 'clothing', lowest_pct: 50 } : {};
      var row = Object.assign({ id: require('crypto').randomUUID(), created_at: new Date().toISOString() }, defaults, r); rows.push(row); return row;
    });
    return made;
  }
  if (method === 'PATCH') { rows.filter(function (r) { return match(r, q); }).forEach(function (r) { Object.assign(r, body); }); return null; }
}

// ── stand-in Supabase logins ──
var users = [];   // { id, email, app_metadata }
var tokens = { 'tok-owner': 'owner1', 'tok-staff': 'staff1' };
function auth(method, url, body) {
  if (/\/auth\/v1\/user$/.test(url)) return null;
  if (/admin\/users\?/.test(url) && method === 'GET') return { users: users };
  if (/admin\/users$/.test(url) && method === 'POST') {
    if (users.some(function (x) { return x.email === body.email; })) return [422, { msg: 'already registered' }];
    var u = { id: require('crypto').randomUUID(), email: body.email, app_metadata: body.app_metadata || {} };
    users.push(u);
    if (u.app_metadata.packet_role === 'brand') T.user_profiles.push({ id: u.id, role: 'brand', brand_id: u.app_metadata.brand_id });
    return u;
  }
  if (/generate_link/.test(url)) return { action_link: 'https://db.test/auth/v1/verify?token=abc&type=recovery&redirect_to=' + encodeURIComponent(body.redirect_to) };
  throw new Error('unexpected auth ' + method + ' ' + url);
}
var mails = [];

// ── stand-in WooCommerce ──
var woo = {
  currency: 'GBP',
  stock: { 'p:10': 2, 'v:20:21': 1, 'v:20:22': 4 },
  puts: []
};
function wooApi(method, url, body) {
  var path = url.replace(/^https:\/\/shop\.example\/wp-json\/wc\/v3\//, '').replace(/[?&]consumer_key=.*$/, '');
  if (/^settings\/general\/woocommerce_currency/.test(path)) return { id: 'woocommerce_currency', value: woo.currency };
  if (/^products\/tags\?slug=packet-outlet/.test(path)) return [{ id: 7, slug: 'packet-outlet', name: 'packet-outlet' }];
  if (/^products\?/.test(path)) return [
    { id: 10, name: 'Linen shirt', type: 'simple', status: 'publish', sku: 'LS-1', price: '40.00', regular_price: '60.00', sale_price: '40.00',
      manage_stock: true, stock_quantity: woo.stock['p:10'], description: '<p>Washed linen.</p>',
      images: [{ src: 'https://shop.example/a.jpg' }], categories: [{ name: 'Shirts' }], tags: [{ name: 'packet-outlet' }, { name: 'packet-condition:returned as new' }] },
    { id: 20, name: 'Cord trousers', type: 'variable', status: 'publish', sku: 'CT', price: '80.00', regular_price: '80.00', sale_price: '',
      manage_stock: false, description: '', short_description: 'Needlecord.', images: [{ src: 'https://shop.example/b.jpg' }],
      categories: [{ name: 'Trousers' }], tags: [{ name: 'packet-outlet' }, { name: 'packet-lowest:30' }] }
  ];
  if (/^products\/20\/variations\?/.test(path)) return [
    { id: 21, status: 'publish', sku: 'CT-10', price: '80.00', regular_price: '80.00', sale_price: '', manage_stock: true, stock_quantity: woo.stock['v:20:21'], attributes: [{ name: 'Size', option: '10' }] },
    { id: 22, status: 'publish', sku: 'CT-12', price: '80.00', regular_price: '80.00', sale_price: '', manage_stock: true, stock_quantity: woo.stock['v:20:22'], attributes: [{ name: 'Size', option: '12' }] }
  ];
  var m = path.match(/^products\/(\d+)(?:\/variations\/(\d+))?$/);
  if (m) {
    var key = m[2] ? 'v:' + m[1] + ':' + m[2] : 'p:' + m[1];
    if (method === 'PUT') { woo.puts.push([key, body.stock_quantity]); woo.stock[key] = body.stock_quantity; return {}; }
    return { id: +m[1], manage_stock: true, stock_quantity: woo.stock[key] };
  }
  throw new Error('unexpected woo ' + path);
}

// ── stand-in Shopify (the brand's own app) ──
function shopifyToken(body) {
  var p = new URLSearchParams(body);
  return p.get('grant_type') === 'client_credentials' && p.get('client_secret') === 'own-secret'
    ? [200, { access_token: 'cc-tok', expires_in: 86399, scope: 'read_products' }] : [400, { error: 'invalid_client' }];
}
function shopifyGql(body) {
  var b = JSON.parse(body);
  if (/currencyCode/.test(b.query)) return { data: { shop: { currencyCode: 'GBP' } } };
  if (/products\(/.test(b.query)) return { data: { products: { pageInfo: { hasNextPage: false }, nodes: [] } } };
  return { errors: [{ message: 'unexpected query' }] };
}

global.fetch = async function (url, opt) {
  opt = opt || {}; var method = opt.method || 'GET', out, status = 200, hdrs = {};
  var body = opt.body;
  var authz = (opt.headers && (opt.headers.authorization || opt.headers.Authorization)) || '';
  if (url.indexOf('https://db.test/rest/v1/') === 0) out = rest(method, url, body ? JSON.parse(body) : null);
  else if (/https:\/\/db\.test\/auth\/v1\/user$/.test(url)) {
    var tok = authz.replace('Bearer ', ''); var uid = tokens[tok];
    if (!uid) { status = 401; out = { msg: 'no' }; } else out = { id: uid };
  }
  else if (url.indexOf('https://db.test/auth/v1/') === 0) { var r = auth(method, url, body ? JSON.parse(body) : null); if (Array.isArray(r)) { status = r[0]; out = r[1]; } else out = r; }
  else if (url === 'https://api.resend.com/emails') { var m = JSON.parse(body); mails.push(m); out = { id: 'm' + mails.length }; }
  else if (url.indexOf('https://shop.example/wp-json/') === 0) { out = wooApi(method, url, body ? JSON.parse(body) : null); hdrs['x-wp-totalpages'] = '1'; }
  else if (/myshopify\.com\/admin\/oauth\/access_token/.test(url)) { var t = shopifyToken(body); status = t[0]; out = t[1]; }
  else if (/myshopify\.com\/admin\/api\/.*graphql\.json/.test(url)) out = shopifyGql(body);
  else throw new Error('unexpected ' + url);
  return { ok: status < 300, status: status, headers: { get: function (k) { return hdrs[k.toLowerCase()] || null; } },
    text: async function () { return out == null ? '' : JSON.stringify(out); }, json: async function () { return out; } };
};

var Onboard = require('../netlify-functions/brand-onboard.js');
var Shop = require('../netlify-functions/brand-shop.js');
function post(F, body, token, qs) {
  return F.handler({ httpMethod: 'POST', body: JSON.stringify(body), queryStringParameters: qs || {},
    headers: token ? { authorization: 'Bearer ' + token } : {} }).then(function (r) { return { status: r.statusCode, d: JSON.parse(r.body) }; });
}

var good = { action: 'apply', company_name: 'Fern & Thread', website: 'www.fernandthread.co.uk/shop', contact_name: 'Ruth Hale',
  contact_email: 'Ruth@FernAndThread.co.uk', country: 'GB', platform: 'woocommerce', categories: ['clothing', 'accessories'],
  stock_kinds: ['returns', 'end_of_season'], agree_contact: true, message: 'About 60 returns a month.' };

(async function () {
  console.log('applying');
  var r = await post(Onboard, good);
  var app = T.brand_applications[0];
  check('application stored', [r.status, r.d.ok, T.brand_applications.length], [200, true, 1]);
  check('website and email tidied', [app.website, app.contact_email, app.status, app.source], ['https://fernandthread.co.uk', 'ruth@fernandthread.co.uk', 'new', 'apply page']);
  check('Packet told, brand thanked', mails.map(function (m) { return m.to[0]; }), ['phil@packetlabel.com', 'ruth@fernandthread.co.uk']);
  check('Packet\'s email can be replied to straight to the brand', mails[0].reply_to, 'ruth@fernandthread.co.uk');

  r = await post(Onboard, Object.assign({}, good, { company_fax: 'buy pills' }));
  check('a bot is told it worked and nothing is stored', [r.status, T.brand_applications.length], [200, 1]);
  r = await post(Onboard, Object.assign({}, good, { categories: [], contact_email: 'nope' }));
  check('missing answers explained', [r.status, /Tick at least one/.test(r.d.error), /email address/.test(r.d.error)], [400, true, true]);
  await post(Onboard, good); await post(Onboard, good);
  r = await post(Onboard, good);
  check('a fourth try in a day is turned away politely', [r.status, /already have your application/.test(r.d.error)], [429, true]);

  console.log('approving');
  r = await post(Onboard, { action: 'list' });
  check('the list needs a login', r.status, 401);
  r = await post(Onboard, { action: 'approve', id: app.id, commission_pct: 20 }, 'tok-staff');
  check('staff cannot make logins', r.status, 403);
  r = await post(Onboard, { action: 'approve', id: app.id }, 'tok-owner');
  check('no commission, no approval', [r.status, /percentage Packet keeps/.test(r.d.error)], [400, true]);
  r = await post(Onboard, { action: 'approve', id: app.id, commission_pct: 20, auto_list: true }, 'tok-owner');
  check('auto-list without a discount is refused', [r.status, /normal Outlet discount/.test(r.d.error)], [400, true]);
  mails = [];
  r = await post(Onboard, { action: 'approve', id: app.id, commission_pct: 20, discount_pct: 35 }, 'tok-owner');
  var brand = T.brands[0];
  check('approved and emailed', [r.status, r.d.ok, r.d.emailed], [200, true, true]);
  check('brand made with the offer, not the agreement', [brand.name, brand.found_via, brand.status, brand.outlet_commission_offered_pct, brand.outlet_commission_pct, brand.outlet_discount_pct, brand.category],
    ['Fern & Thread', 'application', 'invited', 20, undefined, 35, 'clothing']);
  check('login stamped as this brand', [users.length, users[0].app_metadata.packet_role, users[0].app_metadata.brand_id], [1, 'brand', brand.id]);
  check('invite email carries the set-password link and the %', [mails[0].to[0], /verify\?token=abc/.test(mails[0].html), /keeps 20%/.test(mails[0].html), /brand\.html/.test(mails[0].text)], ['ruth@fernandthread.co.uk', true, true, true]);
  check('application marked approved', [app.status, app.brand_id], ['approved', brand.id]);
  r = await post(Onboard, { action: 'approve', id: app.id, commission_pct: 20 }, 'tok-owner');
  check('approving twice is refused', r.status, 400);

  r = await post(Onboard, { action: 'resend', brand_id: brand.id }, 'tok-owner');
  check('a fresh link can be sent', [r.status, r.d.emailed, r.d.email], [200, true, 'ruth@fernandthread.co.uk']);

  console.log('inviting a brand met in person');
  r = await post(Onboard, { action: 'invite', company_name: 'Dublin Knits', website: 'dublinknits.ie', contact_name: 'Ciara Byrne',
    contact_email: 'ciara@dublinknits.ie', country: 'IE', platform: 'shopify', categories: ['clothing'], commission_pct: 15 }, 'tok-owner');
  var dk = T.brands[1];
  check('invited directly, no application needed', [r.status, dk.name, dk.country, dk.uk_based, T.brand_applications.slice(-1)[0].source], [200, 'Dublin Knits', 'IE', 'no', 'invited by Packet']);
  r = await post(Onboard, { action: 'invite', company_name: 'Other', website: 'other.com', contact_name: 'X', contact_email: 'ciara@dublinknits.ie', categories: ['home'], commission_pct: 15 }, 'tok-owner');
  check('an email already used for another brand is refused', [r.status, /already has a Packet login/.test(r.d.error)], [400, true]);

  // ── The brand connects their WooCommerce ──
  console.log('WooCommerce');
  tokens['tok-ruth'] = users[0].id;
  r = await post(Shop, { action: 'connect_woo', site: 'http://shop.example' }, 'tok-ruth');
  check('http refused', r.status, 400);
  r = await post(Shop, { action: 'connect_woo', site: 'shop.example/wp-admin/' }, 'tok-ruth');
  var conn = T.brand_shops[0];
  var u = new URL(r.d.install_url);
  check('sent to WooCommerce\'s approve screen', [r.status, u.origin + u.pathname, u.searchParams.get('scope'), u.searchParams.get('callback_url')],
    [200, 'https://shop.example/wc-auth/v1/authorize', 'read_write', 'https://admin.packetlabel.com/.netlify/functions/brand-shop?woo=callback']);
  check('waiting until WooCommerce replies', [conn.platform, conn.site_url, conn.status], ['woocommerce', 'https://shop.example', 'waiting']);
  r = await post(Shop, { user_id: 'f'.repeat(36), consumer_key: 'ck', consumer_secret: 'cs', key_permissions: 'read_write' }, null, { woo: 'callback' });
  check('keys for an unknown request are refused', r.status, 404);
  r = await post(Shop, { key_id: 1, user_id: u.searchParams.get('user_id'), consumer_key: 'ck_1', consumer_secret: 'cs_1', key_permissions: 'read_write' }, null, { woo: 'callback' });
  check('keys stored, connected', [r.status, conn.status, conn.consumer_key, conn.oauth_state], [200, 'connected', 'ck_1', null]);

  await Shop.runScheduled();
  var items = T.outlet_items.filter(function (i) { return i.brand_id === brand.id; });
  check('three sizes came across', items.map(function (i) { return [i.title, i.size, i.quantity, i.source, i.source_ref]; }),
    [['Linen shirt', null, 2, 'woocommerce', 'woo:p:10'], ['Cord trousers', '10', 1, 'woocommerce', 'woo:v:20:21'], ['Cord trousers', '12', 4, 'woocommerce', 'woo:v:20:22']]);
  check('sale price read as their price, condition and lowest from tags', [items[0].rrp_minor, items[0].condition, items[1].floor_minor, items[1].rrp_minor],
    [6000, 'returned_as_new', 3000, 8000]);

  console.log('a Packet sale');
  items[2].quantity = 3;
  T.outlet_orders.push({ id: 'o1', brand_id: brand.id, item_id: items[2].id, quantity: 1, order_ref: 'PK-2001', status: 'to_ship', is_test: false });
  await Shop.runScheduled();
  check('taken off their WooCommerce stock', [woo.puts, !!T.outlet_orders[0].brand_stock_taken_at], [[['v:20:22', 3]], true]);
  check('Outlet follows their shop', items[2].quantity, 3);

  console.log('a shop priced in euros');
  woo.currency = 'EUR';
  await Shop.runScheduled();
  check('stopped with a reason', [conn.status, /prices are in EUR/.test(conn.last_error)], ['error', true]);
  woo.currency = 'GBP';

  console.log('brand disconnects');
  r = await post(Shop, { action: 'disconnect' }, 'tok-ruth');
  check('keys forgotten, items off sale', [conn.status, conn.consumer_key, items.every(function (i) { return i.quantity === 0; })], ['disconnected', null, true]);

  // ── A Shopify brand ──
  console.log('Shopify, no app yet');
  tokens['tok-ciara'] = users[1].id;
  mails = [];
  r = await post(Shop, { action: 'connect_shopify', shop: 'dublin-knits' }, 'tok-ciara');
  var sc = T.brand_shops.filter(function (s) { return s.brand_id === dk.id; })[0];
  check('waiting for Packet, Packet emailed', [r.d.waiting, sc.needs_packet_app, sc.shop_domain, mails.length && /dublin-knits\.myshopify\.com/.test(mails[0].html)],
    [true, true, 'dublin-knits.myshopify.com', true]);
  r = await post(Shop, { action: 'connect_shopify', shop: 'fernandthread' }, 'tok-ruth');
  r = await post(Shop, { action: 'connect_shopify', shop: 'dublin-knits' }, 'tok-ruth');
  check('one brand cannot claim another\'s shop', [r.status, /already linked/.test(r.d.error)], [400, true]);

  console.log('Shopify, their own app');
  r = await post(Shop, { action: 'connect_shopify', shop: 'dublin-knits.myshopify.com', client_id: 'own-id', client_secret: 'wrong' }, 'tok-ciara');
  check('keys Shopify will not take: install link instead', [r.status, /\/admin\/oauth\/authorize/.test(r.d.install_url || '')], [200, true]);
  r = await post(Shop, { action: 'connect_shopify', shop: 'dublin-knits.myshopify.com', client_id: 'own-id', client_secret: 'own-secret' }, 'tok-ciara');
  check('connected at once with their own app', [r.status, r.d.connected, sc.status, sc.token_grant, sc.access_token, sc.needs_packet_app], [200, true, 'connected', 'client_credentials', 'cc-tok', false]);

  r = await post(Shop, { action: 'defaults', default_condition: 'new_no_tags', lowest_pct: 60 }, 'tok-ciara');
  check('brand sets its own defaults', [r.status, sc.default_condition, sc.lowest_pct], [200, 'new_no_tags', 60]);
  r = await post(Shop, { action: 'save', brand_id: dk.id, shop: 'x' }, 'tok-ciara');
  check('a brand cannot use staff actions', r.status, 403);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(function (e) { console.error(e); process.exit(1); });
