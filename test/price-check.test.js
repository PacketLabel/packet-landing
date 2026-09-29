// Packet — price screen checks.
// Run: node test/price-check.test.js
//
// Every expected figure below was worked out by hand from the real
// numbers in Supplier 008 and then checked against the code, not the
// other way round.

var P = require('../netlify-functions/price-check.js')._internal;

var pass = 0, fail = 0;

function check(name, actual, expected) {
  var ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else    { fail++; console.log('  FAIL  ' + name + '\n        expected ' + JSON.stringify(expected) + '\n        got      ' + JSON.stringify(actual)); }
}

console.log('\nlowestVariantPence');

check('takes the cheapest variant',
  P.lowestVariantPence({ variants: [{ price: '12.99' }, { price: '7.99' }, { price: '19.50' }] }),
  799);

check('one variant',
  P.lowestVariantPence({ variants: [{ price: '32.99' }] }),
  3299);

check('ignores zero-priced variants — Shopify for "not for sale"',
  P.lowestVariantPence({ variants: [{ price: '0.00' }, { price: '9.99' }] }),
  999);

check('all zero is nothing usable',
  P.lowestVariantPence({ variants: [{ price: '0' }] }),
  null);

check('no variants',   P.lowestVariantPence({ variants: [] }), null);
check('no product',    P.lowestVariantPence(null), null);
check('junk price',    P.lowestVariantPence({ variants: [{ price: 'ask us' }] }), null);
check('rounds to the nearest penny',
  P.lowestVariantPence({ variants: [{ price: '7.995' }] }), 800);

console.log('\ngrossFrom — the three real cases from Supplier 008');

// Prowise Irish Sea Moss: $20.91 at 0.7404 = 1548p. Brand's own shop 799p.
check('Irish Sea Moss is a loss',
  P.grossFrom(799, 1548), { pence: -749, pct: -93.74 });

// Tate & Lyle sugar sticks: $12.54 = 928p. Cheapest UK shop 767p.
check('sugar sticks are a loss',
  P.grossFrom(767, 928), { pence: -161, pct: -20.99 });

// Kono BPK2501 backpack: $20.56 = 1522p. Luggage eStore 3299p.
check('the Kono backpack clears',
  P.grossFrom(3299, 1522), { pence: 1777, pct: 53.86 });  // 1777/3299 = 53.8648%

console.log('\ngrossFrom — edges');

check('no UK price found',   P.grossFrom(null, 1522), { pence: null, pct: null });
check('no cost recorded',    P.grossFrom(3299, null), { pence: null, pct: null });
check('free is not a percentage', P.grossFrom(0, 100), { pence: -100, pct: null });
check('exactly break-even',  P.grossFrom(1000, 1000), { pence: 0, pct: 0 });

console.log('\nfirstJson');

check('plain object', P.firstJson('{"found":true}'), { found: true });
check('object wrapped in chatter',
  P.firstJson('Here you go:\n{"found":false,"note":"nothing"}\nHope that helps.'),
  { found: false, note: 'nothing' });
check('no json at all', P.firstJson('I could not find it.'), null);
check('broken json',    P.firstJson('{"found": tru'), null);
check('empty',          P.firstJson(''), null);

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
