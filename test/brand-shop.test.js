// Packet — the shop link checks (no network, no database).
// Run: node test/brand-shop.test.js

var crypto = require('crypto');
var L = require('../netlify-functions/_shared/brand-shop-core.js');
var pass = 0, fail = 0;
function check(name, actual, expected) {
  var ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + '\n        expected ' + JSON.stringify(expected) + '\n        got      ' + JSON.stringify(actual)); }
}

console.log('shop addresses');
check('bare name', L.normaliseShop('hotsquash'), 'hotsquash.myshopify.com');
check('full admin link', L.normaliseShop('https://HotSquash.myshopify.com/admin/products'), 'hotsquash.myshopify.com');
check('new-style admin link', L.normaliseShop('https://admin.shopify.com/store/hot-squash/products'), 'hot-squash.myshopify.com');
check('public web address refused', L.normaliseShop('hotsquash.com'), null);
check('nonsense refused', L.normaliseShop('hot squash!'), null);

console.log('Shopify signature');
var secret = 'shpss_test';
var q = { code: 'abc', shop: 'hotsquash.myshopify.com', state: 's1', timestamp: '1700000000' };
var msg = 'code=abc&shop=hotsquash.myshopify.com&state=s1&timestamp=1700000000';
q.hmac = crypto.createHmac('sha256', secret).update(msg).digest('hex');
check('genuine accepted', L.verifyQueryHmac(q, secret), true);
check('wrong secret refused', L.verifyQueryHmac(q, 'other'), false);
check('tampered shop refused', L.verifyQueryHmac(Object.assign({}, q, { shop: 'evil.myshopify.com' }), secret), false);
check('no hmac refused', L.verifyQueryHmac({ shop: 'x' }, secret), false);

console.log('install link');
var u = new URL(L.installUrl('hotsquash.myshopify.com', 'cid', 'https://admin.packetlabel.com/.netlify/functions/brand-shop', 'st'));
check('goes to their shop', u.host, 'hotsquash.myshopify.com');
check('asks only for what it needs', u.searchParams.get('scope'), 'read_products,read_inventory,write_inventory,read_locations');
check('carries the state', u.searchParams.get('state'), 'st');

console.log('tags');
var tags = ['Sale', 'packet-outlet', 'Packet-Condition:Returned as new', 'packet-note: Small pull on cuff', 'packet-lowest:45'];
check('value read, case ignored', L.tagValue(tags, 'packet-condition'), 'Returned as new');
check('condition from words', L.conditionFrom('Returned as new'), 'returned_as_new');
check('condition from slug', L.conditionFrom('small-fault'), 'minor_fault');
check('unknown condition', L.conditionFrom('mint'), null);
check('price tag', L.pence('£45'), 4500);
check('category from type', L.categoryFrom('Ankle Boots', [], 'clothing'), 'footwear');
check('category falls back', L.categoryFrom('Gift card', [], 'home'), 'home');
check('html to text', L.textFromHtml('<p>Soft &amp; warm.</p><p>Hand wash.</p>'), 'Soft & warm.\nHand wash.');

var conn = { brand_id: 'b1', default_condition: 'new_with_tags', default_category: 'clothing', lowest_pct: 50 };
function product(over) {
  return Object.assign({
    id: 'gid://shopify/Product/1', title: 'Wool cardigan', productType: 'Knitwear', descriptionHtml: '<p>Recycled wool.</p>',
    tags: ['packet-outlet'], images: { nodes: [{ url: 'https://cdn.shopify.com/a.jpg' }, { url: 'http://x/b.jpg' }] },
    variants: { nodes: [
      { id: 'gid://shopify/ProductVariant/11', sku: 'CARD-OL-10', price: '89.00', compareAtPrice: null, inventoryQuantity: 3,
        selectedOptions: [{ name: 'Size', value: '10' }, { name: 'Colour', value: 'Olive' }], inventoryItem: { id: 'gid://shopify/InventoryItem/111', tracked: true } },
      { id: 'gid://shopify/ProductVariant/12', sku: 'CARD-OL-12', price: '60.00', compareAtPrice: '89.00', inventoryQuantity: 0,
        selectedOptions: [{ name: 'Size', value: '12' }, { name: 'Colour', value: 'Olive' }], inventoryItem: { id: 'gid://shopify/InventoryItem/112', tracked: true } }
    ] }
  }, over || {});
}

