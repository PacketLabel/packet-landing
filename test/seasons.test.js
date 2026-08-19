// Packet — seasonal calendar checks.
// Run: node test/seasons.test.js
//
// Two things are being proved here.
//
// First, that the moveable dates are actually right. Easter, and
// everything pinned to it, is the single easiest thing in this
// feature to get quietly wrong — wrong by a week, every year,
// with nothing on screen to show it. So the dates below are
// checked against published calendars rather than against the
// code's own opinion.
//
// Second, that the engine refuses rather than guesses when a lead
// time is missing. That is the same rule as the margin engine and
// it matters more here, because a made-up lead time produces a
// confident order-by date that somebody would act on.

var S = require('../admin/packet-seasons.js');
var B = require('../netlify-functions/build-seasonal.js')._internal;

var pass = 0, fail = 0;
function check(name, actual, expected) {
  var ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else    { fail++; console.log('  FAIL  ' + name + '\n        expected ' + JSON.stringify(expected) + '\n        got      ' + JSON.stringify(actual)); }
}

function iso(d) { return d === null ? null : S.toISODate(d); }


console.log('\nEaster Sunday, against published dates');
// Checked against the Church of England / Royal Greenwich tables.
check('2024', iso(S.easterSunday(2024)), '2024-03-31');
check('2025', iso(S.easterSunday(2025)), '2025-04-20');
check('2026', iso(S.easterSunday(2026)), '2026-04-05');
check('2027', iso(S.easterSunday(2027)), '2027-03-28');
check('2028', iso(S.easterSunday(2028)), '2028-04-16');
check('2029', iso(S.easterSunday(2029)), '2029-04-01');
check('2030', iso(S.easterSunday(2030)), '2030-04-21');
// A century boundary, because the computus has terms that only
// move when the century does.
check('2100', iso(S.easterSunday(2100)), '2100-03-28');


console.log('\nMothering Sunday is three weeks before Easter, and moves with it');
var mothering = { date_rule: 'easter_offset', day_offset: -21 };
check('2026', iso(S.eventDateFor(mothering, 2026)), '2026-03-15');
check('2027', iso(S.eventDateFor(mothering, 2027)), '2027-03-07');
check('2028', iso(S.eventDateFor(mothering, 2028)), '2028-03-26');
// The whole point of the rule. A fixed date would have been wrong
// by nineteen days between these two years.
check('it really does move', iso(S.eventDateFor(mothering, 2027)) !== iso(S.eventDateFor(mothering, 2028)), true);


console.log('\nThe nth weekday of a month');
// Father's Day UK: third Sunday in June. 0 = Sunday.
check('3rd Sunday June 2026',  iso(S.nthWeekday(2026, 6, 0, 3)), '2026-06-21');
check('3rd Sunday June 2027',  iso(S.nthWeekday(2027, 6, 0, 3)), '2027-06-20');
// Black Friday: fourth Thursday in November, plus a day.
check('4th Thursday Nov 2026', iso(S.nthWeekday(2026, 11, 4, 4)), '2026-11-26');
check('4th Thursday Nov 2027', iso(S.nthWeekday(2027, 11, 4, 4)), '2027-11-25');
// The last one of a month, which is the awkward case.
check('last Monday Aug 2026',  iso(S.nthWeekday(2026, 8, 1, -1)), '2026-08-31');
check('last Friday Feb 2026',  iso(S.nthWeekday(2026, 2, 5, -1)), '2026-02-27');
// A month starting on the weekday being asked for.
check('1st Wednesday Jul 2026', iso(S.nthWeekday(2026, 7, 3, 1)), '2026-07-01');

var blackFriday = { date_rule: 'nth_weekday', event_month: 11, event_weekday: 4, event_nth: 4, day_offset: 1 };
check('Black Friday 2026', iso(S.eventDateFor(blackFriday, 2026)), '2026-11-27');
check('Black Friday 2027', iso(S.eventDateFor(blackFriday, 2027)), '2027-11-26');


console.log('\nFixed dates, and rolling into next year');
var halloween = { date_rule: 'fixed', event_month: 10, event_day: 31, name: 'Halloween' };
check('the date itself', iso(S.eventDateFor(halloween, 2026)), '2026-10-31');
// Standing in early August, Halloween is still to come this year.
check('next one from 19 Aug 2026',
  iso(S.nextOccurrence(halloween, new Date('2026-08-19T00:00:00Z'))), '2026-10-31');
