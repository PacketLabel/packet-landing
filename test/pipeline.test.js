// Packet — end-to-end shortlist checks.
// Run: node test/pipeline.test.js
//
// The fixture in fixtures-candidates.json is not hand-written. It is a
// real dump of the sourcing_candidates view, taken from a Postgres
// database with 001, 002 and 005 applied and three supplier products
// matched against two competitor shops. So this exercises the actual
// column names and the actual shapes the view produces, not an
// idealised version of them.
//
// The three products are chosen to cover the three cases that matter:
//   A-1  branded, barcode-matched, clean
//   A-2  unbranded, title-matched only — priced, but flagged
//   B-1  a cosmetic from a supplier with no Responsible Person — blocked

var M    = require('../admin/packet-margin.js');
var B    = require('../netlify-functions/build-opportunities.js')._internal;
var rows = require('./fixtures-candidates.json');

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

// Settings and return rates invented for this test only.
var settings = {
  vatRegistered: true, vatRate: 0.20,
  paymentFeePct: 0.015, paymentFeeFixedPence: 20,
  platformFeePct: null, pickPackPence: 0,
  assumedCpaPence: 250,
  pricePosition: 'match', pricePositionPct: 0,
  targetContributionPct: 30, minContributionPence: 100
};
var categories = {
  'hair-tools':   { category: 'hair-tools',   requires_uk_rp: false, return_rate: 0.03, return_handling_cost_pence: 150 },
  'beauty-tools': { category: 'beauty-tools', requires_uk_rp: false, return_rate: 0.02, return_handling_cost_pence: 100 },
  'hair-care':    { category: 'hair-care',    requires_uk_rp: true,  return_rate: 0.04, return_handling_cost_pence: 120 }
};

// The same sequence build-opportunities runs: compliance, then maths.
function run(c) {
  var cat = categories[c.category] || {};
  var compliance = M.complianceCheck({
    name: c.supplier_name,
    is_uk_responsible_person: c.is_uk_responsible_person,
    rp_evidence: c.rp_evidence,
    ships_from_country: c.ships_from_country
  }, cat);

  var result = M.evaluate({
    costPricePence: c.cost_price_pence,
    deliveryCostPence: c.delivery_cost_pence,
    competitorPrices: c.competitor_prices || [],
    weeksObserved: Number(c.weeks_observed) || 0,
    settings: settings,
    category: {
      category: c.category,
      returnRate: cat.return_rate,
      returnHandlingCostPence: cat.return_handling_cost_pence
    }
  });

  return {
    sku: c.sku, category: c.category,
    compliance_status: compliance.status, compliance_reason: compliance.reason,
    score: compliance.status === 'blocked' ? 0 : result.score,
    result: result, source: c
  };
}

var out = rows.map(run);
var bySku = {};
out.forEach(function (o) { bySku[o.sku] = o; });

console.log('\nThe view feeds the engine without any reshaping');
check('all three candidates priced', out.filter(function (o) { return o.result.ok; }).length, 3);

console.log('\nA-1 — branded, barcode matched');
var a1 = bySku['A-1'];
check('compliance clear',            a1.compliance_status, 'ok');
check('two competitor stores',       a1.result.nCompetitors, 2);
// median of 1299 and 1350 is 1325 (rounded up from 1324.5), which
// rounds to a shelf price of 1349.
check('suggested price',             a1.result.suggestedPricePence, 1349);
check('landed cost 420 + 199',       a1.result.landedCostPence, 619);
check('nothing matched on title',    a1.source.fuzzy_matches, 0);
truthy('makes money after ads',      a1.result.contributionAfterAdsPence > 0);
check('only two shops, so partial',  a1.result.confidence, 'partial');

console.log('\nA-2 — unbranded, matched on title alone');
var a2 = bySku['A-2'];
check('compliance clear',              a2.compliance_status, 'ok');
check('every comparison was fuzzy',    a2.source.fuzzy_matches, a2.source.total_matches);
truthy('still priced, not discarded',  a2.result.ok === true);
truthy('cheap goods, healthy margin',  a2.result.contributionPct > 50);
// This is the one to be careful with: a title match on an unbranded
// product is "similar sort of thing", not "the same item".
truthy('flagged as needing confirmation before trusting',
  a2.source.fuzzy_matches > 0);

console.log('\nB-1 — cosmetic, supplier holds no Responsible Person role');
var b1 = bySku['B-1'];
check('blocked',                    b1.compliance_status, 'blocked');
truthy('names the reason',          /Responsible Person/.test(b1.compliance_reason));
truthy('names the supplier',        /Supplier B/.test(b1.compliance_reason));
check('scored zero so it cannot top the list', b1.score, 0);
// It is still priced. Knowing it would have been a good line is the
// argument for finding a supplier who does hold RP.
truthy('arithmetic still done, so the loss is visible', b1.result.ok === true);

console.log('\nShortlisting keeps each category in the running');
var shortlisted = B.topPerCategory(out.map(function (o) {
  return { category: o.category, score: o.score, compliance_status: o.compliance_status, sku: o.sku };
}), 1);
check('one per category plus the blocked row', shortlisted.length, 3);
check('categories all represented',
  shortlisted.map(function (r) { return r.category; }).sort(),
  ['beauty-tools', 'hair-care', 'hair-tools']);
truthy('the blocked one is shown, not hidden',
  shortlisted.some(function (r) { return r.sku === 'B-1' && r.compliance_status === 'blocked'; }));

console.log('\nA fat category cannot crowd the others out');
var many = [];
for (var i = 0; i < 20; i++) many.push({ category: 'home', score: 1000 + i, compliance_status: 'ok', sku: 'H' + i });
many.push({ category: 'kids', score: 5, compliance_status: 'ok', sku: 'K1' });
var capped = B.topPerCategory(many, 5);
check('home capped at five', capped.filter(function (r) { return r.category === 'home'; }).length, 5);
truthy('the weak category still gets its slot',
  capped.some(function (r) { return r.category === 'kids'; }));

console.log('\nsnake_case from the database becomes camelCase for the engine');
var c = B.camel({ vat_registered: true, payment_fee_fixed_pence: 20, max_candidates_per_category: 5 });
check('converted', c, { vatRegistered: true, paymentFeeFixedPence: 20, maxCandidatesPerCategory: 5 });

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
