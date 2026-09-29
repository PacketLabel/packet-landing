/* ============================================================
   Packet — Outlet helpers
   ------------------------------------------------------------
   Shared by brand.html (what a brand sees) and index.html (what
   Phil and Scott see), and by test/outlet.test.js. Plain functions,
   no network, so the sums on both screens come from one place.

   Money is always whole pence. The database checks the rules that
   matter (a brand cannot price or approve its own stock); this file
   only makes the screens say the same thing the database will.
   ============================================================ */
(function (root) {
  'use strict';

  var CONDITIONS = [
    { v: 'new_with_tags',   label: 'New, with tags',       needsNote: false },
    { v: 'new_no_tags',     label: 'New, tags removed',    needsNote: false },
    { v: 'returned_as_new', label: 'Returned, as new',     needsNote: false },
    { v: 'returned_worn',   label: 'Returned, tried on or worn', needsNote: true },
    { v: 'box_damaged',     label: 'Packaging damaged',    needsNote: true },
    { v: 'minor_fault',     label: 'Small fault',          needsNote: true }
  ];

  var CATEGORIES = [
    { v: 'clothing',    label: 'Clothing' },
    { v: 'footwear',    label: 'Footwear' },
    { v: 'accessories', label: 'Accessories' },
    { v: 'jewellery',   label: 'Jewellery' },
    { v: 'beauty',      label: 'Beauty, skincare, haircare, fragrance' },
    { v: 'home',        label: 'Home' },
    { v: 'kids',        label: 'Kids' },
    { v: 'pets',        label: 'Pets' },
    { v: 'other',       label: 'Something else' }
  ];

  var ITEM_STATUS = {
    draft:     { label: 'Not sent yet',      tag: 'dim' },
    submitted: { label: 'With Packet',       tag: 'mid' },
    live:      { label: 'On sale',           tag: 'on'  },
    paused:    { label: 'Paused by Packet',  tag: 'dim' },
    withdrawn: { label: 'Taken back',        tag: 'dim' },
    rejected:  { label: 'Not listed',        tag: 'off' }
  };

  var ORDER_STATUS = {
    to_ship:   { label: 'To post',   tag: 'mid' },
    shipped:   { label: 'Posted',    tag: 'on'  },
    cancelled: { label: 'Cancelled', tag: 'dim' },
    returned:  { label: 'Returned',  tag: 'off' }
  };

  function find(list, v) {
    for (var i = 0; i < list.length; i++) if (list[i].v === v) return list[i];
    return null;
  }

  function conditionLabel(v) { var c = find(CONDITIONS, v); return c ? c.label : (v || ''); }
  function categoryLabel(v)  { var c = find(CATEGORIES, v); return c ? c.label : (v || ''); }
  function conditionNeedsNote(v) { var c = find(CONDITIONS, v); return !!(c && c.needsNote); }

  // £12.50 from 1250. Blank for null, so a gap shows as a gap.
  function money(pence) {
    if (pence === null || pence === undefined || pence === '') return '';
    var n = Number(pence);
    if (!isFinite(n)) return '';
    var neg = n < 0; n = Math.abs(Math.round(n));
    var s = '£' + Math.floor(n / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',') +
            '.' + ('0' + (n % 100)).slice(-2);
    return neg ? '-' + s : s;
  }

  // "12.50", "£12.50", "12" -> 1250. "" -> null. Nonsense -> NaN.
  // Deliberately refuses thousands of pounds typed with a comma as a
  // decimal point ("12,50") rather than guessing which was meant.
  function toPence(v) {
    if (v === null || v === undefined) return null;
    var s = String(v).trim().replace(/^£\s*/, '').replace(/,(?=\d{3}(\D|$))/g, '');
    if (s === '') return null;
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
    var parts = s.split('.');
    var p = parseInt(parts[0], 10) * 100 + (parts[1] ? parseInt((parts[1] + '0').slice(0, 2), 10) : 0);
    return p;
  }

  // What the brand gets for one line, the same sum the database does
  // in outlet_orders_before(). NULL when terms are not agreed.
  function payout(salePence, quantity, commissionPct) {
    if (commissionPct === null || commissionPct === undefined || commissionPct === '') return null;
    var pct = Number(commissionPct);
    if (!isFinite(pct) || pct < 0 || pct > 100) return null;
    var q = quantity || 1;
    return Math.round(salePence * q * (100 - pct) / 100);
  }

  // ── Spreadsheet upload ──────────────────────────────────────
  // A brand with forty returns will not type forty forms. They save a
  // spreadsheet as CSV and upload it. This reads one, handling the
  // quoting Excel and Google Sheets actually produce.
  function parseCSV(text) {
    var rows = [], row = [], field = '', i = 0, q = false;
    text = String(text || '').replace(/^﻿/, '');
    while (i < text.length) {
      var ch = text[i];
      if (q) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          q = false; i++; continue;
        }
        field += ch; i++; continue;
      }
      if (ch === '"') { q = true; i++; continue; }
      if (ch === ',') { row.push(field); field = ''; i++; continue; }
      if (ch === '\r') { i++; continue; }
      if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
      field += ch; i++;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (c) { return String(c).trim() !== ''; }); });
  }

  var CSV_COLUMNS = ['title', 'category', 'condition', 'condition_note', 'size', 'colour',
                     'quantity', 'normal_price', 'lowest_price', 'your_code', 'description',
                     'photo_links', 'available_until'];

  function csvTemplate() {
    return CSV_COLUMNS.join(',') + '\n' +
      '"Recycled wool cardigan",clothing,returned_as_new,,M,Olive,1,89.00,45.00,SS-CARD-OL-M,' +
      '"Returned unworn, tags attached",https://example.com/photo1.jpg,\n';
  }

  // Header names are matched loosely: "Lowest price", "lowest_price"
  // and "LOWEST PRICE (£)" are all the same column.
  function norm(h) { return String(h || '').toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z]+/g, '_').replace(/^_|_$/g, ''); }

  function matchCategory(v) {
    var s = norm(v);
    if (!s) return 'other';
    for (var i = 0; i < CATEGORIES.length; i++) {
      if (s === CATEGORIES[i].v || s === norm(CATEGORIES[i].label)) return CATEGORIES[i].v;
    }
    if (/skin|hair|fragrance|perfume|makeup|cosmetic|beauty|nail/.test(s)) return 'beauty';
    if (/shoe|boot|trainer|sandal/.test(s)) return 'footwear';
    if (/ring|necklace|earring|bracelet/.test(s)) return 'jewellery';
    if (/bag|scarf|hat|belt/.test(s)) return 'accessories';
    return null;
  }

  function matchCondition(v) {
    var s = norm(v);
    for (var i = 0; i < CONDITIONS.length; i++) {
      if (s === CONDITIONS[i].v || s === norm(CONDITIONS[i].label)) return CONDITIONS[i].v;
    }
    if (/tag/.test(s) && /no|without|removed/.test(s)) return 'new_no_tags';
    if (/^new/.test(s)) return 'new_with_tags';
    if (/as_new|unworn/.test(s)) return 'returned_as_new';
    if (/worn|tried/.test(s)) return 'returned_worn';
    if (/box|packag/.test(s)) return 'box_damaged';
    if (/fault|mark|flaw|second/.test(s)) return 'minor_fault';
    return null;
  }

  function isDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s)); }

  // Turns a whole sheet into rows ready to save, plus a list of
  // problems in plain words. Nothing is saved unless every row is
  // right — half an upload is harder to sort out than none.
  function rowsFromCSV(text) {
    var grid = parseCSV(text);
    if (!grid.length) return { items: [], problems: ['The file is empty.'] };
    var head = grid[0].map(norm);
    var idx = {};
    var aliases = {
      title: ['title', 'name', 'product', 'product_name'],
      category: ['category', 'type'],
      condition: ['condition', 'grade'],
      condition_note: ['condition_note', 'condition_notes', 'note', 'notes_on_condition'],
      size: ['size'], colour: ['colour', 'color'],
      quantity: ['quantity', 'qty', 'stock', 'how_many'],
      normal_price: ['normal_price', 'rrp', 'full_price', 'price'],
      lowest_price: ['lowest_price', 'lowest', 'minimum_price', 'min_price', 'floor'],
      your_code: ['your_code', 'sku', 'code', 'product_code'],
      description: ['description', 'details'],
      photo_links: ['photo_links', 'photos', 'photo', 'images', 'image'],
      available_until: ['available_until', 'until', 'end_date']
    };
    Object.keys(aliases).forEach(function (k) {
      for (var i = 0; i < head.length; i++) if (aliases[k].indexOf(head[i]) > -1) { idx[k] = i; return; }
    });

    var problems = [];
    if (idx.title === undefined) problems.push('There is no "title" column.');
    if (idx.lowest_price === undefined) problems.push('There is no "lowest_price" column — the lowest price you will accept.');
    if (idx.condition === undefined) problems.push('There is no "condition" column.');
    if (problems.length) return { items: [], problems: problems };

    var items = [];
    for (var r = 1; r < grid.length; r++) {
      var row = grid[r], line = 'Row ' + (r + 1) + ': ';
      var get = function (k) { return idx[k] === undefined ? '' : String(row[idx[k]] || '').trim(); };
      var title = get('title');
      if (!title) { problems.push(line + 'no title.'); continue; }

      var cond = matchCondition(get('condition'));
      if (!cond) problems.push(line + '"' + get('condition') + '" is not a condition we recognise.');
      var note = get('condition_note');
      if (cond && conditionNeedsNote(cond) && !note) problems.push(line + 'says what is wrong with it in condition_note.');

      var cat = matchCategory(get('category'));
      if (cat === null) problems.push(line + '"' + get('category') + '" is not a category we recognise.');

      var floor = toPence(get('lowest_price'));
      if (floor === null || isNaN(floor) || floor <= 0) problems.push(line + 'lowest_price "' + get('lowest_price') + '" is not a price.');
      var rrp = toPence(get('normal_price'));
      if (rrp !== null && (isNaN(rrp) || rrp <= 0)) problems.push(line + 'normal_price "' + get('normal_price') + '" is not a price.');
      if (rrp && floor && !isNaN(rrp) && !isNaN(floor) && floor > rrp) problems.push(line + 'the lowest price is above the normal price.');

      var qs = get('quantity'), qty = qs === '' ? 1 : Number(qs);
      if (!/^\d+$/.test(String(qty)) || qty < 1) problems.push(line + 'quantity "' + qs + '" is not a whole number of 1 or more.');

      var until = get('available_until');
      if (until && !isDate(until)) problems.push(line + 'available_until should look like 2026-12-31.');

      var photos = get('photo_links').split(/[\s|;]+/).filter(function (u) { return /^https:\/\//i.test(u); });

      items.push({
        title: title.slice(0, 200),
        category: cat || 'other',
        condition: cond,
        condition_note: note || null,
        size: get('size') || null,
        colour: get('colour') || null,
        quantity: qty,
        rrp_minor: rrp,
        floor_minor: floor,
        brand_sku: get('your_code') || null,
        description: get('description') || null,
        photos: photos,
        available_until: until || null
      });
    }
    if (!items.length && !problems.length) problems.push('There are no rows under the heading row.');
    return { items: problems.length ? [] : items, problems: problems };
  }

  var api = {
    CONDITIONS: CONDITIONS, CATEGORIES: CATEGORIES,
    ITEM_STATUS: ITEM_STATUS, ORDER_STATUS: ORDER_STATUS,
    conditionLabel: conditionLabel, categoryLabel: categoryLabel,
    conditionNeedsNote: conditionNeedsNote,
    money: money, toPence: toPence, payout: payout,
    parseCSV: parseCSV, rowsFromCSV: rowsFromCSV, csvTemplate: csvTemplate,
    CSV_COLUMNS: CSV_COLUMNS
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PacketOutlet = api;
})(this);