// Standing in November it is next year's.
check('next one from 5 Nov 2026',
  iso(S.nextOccurrence(halloween, new Date('2026-11-05T00:00:00Z'))), '2027-10-31');
// The day itself still counts as to come, not gone.
check('the day itself still counts',
  iso(S.nextOccurrence(halloween, new Date('2026-10-31T00:00:00Z'))), '2026-10-31');


console.log('\nIt refuses to guess a lead time');
var noLead = { name: 'Halloween', date_rule: 'fixed', event_month: 10, event_day: 31 };
var w = S.window(noLead, new Date('2026-08-19T00:00:00Z'));
check('not ready', w.ready, false);
check('no order-by date is invented', w.orderByDate, undefined);
check('says which number is missing', /lead time/i.test(w.reasons.join(' ')), true);
check('and says why it is blank', /rather than guessed/i.test(w.reasons.join(' ')), true);

// Half the numbers is still not enough.
var halfLead = { name: 'Halloween', date_rule: 'fixed', event_month: 10, event_day: 31,
                 source_lead_weeks: 6 };
check('lead without a selling window is still refused', S.window(halfLead, new Date('2026-08-19T00:00:00Z')).ready, false);


console.log('\nThe order-by date, once the numbers are there');
// Halloween 2026, supplier needs 6 weeks, want to be selling 4
// weeks before the day.
//   event      31 Oct 2026
//   sell from  4 weeks before  -> 3 Oct 2026
//   order by   6 weeks before that -> 22 Aug 2026
var full = { name: 'Halloween', date_rule: 'fixed', event_month: 10, event_day: 31,
             source_lead_weeks: 6, sell_from_weeks_before: 4, sell_until_days_after: 0 };
var fw = S.window(full, new Date('2026-08-19T00:00:00Z'));
check('ready', fw.ready, true);
check('event',      fw.eventDate,    '2026-10-31');
check('sell from',  fw.sellFromDate, '2026-10-03');
check('order by',   fw.orderByDate,  '2026-08-22');
check('days left to decide', fw.daysToOrderBy, 3);
check('stage', fw.stage, 'act_now');

// One day past the order-by date and the honest answer changes.
var late = S.window(full, new Date('2026-08-23T00:00:00Z'));
check('a day late is too late', late.stage, 'too_late');
check('and it says so plainly', /Too late/i.test(late.plain), true);

// Far enough out and there is nothing to do.
var early = S.window(full, new Date('2026-01-05T00:00:00Z'));
check('early in the year', early.stage, 'early');

// After the day, but inside the tail.
var xmas = { name: 'Christmas', date_rule: 'fixed', event_month: 12, event_day: 25,
             source_lead_weeks: 12, sell_from_weeks_before: 8, sell_until_days_after: 7 };
// Boxing Day week: the range is still up, so the calendar is
// still talking about THIS Christmas rather than next one.
var boxing = S.window(xmas, new Date('2026-12-28T00:00:00Z'));
check('still this year during the tail', boxing.eventDate, '2026-12-25');
check('and past the order-by, obviously', boxing.stage, 'too_late');
// Once the tail runs out it rolls forward to next year's, because
// that is the only Christmas anybody can still act on.
var january = S.window(xmas, new Date('2027-01-03T00:00:00Z'));
check('past the tail, it rolls to next year', january.eventDate, '2027-12-25');


console.log('\nThe timeline puts the nearest deadline first and never hides a season');
var seasons = [
  { name: 'Christmas', date_rule: 'fixed', event_month: 12, event_day: 25,
    source_lead_weeks: 12, sell_from_weeks_before: 8 },
  { name: 'Halloween', date_rule: 'fixed', event_month: 10, event_day: 31,
    source_lead_weeks: 6, sell_from_weeks_before: 4 },
  { name: 'St Patrick\'s Day', date_rule: 'fixed', event_month: 3, event_day: 17 }
];
var line = S.timeline(seasons, new Date('2026-08-19T00:00:00Z'));
check('three rows out for three in', line.length, 3);
// On 19 August the Christmas order-by (7 Aug) has already gone,
// while Halloween's is three days off. Overdue outranks imminent,
// because "you have missed the Christmas deadline" is the more
// important sentence.
check('the missed deadline is top', line[0].season.name, 'Christmas');
check('it is already past', line[0].window.stage, 'too_late');
check('then the imminent one', line[1].season.name, 'Halloween');
check('which still has time', line[1].window.stage, 'act_now');
// The one waiting on numbers is last, but it is still THERE. A
// season that disappears because a field is blank is exactly how
// something gets missed.
check('the one with no lead time is carried, not dropped', line[2].season.name, 'St Patrick\'s Day');
check('and is marked as not ready', line[2].window.ready, false);

