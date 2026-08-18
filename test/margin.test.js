// Packet — margin engine checks.
// Run: node test/margin.test.js
//
// Every expected figure below was worked out by hand first and then
// checked against the code, not the other way round. A test written
// by running the code and pasting the answer proves nothing.

var M = require('../admin/packet-margin.js');

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

// Settings representing a VAT-registered shop. These are TEST values,
// invented for the arithmetic only. Nothing here is a claim about what
// any real payment provider charges.
var vatSettings = {
  vatRegistered: true,
  vatRate: 0.20,
  paymentFeePct: 0.015,
  paymentFeeFixedPence: 20,
  platformFeePct: null,
  pickPackPence: 0,
  assumedCpaPence: 250,
  pricePosition: 'match',
  pricePositionPct: 0,
  targetContributionPct: 30,
  minContributionPence: 100
};

var cat = { category: 'beauty-tools', returnRate: 0.05, returnHandlingCostPence: 150, requires_uk_rp: false };

console.log('\nRetail rounding');
check('847 rounds to 849',   M.roundToRetail(847),  849);
check('1120 rounds to 1099', M.roundToRetail(1120), 1099);
check('320 rounds to 299',   M.roundToRetail(320),  299);

console.log('\nMedian');
check('odd count',  M.median([999, 1099, 1250]), 1099);
check('even count', M.median([100, 200, 300, 400]), 250);
check('empty',      M.median([]), null);

console.log('\nVAT registered — worked by hand');
// goods 320, delivery 199, landed 519
// price = median 1099, fees = floor-ish(1099*0.015)=16 + 20 = 36
// net revenue = 1099/1.2 = 916, contribution = 916*0.95 - 519 - 36 - 7.5 = 308
var a = M.evaluate({
  costPricePence: 320,
  deliveryCostPence: 199,
  competitorPrices: [999, 1099, 1250],
  weeksObserved: 8,
  settings: vatSettings,
  category: cat
});
check('is priceable',        a.ok, true);
check('landed cost',         a.landedCostPence, 519);
check('suggested price',     a.suggestedPricePence, 1099);
check('fees',                a.feesPence, 36);
check('net revenue ex VAT',  a.netRevenuePence, 916);
check('VAT due',             a.vatDuePence, 183);
check('contribution',        a.contributionPence, 308);
check('contribution pct',    a.contributionPct, 33.62);
check('after advertising',   a.contributionAfterAdsPence, 58);
check('demand signal',       a.demandSignal, 5);
check('score',               a.score, 290);
check('confidence',          a.confidence, 'good');

console.log('\nNot VAT registered — the same product');
// Cannot reclaim VAT on the trade price, but owes none on the sale.
// goods 384, delivery 239, landed 623. Revenue is the full 1099.
var notVat = Object.assign({}, vatSettings, { vatRegistered: false, vatRate: 0.20 });
var b = M.evaluate({
  costPricePence: 320,
  deliveryCostPence: 199,
  competitorPrices: [999, 1099, 1250],
  weeksObserved: 8,
  settings: notVat,
  category: cat
});
check('landed cost includes irrecoverable VAT', b.landedCostPence, 623);
check('keeps the whole ticket price',           b.netRevenuePence, 1099);
check('contribution',                           b.contributionPence, 378);
truthy('better off outside VAT at this price',  b.contributionPence > a.contributionPence);

console.log('\nThe engine refuses rather than guesses');
var c = M.evaluate({
  costPricePence: 320,
  competitorPrices: [999],
  settings: { vatRegistered: null, paymentFeePct: null, paymentFeeFixedPence: null },
  category: cat
});
check('will not price without settings', c.ok, false);
truthy('names what is missing', /VAT registered/.test(c.reasons[0]) && /Payment provider/.test(c.reasons[0]));

var d = M.evaluate({
  costPricePence: 320, competitorPrices: [], settings: vatSettings, category: cat
});
check('will not price with no competitors', d.ok, false);
truthy('says why', /nothing to anchor/.test(d.reasons[0]));

console.log('\nUnknown inputs downgrade confidence, they do not get invented');
var noRate = M.evaluate({
  costPricePence: 320, deliveryCostPence: 199,
  competitorPrices: [999, 1099, 1250], weeksObserved: 8,
  settings: Object.assign({}, vatSettings, { assumedCpaPence: null }),
  category: { category: 'beauty-tools', returnRate: null, returnHandlingCostPence: null }
});
check('no ad cost means no after-ads figure', noRate.contributionAfterAdsPence, null);
check('confidence drops to unproven',         noRate.confidence, 'unproven');
truthy('warns returns were excluded',  noRate.confidenceNotes.join(' ').indexOf('return rate') > -1);
truthy('warns ads were excluded',      noRate.confidenceNotes.join(' ').indexOf('advertising') > -1);

var thin = M.evaluate({
  costPricePence: 320, deliveryCostPence: 199,
  competitorPrices: [1099], weeksObserved: 2,
  settings: vatSettings, category: cat
});
check('one competitor is only partial confidence', thin.confidence, 'partial');
truthy('says a median of one is not a market', thin.confidenceNotes.join(' ').indexOf('not a market price') > -1);

console.log('\nThe bar');
var poor = M.evaluate({
  costPricePence: 700, deliveryCostPence: 199,
  competitorPrices: [999, 1099, 1250], weeksObserved: 8,
  settings: vatSettings, category: cat
});
check('a thin one fails the minimum', poor.meetsMinimum, false);
check('and fails the target pct',     poor.meetsTarget, false);

console.log('\nCompliance gate');
var noRp = M.complianceCheck(
  { name: 'Test Supplier', is_uk_responsible_person: false, ships_from_country: 'GB' },
  { category: 'beauty-cosmetics', requires_uk_rp: true });
check('cosmetic with no RP is blocked', noRp.status, 'blocked');
truthy('and explains why', /Responsible Person/.test(noRp.reason));

var rpNoEvidence = M.complianceCheck(
  { name: 'Test Supplier', is_uk_responsible_person: true, rp_evidence: null, ships_from_country: 'GB' },
  { category: 'beauty-cosmetics', requires_uk_rp: true });
check('RP claimed but unevidenced needs checking', rpNoEvidence.status, 'needs_check');

var fine = M.complianceCheck(
  { name: 'Test Supplier', is_uk_responsible_person: true, rp_evidence: 'Emailed confirmation 12 Aug 2026', ships_from_country: 'GB' },
  { category: 'beauty-cosmetics', requires_uk_rp: true });
check('RP with evidence passes', fine.status, 'ok');

var overseas = M.complianceCheck(
  { name: 'Test Supplier', is_uk_responsible_person: false, ships_from_country: 'CN' },
  { category: 'beauty-tools', requires_uk_rp: false });
check('shipping from outside the UK needs checking', overseas.status, 'needs_check');

var kids = M.complianceCheck(
  { name: 'Test Supplier', ships_from_country: 'GB' },
  { category: 'kids', requires_uk_rp: false });
check('kids never passes automatically', kids.status, 'needs_check');

var uncategorised = M.complianceCheck({ name: 'Test Supplier' }, {});
check('no category means no rule could be applied', uncategorised.status, 'needs_check');

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
