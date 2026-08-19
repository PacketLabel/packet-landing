// Packet — ask box checks.
// Run: node test/assistant.test.js
//
// This file is mostly about one question: can a sentence typed
// into a box reach something it should not?
//
// The ask box takes free text, hands it to a model, and gets JSON
// back. That JSON is not trusted, and these checks are what prove
// it. Every case below is written as though the model had been
// talked into returning something it should not have — because
// the model is the part of this feature that can be argued with,
// and the validator is the part that cannot.
//
// The second thing being proved is that the sentence shown to the
// person before they press the button describes what would
// actually happen. If those two ever came apart, somebody would
// be approving one thing and getting another, which is the worst
// failure available in this feature.

var A = require('../netlify-functions/sourcing-assistant.js')._internal;

var pass = 0, fail = 0;
function check(name, actual, expected) {
  var ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else    { fail++; console.log('  FAIL  ' + name + '\n        expected ' + JSON.stringify(expected) + '\n        got      ' + JSON.stringify(actual)); }
}


console.log('\nThe allow-list is the list, and nothing else gets through');
// Everything below is a real thing somebody might ask for and the
// model might dutifully invent an action name for. None of them
// exist, so none of them survive.
var forbidden = [
  { type: 'set_vat_rate', vat_rate: 0.2 },
  { type: 'update_sourcing_settings', payment_fee_pct: 0.014 },
  { type: 'set_payment_fee', value: 100 },
  { type: 'set_supplier_rp', name: 'Acme', is_uk_responsible_person: true },
  { type: 'approve_opportunity', id: 'abc' },
  { type: 'reject_opportunity', id: 'abc' },
  { type: 'set_category_requires_uk_rp', category: 'beauty-cosmetics', value: false },
  { type: 'delete_competitor', name: 'Boots' },
  { type: 'add_user', email: 'someone@example.com', role: 'owner' },
  { type: 'run_sql', sql: 'drop table opportunities' }
];
var r = A.validateActions(forbidden);
check('not one of them survives', r.actions.length, 0);
check('and each is reported as refused', r.dropped.length, forbidden.length);

// The two that matter most, called out on their own so a future
// change that quietly widens the list fails loudly here.
check('the VAT rate cannot be reached',
  A.validateActions([{ type: 'set_vat_rate', vat_rate: 0.2 }]).actions.length, 0);
check('the Responsible Person flag cannot be reached',
  A.validateActions([{ type: 'set_supplier_rp', name: 'Acme' }]).actions.length, 0);
check('nothing can be approved',
  A.validateActions([{ type: 'approve_opportunity', id: 'x' }]).actions.length, 0);

check('the allow-list is exactly ten entries', A.ALLOWED.length, 10);
check('and contains nothing about settings',
  A.ALLOWED.filter(function (t) { return /setting|fee|vat|margin|rp|responsible|approve/i.test(t); }).length, 0);


console.log('\nFields are rebuilt from scratch, never copied wholesale');
// A competitor smuggling extra fields alongside the legitimate
// ones. Only the three named fields come out the other side.
var smuggled = A.validateActions([{
  type: 'add_competitor',
  name: 'Example',
  website: 'https://example.com',
  platform: 'shopify',
  active: false,
  id: '00000000-0000-0000-0000-000000000000',
  scan_frequency_hours: 1
}]);
check('one action', smuggled.actions.length, 1);
check('and only the fields we asked for',
  Object.keys(smuggled.actions[0]).sort(), ['name', 'platform', 'type', 'website']);

// A supplier arriving pre-ticked as a Responsible Person. The
// field is not copied, so the compliance gate keeps refusing their
// cosmetics until a human ticks it with evidence.
var sup = A.validateActions([{
  type: 'add_supplier', name: 'Acme Beauty',
  is_uk_responsible_person: true, rp_evidence: 'they said so on the phone'
}]);
check('supplier accepted', sup.actions.length, 1);
check('but not as a Responsible Person',
  'is_uk_responsible_person' in sup.actions[0], false);