var paused = S.timeline(seasons.concat([{ name: 'Off', active: false, date_rule: 'fixed', event_month: 5, event_day: 1 }]),
                        new Date('2026-08-19T00:00:00Z'));
check('a paused season is left out', paused.length, 3);


console.log('\nBroken rules produce nothing rather than a wrong date');
check('a fixed rule with no day',   S.eventDateFor({ date_rule: 'fixed', event_month: 10 }, 2026), null);
check('an unknown rule',            S.eventDateFor({ date_rule: 'whenever' }, 2026), null);
check('nothing at all',             S.eventDateFor(null, 2026), null);
check('window says so rather than throwing', S.window({ date_rule: 'nonsense' }, new Date()).ready, false);


console.log('\nThe seasonal shortlist keeps the best few per season');
var rows = [
  { season_id: 'a', score: 10, compliance_status: 'ok' },
  { season_id: 'a', score: 90, compliance_status: 'ok' },
  { season_id: 'a', score: 50, compliance_status: 'ok' },
  { season_id: 'b', score: 70, compliance_status: 'ok' },
  { season_id: 'b', score: 0,  compliance_status: 'blocked' }
];
var kept = B.topPerSeason(rows, 2);
check('two from each season plus the blocked one', kept.length, 4);
check('best first within a season', kept[0].score, 90);
// Christmas must not be able to crowd out St Patrick's Day.
check('every season is represented',
  kept.filter(function (k) { return k.season_id === 'b'; }).length, 2);
// A blocked row is kept and shown rather than filtered away, so
// "we cannot sell this and here is why" is answered once.
check('the blocked row survives',
  kept.filter(function (k) { return k.compliance_status === 'blocked'; }).length, 1);


console.log('\nThe gap report counts shops, not listings');
var live = [{ season: { id: 's1', name: 'Halloween' }, window: { orderByDate: '2026-08-22' } }];
// Three listings for "pumpkin" but only two shops between them.
var competitorRows = [
  { season_id: 's1', matched_term: 'pumpkin', competitor_id: 'c1', price_pence: 800, title: 'Pumpkin A', product_url: 'u1' },
  { season_id: 's1', matched_term: 'pumpkin', competitor_id: 'c1', price_pence: 1200, title: 'Pumpkin B', product_url: 'u2' },
  { season_id: 's1', matched_term: 'pumpkin', competitor_id: 'c2', price_pence: 1000, title: 'Pumpkin C', product_url: 'u3' },
  { season_id: 's1', matched_term: 'witch',   competitor_id: 'c1', price_pence: 500,  title: 'Witch hat', product_url: 'u4' }
];
var supplierRows = [
  { season_id: 's1', matched_term: 'witch', supplier_product_id: 'p1' }
];
var gaps = B.buildGaps(live, competitorRows, supplierRows, 'run1');
check('one row per word', gaps.length, 2);
check('the real gap sorts first', gaps[0].term, 'pumpkin');
check('two shops, not three listings', gaps[0].n_competitor_stores, 2);
check('three listings counted separately', gaps[0].n_competitor_products, 3);
check('no supplier has one', gaps[0].n_supplier_products, 0);
check('median of 800, 1000, 1200', gaps[0].competitor_median_pence, 1000);
check('examples are carried so a gap can be looked at', gaps[0].examples.length, 3);
check('the word we can already supply is not a gap', gaps[1].n_supplier_products, 1);



console.log('\nA product matching several words is one row, not several');
// A pumpkin lantern matches "halloween" and "pumpkin". Without
// collapsing these it would appear on the shortlist twice, with
// identical numbers, asking to be decided on twice.
var links = [
  { supplier_product_id: 'p1', matched_term: 'halloween' },
  { supplier_product_id: 'p1', matched_term: 'pumpkin' },
  { supplier_product_id: 'p2', matched_term: 'witch' }
];
var deduped = B.dedupeByProduct(links);
check('two products out of three matches', deduped.length, 2);
check('and both words are kept', deduped[0].matched_term, 'halloween, pumpkin');
check('the single-word one is unchanged', deduped[1].matched_term, 'witch');
check('nothing in, nothing out', B.dedupeByProduct([]).length, 0);


console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
