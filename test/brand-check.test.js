// Packet — brand screen checks.
// Run: node test/brand-check.test.js
//
// Every expected figure below was worked out by hand first and then
// checked against the code, not the other way round.

var B = require('../netlify-functions/brand-check.js')._internal;

var pass = 0, fail = 0;

function check(name, actual, expected) {
  var ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else    { fail++; console.log('  FAIL  ' + name + '\n        expected ' + JSON.stringify(expected) + '\n        got      ' + JSON.stringify(actual)); }
}

console.log('\nnormaliseSite — what somebody will actually paste');

check('bare domain',            B.normaliseSite('examplebrand.co.uk'), 'https://examplebrand.co.uk');
check('with www and scheme',    B.normaliseSite('https://www.examplebrand.co.uk'), 'https://www.examplebrand.co.uk');
check('strips a product path',  B.normaliseSite('https://examplebrand.co.uk/products/silk-scarf?ref=ig'), 'https://examplebrand.co.uk');
check('keeps http if given',    B.normaliseSite('http://examplebrand.co.uk'), 'http://examplebrand.co.uk');
check('trims whitespace',       B.normaliseSite('  examplebrand.co.uk  '), 'https://examplebrand.co.uk');
check('a word is not a site',   B.normaliseSite('examplebrand'), null);
check('empty',                  B.normaliseSite(''), null);
check('null',                   B.normaliseSite(null), null);
check('refuses a non-web scheme', B.normaliseSite('javascript:alert(1)'), null);

console.log('\nlowestVariantMinor — the entry price of one product');

check('cheapest variant wins',
  B.lowestVariantMinor({ variants: [{ price: '45.00' }, { price: '28.50' }] }), 2850);
check('zero-priced variant ignored — Shopify for "not for sale"',
  B.lowestVariantMinor({ variants: [{ price: '0.00' }, { price: '19.99' }] }), 1999);
check('all zero is nothing usable',
  B.lowestVariantMinor({ variants: [{ price: '0' }] }), null);
check('no variants', B.lowestVariantMinor({ variants: [] }), null);
check('no product',  B.lowestVariantMinor(null), null);
check('rounds to the nearest penny',
  B.lowestVariantMinor({ variants: [{ price: '7.995' }] }), 800);

console.log('\nmedianOf');

check('odd length takes the middle',   B.medianOf([100, 200, 900]), 200);
check('even length averages the two',  B.medianOf([100, 200, 300, 900]), 250);
check('even length rounds',            B.medianOf([100, 101]), 101);
check('single value',                  B.medianOf([4500]), 4500);

console.log('\npriceBandMinor — the spread across a brand’s catalogue');

// The point of the median. One £900 piece must not make a £12 brand
// read as premium — that misreading is what sends the wrong email.
var skewed = {
  products: [
    { variants: [{ price: '10.00' }] },
    { variants: [{ price: '12.00' }] },
    { variants: [{ price: '14.00' }] },
    { variants: [{ price: '900.00' }] }
  ]
};
check('one outlier does not move the median',
  B.priceBandMinor(skewed.products), { n: 4, min: 1000, median: 1300, max: 90000 });

check('a genuinely higher-priced brand reads as one',
  B.priceBandMinor([
    { variants: [{ price: '38.00' }] },
    { variants: [{ price: '52.00' }] },
    { variants: [{ price: '45.00' }] }
  ]),
  { n: 3, min: 3800, median: 4500, max: 5200 });

check('products with no usable price are left out of the count',
  B.priceBandMinor([
    { variants: [{ price: '0.00' }] },
    { variants: [] },
    { variants: [{ price: '25.00' }] }
  ]),
  { n: 1, min: 2500, median: 2500, max: 2500 });

check('an empty catalogue reports nothing rather than zero',
  B.priceBandMinor([]), { n: 0, min: null, median: null, max: null });
check('no products at all', B.priceBandMinor(null), { n: 0, min: null, median: null, max: null });

console.log('\ninstagramFrom');

check('an ordinary profile link',
  B.instagramFrom('<a href="https://www.instagram.com/examplebrand/">Instagram</a>'), 'examplebrand');
check('no scheme',
  B.instagramFrom('<a href="instagram.com/example_brand">ig</a>'), 'example_brand');
check('skips a post link and takes the profile after it',
  B.instagramFrom('<a href="https://instagram.com/p/Cabc123/">post</a><a href="https://instagram.com/examplebrand">us</a>'),
  'examplebrand');