check('and no evidence sneaks through', 'rp_evidence' in sup.actions[0], false);

// A new season arriving with a lead time already filled in. Lead
// times are the one thing the calendar refuses to guess, so a
// season created this way starts blank like every other.
var seas = A.validateActions([{
  type: 'add_season', slug: 'diwali', name: 'Diwali',
  date_rule: 'fixed', event_month: 11, event_day: 1,
  source_lead_weeks: 8, sell_from_weeks_before: 4
}]);
check('season accepted', seas.actions.length, 1);
check('without a lead time', 'source_lead_weeks' in seas.actions[0], false);


console.log('\nWebsites have to look like websites');
check('a bare domain is filled in',    A.website_('example.com'), 'https://example.com');
check('www is kept',                   A.website_('www.example.co.uk'), 'https://www.example.co.uk');
check('a path is dropped',             A.website_('https://example.com/collections/all'), 'https://example.com');
check('javascript: is refused',        A.website_('javascript:alert(1)'), null);
check('a file path is refused',        A.website_('file:///etc/passwd'), null);
check('a bare word is refused',        A.website_('shopify'), null);
check('nothing is refused',            A.website_(''), null);
// No website means no competitor, because a competitor with no
// address cannot be scanned and would just sit there looking real.
check('a competitor without one is dropped',
  A.validateActions([{ type: 'add_competitor', name: 'Nowhere' }]).actions.length, 0);


console.log('\nNumbers are bounded, not merely parsed');
check('in range',            A.int_(8, 0, 104), 8);
check('zero is a real answer', A.int_(0, 0, 104), 0);
check('above the ceiling',   A.int_(500, 0, 104), null);
check('below the floor',     A.int_(-1, 0, 104), null);
check('not a whole number',  A.int_(2.5, 0, 104), null);
check('not a number at all', A.int_('soon', 0, 104), null);
check('blank',               A.int_('', 0, 104), null);
// A lead time of 5,000 weeks would produce an order-by date a
// century back and a screen full of nonsense.
check('an absurd lead time is refused',
  A.validateActions([{ type: 'set_season_lead_times', slug: 'christmas', source_lead_weeks: 5000 }]).actions.length, 0);
check('a sane one is not',
  A.validateActions([{ type: 'set_season_lead_times', slug: 'christmas', source_lead_weeks: 12 }]).actions.length, 1);


console.log('\nHalf an instruction is not an instruction');
check('a season with no date rule',
  A.validateActions([{ type: 'add_season', name: 'Something', slug: 'something' }]).actions.length, 0);
check('a fixed season with no day',
  A.validateActions([{ type: 'add_season', name: 'X', slug: 'x', date_rule: 'fixed', event_month: 5 }]).actions.length, 0);
check('an nth-weekday season with no weekday',
  A.validateActions([{ type: 'add_season', name: 'X', slug: 'x', date_rule: 'nth_weekday', event_month: 5, event_nth: 2 }]).actions.length, 0);
check('a lead-time change setting nothing',
  A.validateActions([{ type: 'set_season_lead_times', slug: 'christmas' }]).actions.length, 0);
check('a term with no season',
  A.validateActions([{ type: 'add_season_term', term: 'pumpkin' }]).actions.length, 0);
check('rubbish in the array',
  A.validateActions([null, 'add_competitor', 42, []]).actions.length, 0);
check('not an array at all',
  A.validateActions({ type: 'add_competitor' }).actions.length, 0);
check('nothing at all',
  A.validateActions(undefined).actions.length, 0);


console.log('\nThere is a ceiling on how much one sentence can do');
var many = [];
for (var i = 0; i < 40; i++) many.push({ type: 'add_season_term', slug: 'halloween', term: 'term' + i });
check('capped at twelve', A.validateActions(many).actions.length, 12);


