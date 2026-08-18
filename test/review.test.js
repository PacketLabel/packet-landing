// Packet — competitor review checks.
// Run: node test/review.test.js
//
// The point of these is that every number in a review is counted,
// not written by an AI. So the counting has to be right, and the
// policy-page reading has to refuse rather than guess — a wrong
// delivery charge on an internal report is worse than "unknown",
// because somebody will act on it.

var R = require('../netlify-functions/review-competitors.js')._internal;

var pass = 0, fail = 0;
function check(name, actual, expected) {
  var ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else    { fail++; console.log('  FAIL  ' + name + '\n        expected ' + JSON.stringify(expected) + '\n        got      ' + JSON.stringify(actual)); }
}
function truthy(name, v) {
  if (v) { pass++; console.log('  PASS  ' + name); }
  else   { fail++; console.log('  FAIL  ' + name); }
}

var DAY = 86400000;
var ago = d => new Date(Date.now() - d * DAY).toISOString();

console.log('\nCounting the range');
var products = [
  { price_pence: 499,  compare_at_pence: null, available: true,  product_type: 'Brushes',  first_seen_at: ago(60), last_seen_at: ago(0) },
  { price_pence: 899,  compare_at_pence: 1199, available: true,  product_type: 'Brushes',  first_seen_at: ago(10), last_seen_at: ago(0) },
  { price_pence: 1250, compare_at_pence: null, available: false, product_type: 'Tweezers', first_seen_at: ago(5),  last_seen_at: ago(0) },
  { price_pence: 2400, compare_at_pence: 3000, available: true,  product_type: 'Tweezers', first_seen_at: ago(90), last_seen_at: ago(0) },
  { price_pence: 6000, compare_at_pence: null, available: true,  product_type: 'Gift sets', first_seen_at: ago(200), last_seen_at: ago(30) }
];
var f = R.computeFacts(products);

check('counts everything',            f.columns.product_count, 5);
check('new in the last 30 days',      f.columns.new_products_30d, 2);
check('out of stock',                 f.columns.out_of_stock_count, 1);
check('out of stock as a percentage', f.outOfStockRate, 20);
check('cheapest',                     f.columns.price_min_pence, 499);
check('middle',                       f.columns.price_median_pence, 1250);
check('dearest',                      f.columns.price_max_pence, 6000);
// Not seen for 30 days while the rest were seen today: dropped.
check('spots a delisted product',     f.columns.gone_products_30d, 1);

console.log('\nDiscounts only count when there is a real "was" price');
check('two on discount', f.columns.discounted_count, 2);
// 899 off 1199 is 25.02%; 2400 off 3000 is 20%. Middle of two is the mean.
check('typical discount', f.columns.median_discount_pct, 22.51);

var noFakes = R.computeFacts([
  { price_pence: 1000, compare_at_pence: 1000, available: true },  // same price, not a discount
  { price_pence: 1000, compare_at_pence: 800,  available: true }   // "was" lower, nonsense
]);
check('ignores was-prices that are not discounts', noFakes.columns.discounted_count, 0);
check('and reports no typical discount',           noFakes.columns.median_discount_pct, null);

console.log('\nPrice bands');
check('under £5',   f.columns.price_bands['under £5'], 1);
check('£5–10',      f.columns.price_bands['£5–10'], 1);
check('£10–15',     f.columns.price_bands['£10–15'], 1);
check('£20–30',     f.columns.price_bands['£20–30'], 1);
check('over £50',   f.columns.price_bands['over £50'], 1);
check('£15–20 is empty', f.columns.price_bands['£15–20'], 0);

console.log('\nAn empty shop does not crash or invent numbers');
var empty = R.computeFacts([]);
check('no products',   empty.columns.product_count, 0);
check('no middle price', empty.columns.price_median_pence, null);
check('no stock rate',  empty.outOfStockRate, null);

console.log('\nStripping a page down to its words');
check('drops tags and scripts',
  R.stripHtml('<div><script>var x=1;</script><p>Free delivery over &pound;30</p></div>'),
  'Free delivery over £30');
