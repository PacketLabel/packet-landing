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
    // Some shops export tab-separated files. Decide from the heading row.
    var firstLine = text.split('\n')[0] || '';
    var sep = firstLine.split('\t').length > firstLine.split(',').length ? '\t' : ',';
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
      if (ch === sep) { row.push(field); field = ''; i++; continue; }
      if (ch === '\r') { i++; continue; }
      if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
      field += ch; i++;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (c) { return String(c).trim() !== ''; }); });
  }

  var CSV_COLUMNS = ['title', 'category', 'condition', 'condition_note', 'size', 'colour',
                     'quantity', 'normal_price', 'lowest_price', 'outlet_price', 'your_code', 'description',
                     'photo_links', 'available_until', 'uk_responsible_person'];

  function csvTemplate() {
    return CSV_COLUMNS.join(',') + '\n' +
      '"Recycled wool cardigan",clothing,returned_as_new,,M,Olive,1,89.00,45.00,62.00,SS-CARD-OL-M,' +
      '"Returned unworn, tags attached",https://example.com/photo1.jpg,\n';
  }

  // Header names are matched loosely: "Lowest price", "lowest_price"
  // and "LOWEST PRICE (£)" are all the same column.
  function norm(h) { return String(h || '').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''); }

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

  // Same reading as the shop link (brand-shop-core.js categoryFrom), for
  // the category names a shop export uses ("Womens > Dresses").
  // The same sum as outlet_suggest_minor() in 017: pct off the normal
  // price, rounded down to the 50p, never below the lowest.
  function outletPrice(rrp, floor, pct) {
    if (pct === null || pct === undefined || pct === '' || isNaN(Number(pct))) return null;
    if (!rrp) return floor;
    return Math.max(floor, Math.floor(rrp * (100 - Number(pct)) / 100 / 50) * 50);
  }

  function guessCategory(text) {
    var s = String(text || '').toLowerCase();
    if (/skin|hair|fragrance|perfume|make ?up|cosmetic|beauty|nail|serum|lip/.test(s)) return 'beauty';
    if (/shoe|boot|trainer|sneaker|sandal|heel|loafer/.test(s)) return 'footwear';
    if (/ring|necklace|earring|bracelet|jewel/.test(s)) return 'jewellery';
    if (/bag|tote|scarf|hats?\b|beanie|\bcap\b|belt|glove|sunglass|purse|wallet|card holder/.test(s)) return 'accessories';
    if (/kid|child|baby|toddler/.test(s)) return 'kids';
    if (/\bpet|\bdog|\bcat\b|collar/.test(s)) return 'pets';
    if (/home|mug|candle|cushion|throw|ceramic|kitchen/.test(s)) return 'home';
    if (/dress|top|shirt|jumper|cardigan|knit|coat|jacket|trouser|jean|skirt|tee|blouse|vest|hoodie|sweat|legging|short|cloth|apparel/.test(s)) return 'clothing';
    return null;
  }

  function isDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s)); }

  // ── A shop's own product export ─────────────────────────────
  // Added 4 November 2026 so a brand on ANY shop can join without a
  // link built for their platform: they export their products from
  // their own shop admin and upload the file as it comes. Shopify,
  // WooCommerce, Wix, Squarespace, Etsy and BigCommerce exports are
  // recognised by their headings and turned into Packet's columns;
  // condition and lowest price come from the defaults the brand
  // chooses on the upload screen. Anything else falls back to the
  // loose column matching below.
  var SHOPS = { shopify: 'Shopify', woocommerce: 'WooCommerce', wix: 'Wix', squarespace: 'Squarespace', etsy: 'Etsy', bigcommerce: 'BigCommerce' };

  function stripHtml(h) {
    return String(h || '').replace(/<\s*(br|\/p|\/li|\/h\d)\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;|&rsquo;/g, '\'').replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim().slice(0, 2000);
  }
  function urls(v) { return String(v || '').split(/[\s|;,]+/).filter(function (u) { return /^https:\/\//i.test(u); }); }

  function detectShop(head) {
    var has = function (h) { return head.indexOf(h) > -1; };
    if (has('handle') && has('variant_price')) return 'shopify';
    if (has('handleid') && has('fieldtype')) return 'wix';
    if (has('regular_price') && (has('name') || has('sku'))) return 'woocommerce';
    if (has('product_page') || has('hosted_image_urls')) return 'squarespace';
    if (has('currency_code') && has('quantity') && (has('image1') || has('variation_1_type'))) return 'etsy';
    if (has('product_name') && (has('item_type') || has('current_stock_level'))) return 'bigcommerce';
    return null;
  }

  // option name + value -> size / colour, or something to add to the title
  function applyOption(out, name, value) {
    var n = String(name || '').toLowerCase(), v = String(value || '').trim();
    if (!v || v === 'Default Title') return;
    if (/size/.test(n)) out.size = v;
    else if (/colou?r|shade/.test(n)) out.colour = v;
    else out.extra = (out.extra ? out.extra + ', ' : '') + v;
  }

  // Returns { format, rows: [{ title, size, colour, quantity, normal_price,
  // your_code, description, photo_links, category, _row }], problems }
  function readShopExport(grid) {
    var head = grid[0].map(norm);
    var format = detectShop(head);
    if (!format) return null;
    var col = {}; head.forEach(function (h, i) { if (col[h] === undefined) col[h] = i; });
    var get = function (row, h) { return col[h] === undefined ? '' : String(row[col[h]] || '').trim(); };
    var out = [], problems = [], parents = {};

    function push(r, o) {
      var title = o.title + (o.extra ? ' (' + o.extra + ')' : '');
      out.push({ title: title, size: o.size || '', colour: o.colour || '', quantity: o.quantity, normal_price: o.price,
        your_code: o.sku || '', description: o.description || '', _photos: o.photos || [],
        category: o.category || '', _row: r + 1 });
    }
    function pickPrice(price, compare) {
      var p = toPence(price), c = toPence(compare);
      var best = c && p && c > p ? compare : price;
      return String(best || '').trim();
    }

    for (var r = 1; r < grid.length; r++) {
      var row = grid[r];
      var o = {};
      if (format === 'shopify') {
        var h = get(row, 'handle');
        if (!h) continue;
        var par = parents[h] || (parents[h] = { title: '', description: '', category: '', photos: [], on1: '', on2: '', on3: '', status: '' });
        if (get(row, 'title')) {
          par.title = get(row, 'title'); par.description = stripHtml(get(row, 'body'));
          par.category = get(row, 'type') + ' ' + get(row, 'product_category') + ' ' + get(row, 'tags');
          par.on1 = get(row, 'option1_name'); par.on2 = get(row, 'option2_name'); par.on3 = get(row, 'option3_name');
          par.status = get(row, 'status').toLowerCase();
        }
        urls(get(row, 'image_src')).concat(urls(get(row, 'variant_image'))).forEach(function (u) { if (par.photos.indexOf(u) === -1) par.photos.push(u); });
        if (!get(row, 'variant_price')) continue;        // an image-only row
        if (par.status === 'archived') continue;
        o.title = par.title; o.description = par.description; o.category = par.category; o.photos = par.photos;
        applyOption(o, par.on1, get(row, 'option1_value')); applyOption(o, par.on2, get(row, 'option2_value')); applyOption(o, par.on3, get(row, 'option3_value'));
        o.price = pickPrice(get(row, 'variant_price'), get(row, 'variant_compare_at_price'));
        o.quantity = get(row, 'variant_inventory_qty');
        o.sku = get(row, 'variant_sku') || (h + (o.size ? '/' + o.size : '') + (o.colour ? '/' + o.colour : '') + (o.extra ? '/' + o.extra : ''));
      } else if (format === 'woocommerce') {
        var type = get(row, 'type').toLowerCase();
        var id = get(row, 'id'), sku = get(row, 'sku');
        var rec = { title: get(row, 'name'), description: stripHtml(get(row, 'description') || get(row, 'short_description')),
          category: get(row, 'categories') + ' ' + get(row, 'tags'), photos: urls(get(row, 'images')) };
        if (/variable/.test(type)) { if (id) parents['id:' + id] = rec; if (sku) parents[sku] = rec; continue; }
        var parent = /variation/.test(type) ? (parents[get(row, 'parent')] || parents['id:' + get(row, 'parent').replace(/^id:/, '')]) : null;
        if (/variation/.test(type) && parent) {
          o.title = parent.title; o.description = parent.description; o.category = parent.category;
          o.photos = rec.photos.length ? rec.photos.concat(parent.photos) : parent.photos;
        } else { o.title = rec.title; o.description = rec.description; o.category = rec.category; o.photos = rec.photos; }
        for (var a = 1; a <= 3; a++) applyOption(o, get(row, 'attribute_' + a + '_name'), get(row, 'attribute_' + a + '_value'));
        o.price = pickPrice(get(row, 'sale_price') || get(row, 'regular_price'), get(row, 'regular_price'));
        o.quantity = get(row, 'stock');
        if (o.quantity === '' && /^(0|no|out)/i.test(get(row, 'in_stock'))) o.quantity = '0';
        o.sku = sku || ('woo-' + id);
      } else if (format === 'wix') {
        var hid = get(row, 'handleid'), ft = get(row, 'fieldtype').toLowerCase();
        if (ft === 'product') {
          parents[hid] = { title: get(row, 'name'), description: stripHtml(get(row, 'description')), category: get(row, 'collection'),
            photos: urls(get(row, 'productimageurl')), price: get(row, 'price'), on1: get(row, 'productoptionname1'), on2: get(row, 'productoptionname2'),
            sku: get(row, 'sku'), inventory: get(row, 'inventory'), hasVariants: false, row: r };
          continue;
        }
        var wp = parents[hid]; if (!wp) continue;
        wp.hasVariants = true;
        o.title = wp.title; o.description = wp.description; o.category = wp.category; o.photos = wp.photos;
        applyOption(o, wp.on1, get(row, 'productoptiondescription1')); applyOption(o, wp.on2, get(row, 'productoptiondescription2'));
        var base = toPence(wp.price) || 0, sur = toPence(get(row, 'surcharge')) || 0;
        o.price = base ? ((base + sur) / 100).toFixed(2) : '';
        o.quantity = /^\d+$/.test(get(row, 'inventory')) ? get(row, 'inventory') : (/out/i.test(get(row, 'inventory')) ? '0' : '');
        o.sku = get(row, 'sku') || (hid + '/' + (o.size || o.colour || o.extra || r));
      } else if (format === 'squarespace') {
        var pid = get(row, 'product_id');
        var sp = parents[pid] || (parents[pid] = { title: '', description: '', category: '', photos: [] });
        if (get(row, 'title')) {
          sp.title = get(row, 'title'); sp.description = stripHtml(get(row, 'description'));
          sp.category = get(row, 'categories') + ' ' + get(row, 'tags'); sp.photos = urls(get(row, 'hosted_image_urls'));
          sp.on = [get(row, 'option_name_1'), get(row, 'option_name_2'), get(row, 'option_name_3')];
        }
        if (!sp.title) continue;
        o.title = sp.title; o.description = sp.description; o.category = sp.category; o.photos = sp.photos;
        for (var k = 1; k <= 3; k++) applyOption(o, (sp.on || [])[k - 1], get(row, 'option_value_' + k));
        var onSale = /^(yes|true|1)$/i.test(get(row, 'on_sale'));
        o.price = pickPrice(onSale ? get(row, 'sale_price') : get(row, 'price'), get(row, 'price'));
        o.quantity = /unlimited/i.test(get(row, 'stock')) ? '' : get(row, 'stock');
        o.sku = get(row, 'sku') || (pid + '/' + (o.size || o.colour || o.extra || r));
      } else if (format === 'etsy') {
        var cur = get(row, 'currency_code').toUpperCase();
        if (cur && cur !== 'GBP') { problems.push('Row ' + (r + 1) + ': priced in ' + cur + '. Packet Outlet sells in pounds — change the prices to £ in the file first.'); continue; }
        o.title = get(row, 'title'); o.description = stripHtml(get(row, 'description')); o.category = get(row, 'tags');
        o.photos = []; for (var im = 1; im <= 10; im++) o.photos = o.photos.concat(urls(get(row, 'image' + im)));
        o.price = get(row, 'price'); o.quantity = get(row, 'quantity');
        o.sku = get(row, 'sku') || ('etsy-' + r);
      } else if (format === 'bigcommerce') {
        var it = get(row, 'item_type').toLowerCase();
        if (it && it !== 'product') continue;
        o.title = get(row, 'product_name'); o.description = stripHtml(get(row, 'product_description')); o.category = get(row, 'category');
        o.photos = []; for (var bi = 1; bi <= 8; bi++) o.photos = o.photos.concat(urls(get(row, 'product_image_url_' + bi)), urls(get(row, 'product_image_file_' + bi)));
        o.price = pickPrice(get(row, 'sale_price') || get(row, 'price'), get(row, 'retail_price') || get(row, 'price'));
        o.quantity = get(row, 'current_stock_level');
        o.sku = get(row, 'product_code_sku') || get(row, 'product_sku') || get(row, 'sku') || ('bc-' + get(row, 'product_id'));
      }
      if (!o.title) continue;
      if (o.quantity !== '' && o.quantity !== undefined && !/^-?\d+$/.test(String(o.quantity))) o.quantity = '';
      if (/^-/.test(String(o.quantity))) o.quantity = '0';
      push(r, o);
    }
    // Wix products with no variant rows are one item each.
    if (format === 'wix') Object.keys(parents).forEach(function (hid) {
      var wp = parents[hid]; if (wp.hasVariants) return;
      push(wp.row, { title: wp.title, description: wp.description, category: wp.category, photos: wp.photos, price: wp.price,
        quantity: /^\d+$/.test(wp.inventory) ? wp.inventory : (/out/i.test(wp.inventory) ? '0' : ''), sku: wp.sku || hid });
    });
    // Joined at the end: Shopify lists extra photos on rows after the variants.
    out.forEach(function (x) { x.photo_links = x._photos.slice(0, 8).join(' '); delete x._photos; });
    out.sort(function (a, b) { return a._row - b._row; });
    return { format: format, rows: out, problems: problems };
  }

  // Turns a whole sheet into rows ready to save, plus a list of
  // problems in plain words. Nothing is saved unless every row is
  // right — half an upload is harder to sort out than none.
  //
  // opts (optional, for shop exports and sheets without every column):
  //   { default_condition, default_category, lowest_pct, default_quantity }
  // Without opts, condition and lowest_price columns are required, as before.
  function rowsFromCSV(text, opts) {
    var grid = parseCSV(text);
    if (!grid.length) return { items: [], problems: ['The file is empty.'] };
    var exp = readShopExport(grid);
    var format = null, exportProblems = [];
    if (exp) {
      format = exp.format; exportProblems = exp.problems;
      grid = [['title', 'size', 'colour', 'quantity', 'normal_price', 'your_code', 'description', 'photo_links', 'category', '_row']]
        .concat(exp.rows.map(function (x) { return [x.title, x.size, x.colour, x.quantity, x.normal_price, x.your_code, x.description, x.photo_links, x.category, x._row]; }));
      if (grid.length === 1) return { items: [], problems: exportProblems.length ? exportProblems : ['We read that as a ' + SHOPS[format] + ' export, but found no products in it.'], format: format };
    }
    var res = rowsFromGrid(grid, opts || null, !!exp);
    res.format = format;
    if (exportProblems.length) { res.problems = exportProblems.concat(res.problems); res.items = []; }
    return res;
  }

  function rowsFromGrid(grid, opts, fromExport) {
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
      // The brand's asking price on the Outlet (018). Optional.
      outlet_price: ['outlet_price', 'your_outlet_price', 'packet_price', 'outlet'],
      your_code: ['your_code', 'sku', 'code', 'product_code'],
      description: ['description', 'details'],
      photo_links: ['photo_links', 'photos', 'photo', 'images', 'image'],
      available_until: ['available_until', 'until', 'end_date'],
      uk_rp: ['uk_responsible_person', 'responsible_person', 'uk_rp', 'rp']
    };
    Object.keys(aliases).forEach(function (k) {
      for (var i = 0; i < head.length; i++) if (aliases[k].indexOf(head[i]) > -1) { idx[k] = i; return; }
    });

    var problems = [];
    var defCond = opts && matchCondition(opts.default_condition);
    var pct = opts ? Number(opts.lowest_pct) : NaN;
    var hasPct = isFinite(pct) && pct > 0 && pct <= 100;
    if (idx.title === undefined) problems.push('There is no "title" column.');
    if (idx.lowest_price === undefined && !hasPct) problems.push('There is no "lowest_price" column — the lowest price you will accept.');
    if (idx.condition === undefined && !defCond) problems.push('There is no "condition" column.');
    if (problems.length) return { items: [], problems: problems };
    var rowCol = head.indexOf('_row');

    var items = [], seenCodes = {};
    for (var r = 1; r < grid.length; r++) {
      var row = grid[r];
      var rowNo = rowCol > -1 && row[rowCol] ? Number(row[rowCol]) : r + 1;
      var line = 'Row ' + rowNo + ': ';
      var get = function (k) { return idx[k] === undefined ? '' : String(row[idx[k]] || '').trim(); };
      var title = get('title');
      if (!title) { problems.push(line + 'no title.'); continue; }

      var cond = get('condition') ? matchCondition(get('condition')) : defCond;
      if (!cond) problems.push(line + '"' + get('condition') + '" is not a condition we recognise.');
      var note = get('condition_note');
      if (cond && conditionNeedsNote(cond) && !note) problems.push(line + 'says what is wrong with it in condition_note.');

      var cat = matchCategory(get('category'));
      // A shop's own export has its own category names; guess, then fall back.
      if (fromExport) cat = guessCategory(get('category') + ' ' + title) || (opts && opts.default_category && matchCategory(opts.default_category)) || 'other';
      if (cat === null) problems.push(line + '"' + get('category') + '" is not a category we recognise.');

      var rrpEarly = toPence(get('normal_price'));
      var floor = get('lowest_price') === '' && hasPct
        ? (rrpEarly && !isNaN(rrpEarly) ? Math.max(100, Math.round(rrpEarly * pct / 100)) : null)
        : toPence(get('lowest_price'));
      if (floor === null && get('lowest_price') === '' && hasPct) { problems.push(line + 'has no price, so we cannot work out its lowest price.'); continue; }
      if (floor === null || isNaN(floor) || floor <= 0) problems.push(line + 'lowest_price "' + get('lowest_price') + '" is not a price.');
      var rrp = toPence(get('normal_price'));
      if (rrp !== null && (isNaN(rrp) || rrp <= 0)) problems.push(line + 'normal_price "' + get('normal_price') + '" is not a price.');
      if (rrp && floor && !isNaN(rrp) && !isNaN(floor) && floor > rrp) problems.push(line + 'the lowest price is above the normal price.');

      // 0 is allowed: on a re-upload it means "sold out elsewhere".
      var defQty = opts && /^\d+$/.test(String(opts.default_quantity || '')) ? String(opts.default_quantity) : '1';
      var qs = get('quantity'), qty = qs === '' ? Number(defQty) : Number(qs);
      if (!/^\d+$/.test(qs === '' ? defQty : qs)) problems.push(line + 'quantity "' + qs + '" is not a whole number.');

      var code = get('your_code');
      if (code) {
        var key = code.toLowerCase();
        if (seenCodes[key]) problems.push(line + 'your_code "' + code + '" is also on row ' + seenCodes[key] + '. Each code can only appear once.');
        else seenCodes[key] = r + 1;
      }

      var until = get('available_until');
      if (until && !isDate(until)) problems.push(line + 'available_until should look like 2026-12-31.');

      var photos = get('photo_links').split(/[\s|;]+/).filter(function (u) { return /^https:\/\//i.test(u); });

      var bp = get('outlet_price') ? toPence(get('outlet_price')) : null;
      if (bp !== null && (isNaN(bp) || bp <= 0)) { problems.push(line + 'outlet_price "' + get('outlet_price') + '" is not a price.'); bp = null; }
      if (bp && floor && !isNaN(floor) && bp < floor) problems.push(line + 'the outlet price is below your lowest price.');

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
        available_until: until || null,
        uk_rp_confirmed: /^(y|yes|true|1|x)$/i.test(get('uk_rp')),
        _row: rowNo
      });
      if (bp) items[items.length - 1].brand_price_minor = bp;
    }
    if (!items.length && !problems.length) problems.push('There are no rows under the heading row.');
    return { items: problems.length ? [] : items, problems: problems };
  }

  // ── What an upload will do ──────────────────────────────────
  // A brand keeps one sheet and uploads it again whenever stock
  // changes. A row whose your_code matches an item already in the
  // account updates that item; anything else is a new item. So the
  // sheet never makes duplicates, and a quantity of 0 marks a thing
  // sold out without anyone opening it.
  //
  // send = true: new items, and matched items still "not sent yet",
  // go straight to Packet. Items the brand took back or Packet turned
  // down are updated but left as they are — re-uploading the whole
  // sheet should not undo either decision.
  //
  // Beauty without the Responsible Person confirmation is never sent;
  // it is kept as not sent, and counted so the page can say so.
  function planUpload(items, existing, send) {
    var byCode = {};
    var rank = { live: 0, paused: 1, submitted: 2, draft: 3, rejected: 4, withdrawn: 5 };
    (existing || []).forEach(function (e) {
      if (!e.brand_sku) return;
      var k = String(e.brand_sku).trim().toLowerCase();
      var cur = byCode[k];
      if (!cur || (rank[e.status] || 9) < (rank[cur.status] || 9)) byCode[k] = e;
    });

    var plan = { adds: [], updates: [], soldOut: 0, skipped: [], held: 0, notResent: 0, problems: [] };
    items.forEach(function (it) {
      var line = 'Row ' + it._row + ': ';
      var row = {};
      Object.keys(it).forEach(function (k) { if (k.charAt(0) !== '_') row[k] = it[k]; });
      var rpOk = row.category !== 'beauty' || row.uk_rp_confirmed;
      var old = row.brand_sku ? byCode[String(row.brand_sku).trim().toLowerCase()] : null;

      if (!old) {
        if (row.quantity === 0) { plan.skipped.push(row.title); return; }
        row.status = send && rpOk ? 'submitted' : 'draft';
        if (send && !rpOk) plan.held++;
        plan.adds.push(row);
        return;
      }

      // Keep what the sheet does not say. Photos uploaded in the form
      // are not in the sheet, and a blank tick box is not a "no".
      if (!row.photos.length) delete row.photos;
      if (!row.uk_rp_confirmed) delete row.uk_rp_confirmed;
      var rpNow = row.category !== 'beauty' || row.uk_rp_confirmed || old.uk_rp_confirmed;

      if (old.sale_minor && row.floor_minor > old.sale_minor) {
        plan.problems.push(line + 'the lowest price ' + money(row.floor_minor) + ' is above the ' +
          money(old.sale_minor) + ' it is on sale for. Ask Packet to change the price, or take it back.');
        return;
      }
      if (old.status === 'draft' && send && row.quantity > 0) {
        if (rpNow) row.status = 'submitted'; else plan.held++;
      }
      if ((old.status === 'withdrawn' || old.status === 'rejected') && send) plan.notResent++;
      if (row.quantity === 0 && old.quantity !== 0) plan.soldOut++;
      plan.updates.push({ id: old.id, row: row });
    });
    if (plan.problems.length) { plan.adds = []; plan.updates = []; }
    return plan;
  }

  // Sizes of one thing share one product in the shop. Same rule as
  // netlify-functions/_shared/outlet-shopify-core.js groupKey (checked
  // against it in test/shopify-sizes-flow.test.js).
  var GROUPABLE = { new_with_tags: true, new_no_tags: true, returned_as_new: true };
  function groupKey(item) {
    if (!item || !item.brand_id || !String(item.size || '').trim()) return null;
    if (!GROUPABLE[item.condition] || String(item.condition_note || '').trim()) return null;
    var n = function (v) { return String(v || '').toLowerCase().replace(/\s+/g, ' ').trim(); };
    return [item.brand_id, n(item.title), n(item.colour), item.condition].join('|');
  }
  // 6, 8, 10 / XS, S, M, L / anything else as it came.
  var LETTER = ['xxxs', 'xxs', 'xs', 's', 'm', 'l', 'xl', 'xxl', 'xxxl', '2xl', '3xl'];
  function sizeOrder(a, b) {
    var x = String(a || '').trim().toLowerCase(), y = String(b || '').trim().toLowerCase();
    var nx = parseFloat(x), ny = parseFloat(y);
    if (!isNaN(nx) && !isNaN(ny) && nx !== ny) return nx - ny;
    var lx = LETTER.indexOf(x), ly = LETTER.indexOf(y);
    if (lx > -1 && ly > -1) return lx - ly;
    return 0;
  }

  var api = {
    planUpload: planUpload, groupKey: groupKey, sizeOrder: sizeOrder,
    CONDITIONS: CONDITIONS, CATEGORIES: CATEGORIES,
    ITEM_STATUS: ITEM_STATUS, ORDER_STATUS: ORDER_STATUS,
    conditionLabel: conditionLabel, categoryLabel: categoryLabel,
    conditionNeedsNote: conditionNeedsNote,
    money: money, toPence: toPence, payout: payout,
    parseCSV: parseCSV, rowsFromCSV: rowsFromCSV, csvTemplate: csvTemplate,
    readShopExport: readShopExport, SHOPS: SHOPS, outletPrice: outletPrice,
    CSV_COLUMNS: CSV_COLUMNS
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PacketOutlet = api;
})(this);