console.log('\nWhat you are shown is what would happen');
// The preview is generated from the validated actions by ordinary
// code, so it cannot describe something different from what runs.
var d = A.describeOne({ type: 'add_supplier', name: 'Acme Beauty' });
check('the supplier preview says the RP box is not ticked', /Responsible Person/.test(d), true);
check('and says what that means', /refuse to shortlist any cosmetics/.test(d), true);

var dc = A.describeOne({ type: 'add_competitor', name: 'Example', website: 'https://example.com', platform: 'unknown' });
check('an unknown platform is flagged as needing hand-watching',
  /by hand/.test(dc), true);

var ds = A.describeOne({ type: 'add_season', slug: 'diwali', name: 'Diwali',
                         date_rule: 'fixed', event_month: 11, event_day: 1, day_offset: 0 });
check('a new season reads as a date',  /1 November each year/.test(ds), true);
check('and says it still needs numbers', /no lead time/.test(ds), true);

var dn = A.describeOne({ type: 'add_season', slug: 'fd', name: 'Father\'s Day',
                         date_rule: 'nth_weekday', event_month: 6, event_weekday: 0,
                         event_nth: 3, day_offset: 0 });
check('an nth-weekday season reads in English', /third Sunday in June/.test(dn), true);

var de = A.describeOne({ type: 'add_season', slug: 'ms', name: 'Mothering Sunday',
                         date_rule: 'easter_offset', day_offset: -21 });
check('an Easter season explains the offset', /21 days before Easter/.test(de), true);

var dl = A.describeOne({ type: 'set_season_lead_times', slug: 'christmas', source_lead_weeks: 12 });
check('a lead time preview warns against estimating', /rather than an estimate/.test(dl), true);

// Numbered, so the person can see there are three of them rather
// than reading a paragraph and missing one.
var multi = A.describe([
  { type: 'pause_competitor', name: 'Boots' },
  { type: 'add_season_term', slug: 'halloween', term: 'pumpkin' }
]);
check('numbered', /^1\. /.test(multi) && /\n2\. /.test(multi), true);


console.log('\nThe non-AI fallback understands the obvious, and guesses at nothing');
var p1 = A.patternParse('add competitor Lookfantastic lookfantastic.com');
check('a competitor', p1.length, 1);
check('with the right name', p1[0].name, 'Lookfantastic');
check('and the right site', p1[0].website, 'lookfantastic.com');

var p2 = A.patternParse('stop watching Boots');
check('pausing one', p2[0].type, 'pause_competitor');
check('by name', p2[0].name, 'Boots');

var p3 = A.patternParse('add the word "pumpkin spice" to halloween');
check('a season word', p3[0].type, 'add_season_term');
check('the word', p3[0].term, 'pumpkin spice');
check('the season', p3[0].slug, 'halloween');

var p4 = A.patternParse('remove the word ghost from halloween');
check('removing one', p4[0].type, 'remove_season_term');

// The important half. Anything it does not recognise produces
// nothing, which becomes an honest "I did not understand that".
// A near miss here would mean changing the wrong shop's record.
check('a vague question',      A.patternParse('what should we sell for christmas?').length, 0);
check('an instruction about money', A.patternParse('set the VAT rate to 20%').length, 0);
check('an approval',           A.patternParse('approve the top three').length, 0);
check('empty',                 A.patternParse('').length, 0);
check('nothing',               A.patternParse(null).length, 0);

// And whatever the fallback does produce still goes through the
// same validator as everything else — it is not a side door.
check('the fallback is validated too',
  A.validateActions(A.patternParse('add competitor Nowhere')).actions.length, 0);


console.log('\nText is tidied and capped rather than trusted');
check('whitespace collapsed', A.text('  Acme   Beauty  '), 'Acme Beauty');
check('empty becomes nothing', A.text('   '), null);
check('capped at 120 characters', A.text('x'.repeat(500)).length, 120);
check('a slug is made safe', A.slug_('St Patrick’s Day!!'), 'st-patricks-day');
check('a slug cannot be empty', A.slug_('!!!'), null);


console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
