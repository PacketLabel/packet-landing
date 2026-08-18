// Packet — competitor feed parsing checks.
// Run: node test/scanner.test.js
//
// Uses a hand-written sample shaped like a real Shopify products.json
// response, including the awkward cases: a sold-out product, a product
// where the cheapest variant is not the first one, tags arriving as a
// string rather than an array, and a price that is not parseable.

var S = require('../netlify-functions/scan-competitors.js')._internal;

var pass = 0, fail = 0;
function check(name, actual, expected) {
  var ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else    { fail++; console.log('  FAIL  ' + name + '\n        expected ' + JSON.stringify(expected) + '\n        got      ' + JSON.stringify(actual)); }
}

console.log('\nPrices are parsed as strings, never as floats');
check('"12.99"',  S.toPence('12.99'), 1299);
check('"7.00"',   S.toPence('7.00'),  700);
check('"7"',      S.toPence('7'),     700);
check('"7.5"',    S.toPence('7.5'),   750);
check('"0.99"',   S.toPence('0.99'),  99);
check('null',     S.toPence(null),    null);
check('rubbish',  S.toPence('POA'),   null);
check('negative is not a price', S.toPence('-3.00'), null);
// The classic: 8.7 * 100 is 870.0000000000001 in floating point.
check('no floating point drift', S.toPence('8.70'), 870);

console.log('\nProducts are reduced to one row, priced on the cheapest buyable variant');
var base = 'https://example-shop.com';

var multi = S.normalise({
  id: 111, title: 'Detangling Brush', handle: 'detangling-brush',
  vendor: 'Denman', product_type: 'Hair', tags: ['brush', 'hair'],
  images: [{ src: 'https://cdn/img1.jpg' }],
  variants: [
    { id: 1, sku: 'DB-LARGE', price: '14.99', compare_at_price: '19.99', available: true },
    { id: 2, sku: 'DB-SMALL', price: '9.99',  compare_at_price: null,    available: true }
  ]
}, base);
check('takes the cheaper variant',  multi.price_pence, 999);
check('and that variant\'s SKU',    multi.sku, 'DB-SMALL');
check('brand from vendor',          multi.brand, 'Denman');
check('builds the product URL',     multi.product_url, 'https://example-shop.com/products/detangling-brush');
check('marked available',           multi.available, true);
check('external id is a string',    multi.external_id, '111');

console.log('\nSold out is recorded, not skipped');
// It still tells us what they charge, and going out of stock is itself
// the demand signal worth having.
var soldOut = S.normalise({
  id: 222, title: 'Sold Out Thing', handle: 'sold-out-thing', vendor: 'X',
  variants: [{ id: 3, sku: 'SO-1', price: '5.50', available: false }]
}, base);
check('available is false',          soldOut.available, false);
check('price still captured',        soldOut.price_pence, 550);

console.log('\nA cheap sold-out variant does not undercut the real price');
var mixed = S.normalise({
  id: 333, title: 'Mixed', handle: 'mixed', vendor: 'Y',
  variants: [
    { id: 4, sku: 'CHEAP-GONE', price: '1.00',  available: false },
    { id: 5, sku: 'IN-STOCK',   price: '12.00', available: true }
  ]
}, base);
check('prices on what can be bought', mixed.price_pence, 1200);
check('and its SKU',                  mixed.sku, 'IN-STOCK');

console.log('\nAwkward shapes do not throw');
var tagsAsString = S.normalise({
  id: 444, title: 'Tags As String', handle: 't', vendor: 'Z',
  tags: 'one, two,three',
  variants: [{ id: 6, price: '3.00', available: true }]
}, base);
check('comma string becomes an array', tagsAsString.tags, ['one', 'two', 'three']);
check('missing SKU is null',           tagsAsString.sku, null);

var noPrice = S.normalise({
  id: 555, title: 'No Usable Price', handle: 'n', vendor: 'Z',
  variants: [{ id: 7, price: 'POA', available: true }]
}, base);
check('unparseable price is null, not zero', noPrice.price_pence, null);

var bare = S.normalise({ id: 666 }, base);
check('a nearly empty product still yields a row', bare.title, '(untitled)');
check('with no URL to invent',                     bare.product_url, null);

console.log('\nBarcodes: the public feed usually has none');
// This is why the matcher cannot lean on barcodes for competitor rows
// and has to fall back to brand, SKU and title similarity.
check('absent barcode is null', multi.gtin, null);
var withBarcode = S.normalise({
  id: 777, title: 'Has Barcode', handle: 'h', vendor: 'V',
  variants: [{ id: 8, sku: 'A', price: '4.00', available: true, barcode: '5021044000123' }]
}, base);
check('present barcode is kept', withBarcode.gtin, '5021044000123');

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