console.log('variant → item');
var r = L.itemFromVariant(product(), product().variants.nodes[0], conn).item;
check('size and colour split out', [r.title, r.size, r.colour], ['Wool cardigan', '10', 'Olive']);
check('default lowest is 50% of their price', [r.rrp_minor, r.floor_minor], [8900, 4450]);
check('only https photos', r.photos, ['https://cdn.shopify.com/a.jpg']);
check('their code kept', r.brand_sku, 'CARD-OL-10');
var r2 = L.itemFromVariant(product(), product().variants.nodes[1], conn).item;
check('already on sale: normal price is the was-price', r2.rrp_minor, 8900);
var capped = L.itemFromVariant(product({ tags: ['packet-outlet', 'packet-qty:2'] }), product().variants.nodes[0], conn).item;
check('packet-qty caps what is offered', capped.quantity, 2);
var untracked = L.itemFromVariant(product(), Object.assign({}, product().variants.nodes[0], { inventoryItem: { id: 'x', tracked: false } }), conn);
check('untracked stock without packet-qty is skipped with a reason', !!untracked.skip, true);
var lowTag = L.itemFromVariant(product({ tags: ['packet-outlet', 'packet-lowest:120'] }), product().variants.nodes[0], conn).item;
check('lowest above their price is brought down to it', lowTag.floor_minor, 8900);

console.log('planSync — first run');
var first = L.planSync([product()], [], conn, {});
check('size 10 added for Packet to price; sold-out size 12 waits', [first.inserts.length, first.inserts[0].status, first.inserts[0].size], [1, 'submitted', '10']);
var faulty = L.planSync([product({ tags: ['packet-outlet', 'packet-condition:small fault'] })], [], conn, {});
check('fault with no note waits for the brand', [faulty.inserts[0].status, faulty.warnings.length], ['draft', 1]);
var beauty = L.planSync([product({ productType: 'Face serum' })], [], conn, {});
check('beauty without RP tag waits for the brand', beauty.inserts[0].status, 'draft');

console.log('planSync — later runs');
var have = [
  { id: 'i10', source_ref: 'gid://shopify/ProductVariant/11', quantity: 3, rrp_minor: 8900, floor_minor: 4450, sale_minor: 5200, condition: 'new_with_tags', brand_sku: 'CARD-OL-10', title: 'Wool cardigan', size: '10' },
  { id: 'iGone', source_ref: 'gid://shopify/ProductVariant/99', quantity: 4, rrp_minor: 3000, floor_minor: 1500, condition: 'new_with_tags', title: 'Old scarf' }
];
var same = L.planSync([product()], have.slice(0, 1), conn, {});
check('nothing changed, nothing written', same.updates, []);
var sold = L.planSync([product({ variants: { nodes: [Object.assign({}, product().variants.nodes[0], { inventoryQuantity: 1 })] } })], have, conn, {});
check('sold on their site: quantity follows; untagged item goes to 0',
  sold.updates, [{ id: 'i10', patch: { quantity: 1 } }, { id: 'iGone', patch: { quantity: 0 } }]);
var pend = L.planSync([product()], have.slice(0, 1), conn, { i10: 1 });
check('a Packet sale not yet taken off their shop is held back', pend.updates, [{ id: 'i10', patch: { quantity: 2 } }]);
var tooHigh = L.planSync([product({ tags: ['packet-outlet', 'packet-lowest:60'] })], have.slice(0, 1), conn, {});
check('lowest raised above our live price: left alone, brand told', [tooHigh.updates, tooHigh.warnings.length], [[], 1]);

console.log('location');
check('takes it from the location holding most',
  L.pickLocation([{ location: { id: 'A' }, quantities: [{ quantity: 1 }] }, { location: { id: 'B' }, quantities: [{ quantity: 6 }] }]), 'B');
check('no locations', L.pickLocation([]), null);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
