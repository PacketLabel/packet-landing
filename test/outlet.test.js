// Packet — Outlet helper checks.
// Run: node test/outlet.test.js
//
// Expected figures worked out by hand first. 30% of £35.00 is
// £10.50, so the brand gets £24.50 = 2450p.

var O = require('../admin/packet-outlet.js');
var pass = 0, fail = 0;
function check(name, actual, expected) {
  var ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + '\n        expected ' + JSON.stringify(expected) + '\n        got      ' + JSON.stringify(actual)); }
}

console.log('money');
check('1250 -> £12.50', O.money(1250), '£12.50');
check('5 -> £0.05', O.money(5), '£0.05');
check('123456 -> £1,234.56', O.money(123456), '£1,234.56');
check('null stays blank', O.money(null), '');

console.log('toPence');
check('"12.50"', O.toPence('12.50'), 1250);
check('"£12"', O.toPence('£12'), 1200);
check('"12.5"', O.toPence('12.5'), 1250);
check('"1,250.00"', O.toPence('1,250.00'), 125000);
check('blank is null', O.toPence(''), null);
check('"12,50" refused, not guessed', isNaN(O.toPence('12,50')), true);
check('"abc" refused', isNaN(O.toPence('abc')), true);
check('"12.505" refused', isNaN(O.toPence('12.505')), true);

console.log('payout — must match outlet_orders_before() in 014');
check('£35 at 30%', O.payout(3500, 1, 30), 2450);
check('2 x £19.99 at 25%', O.payout(1999, 2, 25), 2999); // 3998 * .75 = 2998.5 -> 2999
check('no terms -> null', O.payout(3500, 1, null), null);
check('0% -> all of it', O.payout(3500, 1, 0), 3500);

console.log('parseCSV');
check('quotes and commas', O.parseCSV('a,b\n"x, y","he said ""hi"""\n'), [['a', 'b'], ['x, y', 'he said "hi"']]);
check('Windows line endings and BOM', O.parseCSV('﻿a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']]);
check('blank rows dropped', O.parseCSV('a\n\n,\n1\n'), [['a'], ['1']]);

console.log('rowsFromCSV');
var good = O.rowsFromCSV(O.csvTemplate());
check('template reads with no problems', good.problems, []);
check('template item', good.items[0] && [good.items[0].title, good.items[0].floor_minor, good.items[0].rrp_minor, good.items[0].condition, good.items[0].quantity],
  ['Recycled wool cardigan', 4500, 8900, 'returned_as_new', 1]);

var loose = O.rowsFromCSV('Name,Condition,Lowest price (£),RRP,Qty,Type\nBoots,Box damaged,30,80,2,shoes\n');
check('loose headings still found — box damaged needs a note', loose.problems, ['Row 2: says what is wrong with it in condition_note.']);

var fixed = O.rowsFromCSV('Name,Condition,Condition note,Lowest price (£),RRP,Qty,Type\nBoots,Box damaged,Box torn,30,80,2,shoes\n');
check('loose headings, fixed', [fixed.problems, fixed.items[0] && fixed.items[0].category, fixed.items[0] && fixed.items[0].floor_minor], [[], 'footwear', 3000]);

var bad = O.rowsFromCSV('title,condition,lowest_price,normal_price\nA,new,50,40\nB,mint,x,\n');
check('every problem listed, nothing saved', [bad.items.length, bad.problems.length], [0, 3]);

var missing = O.rowsFromCSV('title,price\nA,10\n');
check('missing columns named', missing.problems.length, 2);

var dup = O.rowsFromCSV('title,condition,lowest_price,your_code\nA,new,10,HS-1\nB,new,10,hs-1\n');
check('same code twice is refused', dup.problems, ['Row 3: your_code "hs-1" is also on row 2. Each code can only appear once.']);
var zero = O.rowsFromCSV('title,condition,lowest_price,quantity\nA,new,10,0\n');
check('quantity 0 is allowed (means sold out)', [zero.problems, zero.items[0] && zero.items[0].quantity], [[], 0]);
var rp = O.rowsFromCSV('title,category,condition,lowest_price,UK Responsible Person\nSerum,skincare,new,10,Yes\n');
check('Responsible Person column read', rp.items[0] && rp.items[0].uk_rp_confirmed, true);

console.log('planUpload — re-uploading the same sheet updates, never duplicates');
var have = [
  { id: 'a', brand_sku: 'HS-1', status: 'live',      quantity: 3, sale_minor: 2000, uk_rp_confirmed: false },
  { id: 'b', brand_sku: 'HS-2', status: 'draft',     quantity: 1, sale_minor: null, uk_rp_confirmed: false },
  { id: 'c', brand_sku: 'HS-3', status: 'withdrawn', quantity: 2, sale_minor: null, uk_rp_confirmed: false },
  { id: 'd', brand_sku: 'HS-4', status: 'draft',     quantity: 1, sale_minor: null, uk_rp_confirmed: true }
];
var sheet = O.rowsFromCSV(
  'title,category,condition,lowest_price,quantity,your_code,photo_links\n' +
  'Dress,clothing,new,15,0,HS-1,\n' +                 // live, now sold out elsewhere
  'Top,clothing,new,12,2,hs-2,https://x.com/a.jpg\n' + // draft -> sent (code match ignores case)
  'Skirt,clothing,new,12,2,HS-3,\n' +                  // taken back -> updated, not re-sent
  'Serum,beauty,new,9,1,HS-4,\n' +                     // beauty, RP already ticked on the item
  'Coat,clothing,new,40,1,HS-9,\n' +                   // new
  'Lip oil,beauty,new,8,1,,\n' +                       // new beauty, no RP -> held back
  'Scarf,clothing,new,8,0,,\n').items;                 // new with 0 -> left out
var plan = O.planUpload(sheet, have, true);
check('two new items, two held/skipped counted', [plan.adds.length, plan.adds.map(function (r) { return r.status; }), plan.skipped, plan.held], [2, ['submitted', 'draft'], ['Scarf'], 1]);
check('four existing items updated', plan.updates.map(function (u) { return u.id; }), ['a', 'b', 'c', 'd']);
check('live item: quantity 0, status untouched, photos kept', [plan.updates[0].row.quantity, plan.updates[0].row.status, 'photos' in plan.updates[0].row], [0, undefined, false]);
check('draft item sent', plan.updates[1].row.status, 'submitted');
check('taken-back item not re-sent', [plan.updates[2].row.status, plan.notResent], [undefined, 1]);
check('beauty with RP already ticked is sent, tick not cleared', [plan.updates[3].row.status, 'uk_rp_confirmed' in plan.updates[3].row], ['submitted', false]);
check('sold-out count', plan.soldOut, 1);
var drafts = O.planUpload(sheet, have, false);
check('"save without sending" sends nothing', drafts.adds.concat(drafts.updates.map(function (u) { return u.row; }))
  .filter(function (r) { return r.status === 'submitted'; }).length, 0);
var tooHigh = O.planUpload(O.rowsFromCSV('title,condition,lowest_price,your_code\nDress,new,25,HS-1\n').items, have, true);
check('lowest price above live price stops the whole upload', [tooHigh.updates.length, tooHigh.problems.length], [0, 1]);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
