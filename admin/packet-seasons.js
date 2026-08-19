// ============================================================
// Packet — seasonal calendar engine
// Built from the AXRIK starter kit under licence. Kit v1.1.0.
// ============================================================
// Works out when a season actually lands and, working backwards
// from that, the last sensible day to commit to buying for it.
//
// Deliberately plain, deliberately deterministic, and deliberately
// NOT an AI feature — same rule as the margin engine. A date is
// either right or wrong and it must give the same answer twice.
//
// ── Why this is not just a list of dates ────────────────────
// Half the seasons that matter to a UK shop do not sit on a fixed
// date. Easter moves. Mothering Sunday is three weeks before
// Easter, so it moves with it. Black Friday is pinned to an
// American holiday. Father's Day is the third Sunday in June.
// Hard-coding "2026-11-27" works for exactly one year and then
// quietly goes wrong, which is worse than not having it.
//
// So each season carries a RULE, and the rule is evaluated for
// whatever year is being asked about.
//
// ── The lead time is the whole point ────────────────────────
// Knowing Halloween is on 31 October is worth nothing on 28
// October. What matters is the last day it is still worth
// committing: order-by date = the event, minus how long the
// supplier takes, minus how long it takes to sell through.
//
// Those two numbers are commercial judgements, not facts, so they
// start NULL and this engine REFUSES to place a season on the
// timeline until somebody fills them in. Same rule as every
// number in the margin engine: a plausible default gets quoted
// back later as though it had been checked.
//
// Loaded by the admin page directly and by build-seasonal.js in
// Node, hence the wrapper at the bottom.
// ============================================================

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PacketSeasons = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DAY_MS = 86400000;

  // ---------------------------------------------------------- dates
  // Everything here works in UTC and in whole days. A season is a
  // day, not a moment, and dragging British Summer Time into it
  // would only introduce a way to be off by one.

  function utc(y, m, d) { return new Date(Date.UTC(y, m - 1, d)); }

  function toISODate(date) { return date.toISOString().slice(0, 10); }

  function addDays(date, n) { return new Date(date.getTime() + n * DAY_MS); }

  function daysBetween(a, b) {
    return Math.round((b.getTime() - a.getTime()) / DAY_MS);
  }

  // Strip any time component so comparisons are day-to-day.
  function startOfDay(date) {
    return utc(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
  }

  // Easter Sunday, Gregorian calendar — the anonymous computus.
  // Published, unchanged since 1800, and checked against known
  // dates in the tests rather than taken on trust.
  function easterSunday(year) {
    var a = year % 19;
    var b = Math.floor(year / 100);
    var c = year % 100;
    var d = Math.floor(b / 4);
    var e = b % 4;
    var f = Math.floor((b + 8) / 25);
    var g = Math.floor((b - f + 1) / 3);
    var h = (19 * a + b - d - g + 15) % 30;
    var i = Math.floor(c / 4);
    var k = c % 4;
    var l = (32 + 2 * e + 2 * i - h - k) % 7;
    var m = Math.floor((a + 11 * h + 22 * l) / 451);
    var month = Math.floor((h + l - 7 * m + 114) / 31);
    var day = ((h + l - 7 * m + 114) % 31) + 1;
    return utc(year, month, day);
  }

  // The nth given weekday of a month. nth = -1 means the last one.
  // weekday is 0 = Sunday, matching getUTCDay().
  function nthWeekday(year, month, weekday, nth) {
    if (nth === -1) {
      var last = utc(year, month + 1, 1);
      last = addDays(last, -1);
      var backA = (last.getUTCDay() - weekday + 7) % 7;
      return addDays(last, -backA);
    }
    var first = utc(year, month, 1);
    var forward = (weekday - first.getUTCDay() + 7) % 7;
    return addDays(first, forward + (nth - 1) * 7);
  }

  // ---------------------------------------------------------- the rules
  //
  // A season row carries:
  //   date_rule    'fixed' | 'nth_weekday' | 'easter_offset'
  //   event_month  1-12          (fixed, nth_weekday)
  //   event_day    1-31          (fixed)
  //   event_weekday 0-6, Sun=0   (nth_weekday)
  //   event_nth    1-5 or -1     (nth_weekday)
  //   day_offset   integer       (any rule — shifts the result)
  //
  // day_offset is what makes Black Friday expressible without a
  // special case: the fourth Thursday in November, plus one day.
  function eventDateFor(season, year) {
    if (!season) return null;
    var base;

    switch (season.date_rule) {
      case 'fixed':
        if (!isInt(season.event_month) || !isInt(season.event_day)) return null;
        base = utc(year, season.event_month, season.event_day);
        break;

      case 'nth_weekday':
        if (!isInt(season.event_month) || !isInt(season.event_weekday) || !isInt(season.event_nth)) return null;
        base = nthWeekday(year, season.event_month, season.event_weekday, season.event_nth);
        break;

      case 'easter_offset':
        base = easterSunday(year);
        break;

      default:
        return null;
    }

    return addDays(base, isInt(season.day_offset) ? season.day_offset : 0);
  }

  // The occurrence we are currently working towards.
  //
  // tailDays is what stops Boxing Day being treated as eleven
  // months early for next Christmas. A season is not finished on
  // the day itself — a Christmas range is still worth having up on
  // 28 December — so an occurrence stays current until its selling
  // tail has run out, and only then does this roll forward.
  //
  // Checks the year either side as well, because an offset can push
  // a December season into January or an Easter one backwards.
  function nextOccurrence(season, today, tailDays) {
    var from = startOfDay(today || new Date());
    var tail = isInt(tailDays) ? tailDays : 0;
    var year = from.getUTCFullYear();
    for (var y = year - 1; y <= year + 2; y++) {
      var d = eventDateFor(season, y);
      if (d && addDays(d, tail).getTime() >= from.getTime()) return d;
    }
    return null;
  }

  // ---------------------------------------------------------- the window
  //
  // The three dates that actually drive a decision, working
  // backwards from the event:
  //
  //   order by     last day it is worth committing to stock
  //   sell from    when the range should be live on the shop
  //   sell until   when it stops being worth showing
  //
  // Returns ready:false with a plain reason rather than guessing
  // whenever a required number has not been entered.
  function window(season, today) {
    var out = { ready: false, reasons: [], season: season && season.name };
    if (!season) { out.reasons.push('No season given.'); return out; }

    var event = nextOccurrence(season, today, season.sell_until_days_after);
    if (!event) {
      out.reasons.push('This season has no usable date rule, so it cannot be placed on a calendar.');
      return out;
    }

    out.eventDate = toISODate(event);
    var from = startOfDay(today || new Date());
    out.daysToEvent = daysBetween(from, event);

    // The two judgement calls. Blank on purpose until somebody has
    // asked a supplier how long they actually take.
    var lead = season.source_lead_weeks;
    var sell = season.sell_from_weeks_before;

    if (!isInt(lead)) {
      out.reasons.push(
        'No sourcing lead time set for ' + (season.name || 'this season') + ', so there is no ' +
        'order-by date. Ask a supplier how many weeks they need between an order and it being ' +
        'ready to ship, and put that number in. It is left blank rather than guessed.');
    }
    if (!isInt(sell)) {
      out.reasons.push(
        'No selling window set for ' + (season.name || 'this season') + ', so there is no date ' +
        'to put the range live. How many weeks before the day do people start buying? That is a ' +
        'judgement, so it is left blank rather than guessed.');
    }
    if (out.reasons.length) return out;

    var sellFrom  = addDays(event, -sell * 7);
    var orderBy   = addDays(sellFrom, -lead * 7);
    var sellUntil = addDays(event, isInt(season.sell_until_days_after) ? season.sell_until_days_after : 0);

    out.orderByDate  = toISODate(orderBy);
    out.sellFromDate = toISODate(sellFrom);
    out.sellUntilDate = toISODate(sellUntil);
    out.daysToOrderBy = daysBetween(from, orderBy);

    // Where we are against that timeline. This is the only thing
    // anybody actually reads off the screen.
    //
    // There is no "finished" stage, deliberately. Once a season's
    // selling tail runs out the calendar rolls straight on to next
    // year's, because for a business planning ahead that is the
    // only version of Christmas that can still be acted on.
    if (from.getTime() > orderBy.getTime()) {
      out.stage = 'too_late';
      out.plain = 'Too late to source this properly — the order-by date was ' + out.orderByDate +
                  '. Anything bought now arrives while everyone else is discounting.';
    } else if (out.daysToOrderBy <= 14) {
      out.stage = 'act_now';
      out.plain = 'Decide within ' + out.daysToOrderBy + ' day' + (out.daysToOrderBy === 1 ? '' : 's') +
                  '. Order by ' + out.orderByDate + ' to be selling from ' + out.sellFromDate + '.';
    } else if (out.daysToOrderBy <= 56) {
      out.stage = 'coming_up';
      out.plain = 'Worth looking at now. Order by ' + out.orderByDate +
                  ', selling from ' + out.sellFromDate + '.';
    } else {
      out.stage = 'early';
      out.plain = 'Nothing to do yet. Order-by is ' + out.orderByDate + ', which is ' +
                  out.daysToOrderBy + ' days away.';
    }

    out.ready = true;
    return out;
  }

  // Everything with a decision still to make, most urgent first.
  //
  // Sorted by days-to-order-by ascending, which puts anything
  // already past its deadline at the very top. That is deliberate.
  // Standing in August, "the Christmas order-by was two weeks ago"
  // is the most important sentence on the screen, and burying it
  // below a Halloween deadline that is still three days away would
  // be the wrong way round.
  //
  // Seasons missing their numbers go last, but they are still
  // there. A season that vanishes because a field is blank is
  // exactly how Christmas gets missed.
  function timeline(seasons, today) {
    var rows = (seasons || [])
      .filter(function (s) { return s && s.active !== false; })
      .map(function (s) { return { season: s, window: window(s, today) }; });

    var ready = rows.filter(function (r) { return r.window.ready; })
      .sort(function (a, b) { return a.window.daysToOrderBy - b.window.daysToOrderBy; });

    var waiting = rows.filter(function (r) { return !r.window.ready; });

    return ready.concat(waiting);
  }

  function isInt(v) {
    return typeof v === 'number' && isFinite(v) && Math.floor(v) === v;
  }

  return {
    easterSunday: easterSunday,
    nthWeekday: nthWeekday,
    eventDateFor: eventDateFor,
    nextOccurrence: nextOccurrence,
    window: window,
    timeline: timeline,
    toISODate: toISODate
  };
}));
