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

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
