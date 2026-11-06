// Packet — Outlet ↔ Shopify checks (the parts with no network).
// Run: node test/shopify.test.js

var crypto = require('crypto');
var C = require('../netlify-functions/_shared/outlet-shopify-core.js');
var pass = 0, fail = 0;
function check(name, actual, expected) {
  var ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + '\n        expected ' + JSON.stringify(expected) + '\n        got      ' + JSON.stringify(actual)); }
}

var ID = '3f2a9c1e-5b6d-4e7f-8a9b-0c1d2e3f4a5b';

console.log('sku');
check('sku carries the item id', C.skuFor(ID), 'PKO-' + ID);
check('round trip', C.itemIdFromSku(C.skuFor(ID)), ID);
check('AW sku is not ours', C.itemIdFromSku('AW-BUNDLE-613'), null);
check('blank sku', C.itemIdFromSku(''), null);
check('prefix with junk', C.itemIdFromSku('PKO-notanid'), null);

console.log('pounds');
check('4500 -> "45.00"', C.pounds(4500), '45.00');
check('1999 -> "19.99"', C.pounds(1999), '19.99');

var item = {
  id: ID, brand_id: 'b1', title: 'Wrap dress, navy spot', description: 'Jersey.\n\nTrue to size.',
  category: 'clothing', size: '12', colour: 'Navy', condition: 'returned_worn', condition_note: 'Tried on once',
  quantity: 2, sale_minor: 4500, floor_minor: 4000, status: 'live',
  photos: ['https://x.supabase.co/a.jpg', 'http://insecure/b.jpg', 'https://shop/c.jpg'],
  updated_at: '2026-11-02T10:00:00Z'
};

console.log('product');
var p = C.productInput(item, 'Hot Squash', 'gid://shopify/Location/1');
check('title', p.title, 'Wrap dress, navy spot');
check('vendor is the brand', p.vendor, 'Hot Squash');
check('tagged outlet', p.tags.indexOf('outlet') > -1, true);
check('showing', p.status, 'ACTIVE');
check('size is the option', p.productOptions[0].name + '=' + p.productOptions[0].values[0].name, 'Size=12');
check('price', p.variants[0].price, '45.00');
check('sku', p.variants[0].inventoryItem.sku, 'PKO-' + ID);
check('never oversell on purpose', p.variants[0].inventoryPolicy, 'DENY');
check('quantity', p.variants[0].inventoryQuantities[0].quantity, 2);
check('only https photos', p.files.length, 2);
check('condition shown', /Returned, tried on or worn/.test(p.descriptionHtml), true);
check('fault shown', /Tried on once/.test(p.descriptionHtml), true);
check('html escaped', /<script>/.test(C.productInput(Object.assign({}, item, { description: '<script>x</script>' }), 'B', 'L').descriptionHtml), false);
check('no size -> default option', C.productInput(Object.assign({}, item, { size: null }), 'B', 'L').productOptions[0].name, 'Title');

console.log('shop status');
check('live with stock shows', C.shopStatus(item), 'ACTIVE');
check('sold out hides', C.shopStatus(Object.assign({}, item, { quantity: 0 })), 'DRAFT');
check('paused hides', C.shopStatus(Object.assign({}, item, { status: 'paused' })), 'DRAFT');
check('withdrawn hides', C.shopStatus(Object.assign({}, item, { status: 'withdrawn' })), 'DRAFT');

console.log('needs sync');
check('live, never sent', C.needsSync(item), true);
check('draft, never sent: nothing to do', C.needsSync(Object.assign({}, item, { status: 'draft' })), false);
check('in shop, up to date', C.needsSync(Object.assign({}, item, { shopify_product_id: 'P', shopify_synced_at: item.updated_at })), false);
check('in shop, changed since', C.needsSync(Object.assign({}, item, { shopify_product_id: 'P', shopify_synced_at: '2026-11-02T09:00:00Z' })), true);
check('withdrawn after listing must come down', C.needsSync(Object.assign({}, item, { status: 'withdrawn', shopify_product_id: 'P', shopify_synced_at: '2026-11-01T00:00:00Z' })), true);

console.log('signature');
var body = '{"id":1}', secret = 's3cret';
var good = crypto.createHmac('sha256', secret).update(body, 'utf8').digest('base64');
check('good signature', C.verifyHmac(body, good, secret), true);
check('wrong secret', C.verifyHmac(body, good, 'other'), false);
check('tampered body', C.verifyHmac('{"id":2}', good, secret), false);
check('no header', C.verifyHmac(body, undefined, secret), false);