check('drops styles too',
  R.stripHtml('<style>p{color:red}</style><p>Hello  there</p>'), 'Hello there');

console.log('\nReading a free-delivery threshold');
check('over £30',      R.findFreeDeliveryThreshold('We offer free UK delivery on orders over £30.'), 3000);
check('spend £25',     R.findFreeDeliveryThreshold('Spend over £25 and delivery is free.'), 2500);
check('£40 or more',   R.findFreeDeliveryThreshold('Orders of £40 or more qualify for free shipping.'), 4000);
check('with pence',    R.findFreeDeliveryThreshold('Free delivery when you spend £29.99'), 2999);
check('nothing to find', R.findFreeDeliveryThreshold('We deliver everywhere in the UK.'), null);
// Guarding against a nearby figure being mistaken for the policy.
check('refuses a daft threshold',
  R.findFreeDeliveryThreshold('Free delivery on orders over £50000'), null);

console.log('\nReading a delivery charge');
check('standard delivery', R.findDeliveryCost('Standard UK delivery is £3.95 and takes 2-4 days.'), 395);
check('costs phrasing',    R.findDeliveryCost('Delivery costs £2.99 per order.'), 299);
check('refuses whole pounds without pence',
  R.findDeliveryCost('Delivery £4'), null);   // too easy to be a different number
check('nothing to find',   R.findDeliveryCost('We ship from our UK warehouse.'), null);

console.log('\nReading a returns window');
check('30 days',        R.findReturnsWindow('You have 30 days to return any item.'), 30);
check('within phrasing',R.findReturnsWindow('Returns accepted within 14 days of delivery.'), 14);
check('changed mind',   R.findReturnsWindow('If you have changed your mind you have 28 days.'), null);
check('refuses nonsense', R.findReturnsWindow('Returns within 5000 days'), null);
// Under 14 days would be unlawful for UK distance selling, so a
// match that low is far more likely to be a misread.
check('refuses an unlawfully short window', R.findReturnsWindow('Return within 3 days'), null);
check('nothing to find', R.findReturnsWindow('We hope you love your order.'), null);

console.log('\nFinding the gap nobody occupies');
var profiles = [
  { competitor: { name: 'Rival One' },
    facts: { priceBands: { 'under £5': 5, '£5–10': 20, '£10–15': 12, '£15–20': 0, '£20–30': 3, '£30–50': 0, 'over £50': 0 },
             categories: { Brushes: 10, Tweezers: 5 },
             columns: { product_count: 40, price_median_pence: 899, new_products_30d: 4 }, outOfStockRate: 5 },
    terms: { deliveryCostPence: 395, deliveryFreeOverPence: 3000, returnsDays: 30, pagesRead: ['/policies/shipping-policy'] } },
  { competitor: { name: 'Rival Two' },
    facts: { priceBands: { 'under £5': 2, '£5–10': 15, '£10–15': 8, '£15–20': 0, '£20–30': 1, '£30–50': 0, 'over £50': 0 },
             categories: { Brushes: 8, 'Gift sets': 3 },
             columns: { product_count: 26, price_median_pence: 950, new_products_30d: 1 }, outOfStockRate: 12 },
    terms: { deliveryCostPence: 349, deliveryFreeOverPence: null, returnsDays: 14, pagesRead: ['/policies/refund-policy'] } }
];
var market = R.combine(profiles);

check('empty bands found', market.emptyBands, ['£15–20', '£30–50', 'over £50']);
check('a category only one of them covers', market.categoryCoverage['Tweezers'], ['Rival One']);
check('a category they both cover',        market.categoryCoverage['Brushes'], ['Rival One', 'Rival Two']);
check('delivery gathered per shop',        market.delivery.length, 2);
truthy('an unknown free-delivery level stays unknown',
  market.delivery[1].free_over_pence === null && market.delivery[1].known === true);
check('both shops summarised',             market.competitors.length, 2);

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