check('skips a share link',
  B.instagramFrom('<a href="https://www.instagram.com/share/xyz">share</a><a href="https://www.instagram.com/realbrand">us</a>'),
  'realbrand');
check('handles a trailing dot',
  B.instagramFrom('instagram.com/brand.'), 'brand');
check('a dot inside a handle is kept',
  B.instagramFrom('instagram.com/the.brand.co'), 'the.brand.co');
check('nothing there', B.instagramFrom('<p>no socials</p>'), null);
check('no html', B.instagramFrom(''), null);

console.log('\nlooksShopify — the fallback for shops with the feed switched off');

check('cdn asset',      B.looksShopify('<img src="https://cdn.shopify.com/s/files/1/x.png">'), true);
check('newer cdn path', B.looksShopify('<img src="/cdn/shop/files/logo.png">'), true);
check('theme object',   B.looksShopify('<script>Shopify.theme = {"id":123};</script>'), true);
check('wallet meta',    B.looksShopify('<meta name="shopify-digital-wallet" content="/123/wallets">'), true);
check('a WooCommerce shop is not Shopify',
  B.looksShopify('<link rel="stylesheet" href="/wp-content/plugins/woocommerce/style.css">'), false);
check('empty', B.looksShopify(''), false);

console.log('\ncurrencyFrom');

check('GBP',              B.currencyFrom({ currency: 'GBP' }), 'GBP');
check('lower case',       B.currencyFrom({ currency: 'gbp' }), 'GBP');
check('USD is recorded, not dropped', B.currencyFrom({ currency: 'USD' }), 'USD');
check('anything else is "other" — still a finding',
  B.currencyFrom({ currency: 'SEK' }), 'other');
check('missing',  B.currencyFrom({}), null);
check('rubbish',  B.currencyFrom({ currency: '£' }), null);
check('no cart',  B.currencyFrom(null), null);

console.log('\ncurrencyFromHtml — the shop\u2019s own currency, not the visitor\u2019s');

check('rate of exactly 1 means nothing was converted',
  B.currencyFromHtml('<script>Shopify.currency = {"active":"GBP","rate":"1.0"};</script>'),
  { code: 'GBP', basis: 'shop' });
check('rate 1 written as a bare 1',
  B.currencyFromHtml('Shopify.currency={"active":"GBP","rate":"1"}'),
  { code: 'GBP', basis: 'shop' });
check('a converted rate means we are seeing presentment, not the shop',
  B.currencyFromHtml('Shopify.currency = {"active":"USD","rate":"1.2673"};'),
  { code: 'USD', basis: 'presentment' });
check('a UK shop showing dollars to this machine is still only presentment',
  B.currencyFromHtml('Shopify.currency = {"active":"USD","rate":"1.27"};'),
  { code: 'USD', basis: 'presentment' });
check('unlisted currency still reported',
  B.currencyFromHtml('Shopify.currency = {"active":"SEK","rate":"1.0"};'),
  { code: 'other', basis: 'shop' });
check('not published by the theme', B.currencyFromHtml('<p>hello</p>'), null);
check('malformed', B.currencyFromHtml('Shopify.currency = {broken};'), null);
check('no html', B.currencyFromHtml(''), null);

console.log('\nverdictFor — narrow on purpose');

check('Shopify, GBP, and the shop\u2019s own currency is reachable',
  B.verdictFor('shopify', 'GBP', 'shop'), 'reachable');
check('Shopify trading in dollars fails the same-country rule',
  B.verdictFor('shopify', 'USD', 'shop'), 'wrong_currency');
check('Shopify in an unlisted currency also fails it',
  B.verdictFor('shopify', 'other', 'shop'), 'wrong_currency');

// The trap this file exists to guard. A Netlify machine in the wrong
// place is shown dollars by a Manchester shop. Calling that
// 'wrong_currency' would throw away a perfectly good brand.
check('a presentment currency never decides it — not against the brand',
  B.verdictFor('shopify', 'USD', 'presentment'), 'unknown');
check('and not in its favour either',
  B.verdictFor('shopify', 'GBP', 'presentment'), 'unknown');

check('not a Shopify shop, so Collective cannot reach them',
  B.verdictFor('not_shopify', null, null), 'not_reachable');
check('a site that did not answer says nothing either way',
  B.verdictFor('unreachable', null, null), 'unknown');
check('Shopify with no currency read stays unknown, not assumed GBP',
  B.verdictFor('shopify', null, null), 'unknown');

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