console.log('order rows');
// Worked by hand: £45.00 x 2 = £90.00, less a £9.00 discount = £81.00,
// so £40.50 each = 4050p.
var order = {
  id: 555, name: '#1007', test: false,
  shipping_address: { first_name: 'Ann', last_name: 'Lee', address1: '1 High St', address2: '', city: 'Leeds', province: 'West Yorkshire', zip: 'LS1 1AA', country_code: 'GB', phone: '07700 900000' },
  line_items: [
    { id: 9001, sku: 'PKO-' + ID, title: 'Wrap dress, navy spot', quantity: 2, price: '45.00', discount_allocations: [{ amount: '9.00' }] },
    { id: 9002, sku: 'AW-613', title: 'Tree of Life set', quantity: 1, price: '42.99' }
  ]
};
var byId = {}; byId[ID] = { id: ID, brand_id: 'b1', title: 'Wrap dress, navy spot' };
var out = C.orderRows(order, byId);
check('only the Outlet line', out.rows.length, 1);
check('order number', out.rows[0].order_ref, '#1007');
check('each, after discount', out.rows[0].sale_minor, 4050);
check('quantity', out.rows[0].quantity, 2);
check('brand', out.rows[0].brand_id, 'b1');
check('name', out.rows[0].customer_name, 'Ann Lee');
check('postcode', out.rows[0].ship_postcode, 'LS1 1AA');
check('line id kept for repeats', out.rows[0].shopify_line_item_id, '9001');
check('no problems', out.problems.length, 0);
check('unknown item is reported, not guessed', C.orderRows(order, {}).problems.length, 1);
check('no address is reported', C.orderRows(Object.assign({}, order, { shipping_address: null }), byId).problems.length, 1);
check('Shopify test order is a test', C.orderRows(Object.assign({}, order, { test: true }), byId).rows[0].is_test, true);


console.log('sizes of one thing become one product');
var base = { brand_id: 'b1', title: 'Linen wrap dress', colour: 'Sage', condition: 'returned_as_new', condition_note: null, status: 'live', quantity: 2, sale_minor: 7600 };
var d10 = Object.assign({ id: 'i10', size: '10' }, base), d12 = Object.assign({ id: 'i12', size: '12' }, base);
check('same brand, title, colour, condition: same group', C.groupKey(d10) === C.groupKey(d12) && !!C.groupKey(d10), true);
check('case and spaces do not matter', C.groupKey(Object.assign({}, d12, { title: ' linen  WRAP dress ', colour: 'sage' })), C.groupKey(d10));
check('another colour is another product', C.groupKey(Object.assign({}, d12, { colour: 'Navy' })) === C.groupKey(d10), false);
check('another brand is another product', C.groupKey(Object.assign({}, d12, { brand_id: 'b2' })) === C.groupKey(d10), false);
check('another condition is another product', C.groupKey(Object.assign({}, d12, { condition: 'new_with_tags' })) === C.groupKey(d10), false);
check('no size: on its own', C.groupKey(Object.assign({}, d10, { size: '' })), null);
check('worn: on its own', C.groupKey(Object.assign({}, d10, { condition: 'returned_worn', condition_note: 'Tried on' })), null);
check('faulty: on its own', C.groupKey(Object.assign({}, d10, { condition: 'minor_fault', condition_note: 'Pull' })), null);
check('a note of its own: on its own', C.groupKey(Object.assign({}, d10, { condition_note: 'Missing belt' })), null);

var inShop = [Object.assign({}, d10, { shopify_product_id: 'gid://shopify/Product/1' })];
check('size 12 joins the size 10 product', C.productToJoin(d12, inShop), 'gid://shopify/Product/1');
check('nothing in the shop yet: its own product', C.productToJoin(d12, []), null);
check('a second size 10 never doubles a size', C.productToJoin(Object.assign({}, d10, { id: 'i10b' }), inShop), null);
check('not grouped: never joins', C.productToJoin(Object.assign({}, d12, { condition_note: 'Missing belt' }), inShop), null);
check('ignores itself', C.productToJoin(inShop[0], inShop), null);

var v = C.sizeVariantInput(d12, 'gid://shopify/Location/1');
check('new size: option', v.optionValues[0].optionName + '=' + v.optionValues[0].name, 'Size=12');
check('new size: price', v.price, '76.00');
check('new size: sku is the item', v.inventoryItem.sku, 'PKO-i12');
check('new size: stock', v.inventoryQuantities[0].availableQuantity, 2);
check('new size: never oversell', v.inventoryPolicy, 'DENY');

check('product shows while any size is on sale', C.groupStatus([Object.assign({}, d10, { quantity: 0 }), d12]), 'ACTIVE');
check('product hides when every size is gone', C.groupStatus([Object.assign({}, d10, { quantity: 0 }), Object.assign({}, d12, { status: 'withdrawn' })]), 'DRAFT');
check('a taken-back size cannot be bought', C.shopQuantity(Object.assign({}, d12, { status: 'withdrawn' })), 0);
check('a paused size cannot be bought', C.shopQuantity(Object.assign({}, d12, { status: 'paused' })), 0);
check('a live size sells what is left', C.shopQuantity(d12), 2);
check('size is the picker, not repeated in the wording', /Size:/.test(C.productInput(Object.assign({ id: ID, photos: [] }, d10), 'B', 'L').descriptionHtml), false);
check('colour still in the wording', /Colour: Sage/.test(C.productInput(Object.assign({ id: ID, photos: [] }, d10), 'B', 'L').descriptionHtml), true);

console.log('the brand sees which size sold');
var sized = { id: 556, name: '#1008', shipping_address: order.shipping_address,
  line_items: [{ id: 9003, sku: 'PKO-' + ID, title: 'Wrap dress, navy spot', variant_title: '12', quantity: 1, price: '45.00' }] };
check('size in the order line', C.orderRows(sized, byId).rows[0].item_title, 'Wrap dress, navy spot (12)');
check('no size: plain title', C.orderRows(order, byId).rows[0].item_title, 'Wrap dress, navy spot');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
