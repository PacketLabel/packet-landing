// ============================================================
// Packet — the shop link: a brand's own Shopify shop → Packet Outlet
// Built from the AXRIK starter kit under licence. Kit v1.1.0.
// ============================================================
// Everything here is ordinary code with no network calls, so it can
// be checked by test/brand-shop.test.js without a shop or a database.
// netlify-functions/brand-shop.js does the talking.
//
// How a brand uses it, in their own Shopify admin:
//
//   packet-outlet              put this tag on a product to offer it on
//                              Packet Outlet. Every size/colour of it
//                              comes across as its own item.
//   packet-condition:<grade>   e.g. packet-condition:returned-as-new.
//                              Without it, the connection's default.
//   packet-note:<text>         what is wrong with it. Needed for
//                              tried on, packaging damaged, small fault.
//   packet-lowest:<£>          the least a customer may pay, e.g.
//                              packet-lowest:45. Without it, the
//                              connection's default % of their price.
//   packet-qty:<n>             offer at most this many, however many
//                              they hold.
//   packet-rp-confirmed        beauty only: they hold the UK Responsible
//                              Person role for it.
//
// Take the tag off, archive the product or sell out, and the Outlet
// follows within ten minutes.
// ============================================================

const crypto = require('crypto');

const DEFAULT_TAG = 'packet-outlet';
const SCOPES = 'read_products,read_inventory,write_inventory,read_locations';

const CONDITIONS = ['new_with_tags', 'new_no_tags', 'returned_as_new', 'returned_worn', 'box_damaged', 'minor_fault'];
const NEEDS_NOTE = { returned_worn: true, box_damaged: true, minor_fault: true };
const CATEGORIES = ['clothing', 'footwear', 'accessories', 'jewellery', 'beauty', 'home', 'kids', 'pets', 'other'];

// ── Shop addresses ─────────────────────────────────────────────
// "Hot Squash", "hotsquash", "https://hotsquash.myshopify.com/admin"
// all become "hotsquash.myshopify.com". A brand's public web address
// (hotsquash.com) is not the same thing and is refused, with a reason.
function normaliseShop(input) {
  let s = String(input || '').trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (/^admin\.shopify\.com$/.test(s)) {
    const m = String(input).match(/\/store\/([a-z0-9][a-z0-9-]*)/i);
    if (m) s = m[1].toLowerCase();
  }
  if (!/\./.test(s)) s = s + '.myshopify.com';
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(s) ? s : null;
}

// ── Shopify's signature on what it sends back ───────────────────
// Every redirect from Shopify carries an hmac of the other values,
// made with the app's secret. Anything without a matching one is a
// forgery and is refused.
function verifyQueryHmac(query, secret) {
  if (!query || !query.hmac || !secret) return false;
  const keys = Object.keys(query).filter(function (k) { return k !== 'hmac' && k !== 'signature'; }).sort();
  const val = function (k) { return Array.isArray(query[k]) ? query[k].join(',') : String(query[k]); };
  // Shopify's own libraries differ on whether values are URL-encoded
  // before signing (it matters for "host", which can end in "=").
  // Both are signed with the same secret, so either is genuine.
  const plain = keys.map(function (k) { return k + '=' + val(k); }).join('&');
  const encoded = new URLSearchParams(keys.map(function (k) { return [k, val(k)]; })).toString();
  const b = Buffer.from(String(query.hmac));
  return [plain, encoded].some(function (msg) {
    const a = Buffer.from(crypto.createHmac('sha256', secret).update(msg, 'utf8').digest('hex'));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}

function installUrl(shop, clientId, redirectUri, state) {
  return 'https://' + shop + '/admin/oauth/authorize?' + new URLSearchParams({
    client_id: clientId, scope: SCOPES, redirect_uri: redirectUri, state: state
  }).toString();
}

function newState() { return crypto.randomBytes(18).toString('hex'); }

// ── Reading the tags ────────────────────────────────────────────
function tagValue(tags, key) {
  const want = key.toLowerCase() + ':';
  for (const t of tags || []) {
    const s = String(t).trim();
    if (s.toLowerCase().indexOf(want) === 0) return s.slice(want.length).trim();
  }
  return null;
}
function hasTag(tags, name) {
  const n = String(name).toLowerCase();
  return (tags || []).some(function (t) { return String(t).trim().toLowerCase() === n; });
}

function conditionFrom(text) {
  if (!text) return null;
  const s = String(text).toLowerCase().replace(/[^a-z]+/g, '_').replace(/^_|_$/g, '');
  if (CONDITIONS.indexOf(s) > -1) return s;
  if (/tag/.test(s) && /no|removed|off/.test(s)) return 'new_no_tags';
  if (/^new/.test(s)) return 'new_with_tags';
  if (/as_new|unworn/.test(s)) return 'returned_as_new';
  if (/worn|tried/.test(s)) return 'returned_worn';
  if (/box|packag/.test(s)) return 'box_damaged';
  if (/fault|mark|flaw|second/.test(s)) return 'minor_fault';
  return null;
}

function categoryFrom(productType, tags, fallback) {
  const s = (String(productType || '') + ' ' + (tags || []).join(' ')).toLowerCase();
  if (/skin|hair|fragrance|perfume|make ?up|cosmetic|beauty|nail|serum|lip/.test(s)) return 'beauty';
  if (/shoe|boot|trainer|sneaker|sandal|heel|loafer/.test(s)) return 'footwear';
  if (/ring|necklace|earring|bracelet|jewel/.test(s)) return 'jewellery';
  if (/bag|scarf|hat|belt|glove|sunglass|purse|wallet/.test(s)) return 'accessories';
  if (/kid|child|baby|toddler/.test(s)) return 'kids';
  if (/\bpet|\bdog|\bcat\b|collar|lead/.test(s)) return 'pets';
  if (/home|mug|candle|cushion|throw|ceramic|kitchen/.test(s)) return 'home';
  if (/dress|top|shirt|jumper|cardigan|knit|coat|jacket|trouser|jean|skirt|tee|t-shirt|blouse|vest|hoodie|sweat|legging|short/.test(s)) return 'clothing';
  return CATEGORIES.indexOf(fallback) > -1 ? fallback : 'clothing';
}

// "45", "£45", "45.00" -> 4500. Anything else -> null.
function pence(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(/^£\s*/, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const parts = s.split('.');
  return parseInt(parts[0], 10) * 100 + (parts[1] ? parseInt((parts[1] + '0').slice(0, 2), 10) : 0);
}

function textFromHtml(html) {
  return String(html || '')
    .replace(/<\s*(br|\/p|\/li|\/h\d)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&rsquo;/g, '\'')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim().slice(0, 4000);
}

function option(variant, names) {
  for (const o of variant.selectedOptions || []) {
    if (names.indexOf(String(o.name).toLowerCase()) > -1 && o.value && o.value !== 'Default Title') return String(o.value);
  }
  return null;
}

// ── One Shopify variant → one Outlet item ─────────────────────────
// conn: { brand_id, default_condition, default_category, lowest_pct }
// Returns { item } or { skip: reason }.
function itemFromVariant(product, variant, conn) {
  const tags = product.tags || [];
  const name = product.title + (option(variant, ['size']) ? ' (' + option(variant, ['size']) + ')' : '');

  const price = pence(variant.price);
  const compare = pence(variant.compareAtPrice);
  const rrp = compare && price && compare > price ? compare : price;
  if (!rrp) return { skip: name + ': no price on it in your shop.' };

  let condition = conditionFrom(tagValue(tags, 'packet-condition')) || conn.default_condition || 'new_with_tags';
  if (CONDITIONS.indexOf(condition) === -1) condition = 'new_with_tags';
  const note = tagValue(tags, 'packet-note');

  let floor;
  const lowestTag = tagValue(tags, 'packet-lowest');
  if (lowestTag !== null) {
    floor = pence(lowestTag);
    if (!floor) return { skip: name + ': packet-lowest:' + lowestTag + ' is not a price.' };
  } else {
    const pct = Number(conn.lowest_pct);
    floor = Math.round(rrp * (isFinite(pct) && pct > 0 && pct <= 100 ? pct : 50) / 100);
  }
  if (floor > rrp) floor = rrp;
  if (floor < 100) floor = Math.min(100, rrp);

  const tracked = !variant.inventoryItem || variant.inventoryItem.tracked !== false;
  const capTag = tagValue(tags, 'packet-qty');
  const cap = capTag !== null && /^\d+$/.test(capTag) ? parseInt(capTag, 10) : null;
  let qty;
  if (tracked) qty = Math.max(0, variant.inventoryQuantity | 0);
  else if (cap !== null) qty = cap;
  else return { skip: name + ': your shop does not count stock for it, so add a packet-qty tag to say how many.' };
  if (cap !== null) qty = Math.min(qty, cap);

  const photos = ((product.images && product.images.nodes) || [])
    .map(function (i) { return i.url; })
    .filter(function (u) { return typeof u === 'string' && /^https:\/\//i.test(u); })
    .slice(0, 8);

  return {
    item: {
      brand_id: conn.brand_id,
      source: conn.platform === 'woocommerce' ? 'woocommerce' : 'shopify',
      source_ref: variant.id,
      source_inventory_ref: variant.inventoryItem ? variant.inventoryItem.id : null,
      title: String(product.title).slice(0, 200),
      description: textFromHtml(product.descriptionHtml) || null,
      category: categoryFrom(product.productType, tags, conn.default_category),
      brand_sku: variant.sku || null,
      size: option(variant, ['size']),
      colour: option(variant, ['colour', 'color']),
      condition: condition,
      condition_note: note || null,
      quantity: qty,
      rrp_minor: rrp,
      floor_minor: floor,
      photos: photos,
      uk_rp_confirmed: hasTag(tags, 'packet-rp-confirmed')
    },
    needsNote: !!NEEDS_NOTE[condition] && !note
  };
}

// ── What a sync run changes ──────────────────────────────────────
// products: tagged, active products from the brand's shop
// existing: this brand's outlet_items that came from the shop
// pending:  { itemId: units sold on Packet not yet taken off their shop }
//
// New variants arrive as "With Packet" so Packet can check and price
// them. A beauty item without the Responsible Person tag, or a faulty
// one without a note, arrives as "Not sent yet" with the reason, for
// the brand to finish.
//
// Existing items: only what actually changed is written, because every
// write tells Packet's own shop the item changed. Wording and photos
// are written once (Decision 3); after that the brand edits them here
// or Packet edits them in Shopify.
function planSync(products, existing, conn, pending) {
  const byRef = {};
  (existing || []).forEach(function (e) { if (e.source_ref) byRef[e.source_ref] = e; });
  const plan = { inserts: [], updates: [], warnings: [], seen: 0 };
  const seenRefs = {};

  (products || []).forEach(function (p) {
    ((p.variants && p.variants.nodes) || []).forEach(function (v) {
      const r = itemFromVariant(p, v, conn);
      if (r.skip) { plan.warnings.push(r.skip); return; }
      const it = r.item;
      seenRefs[it.source_ref] = true; plan.seen++;
      const old = byRef[it.source_ref];
      const held = old ? (pending && pending[old.id]) || 0 : 0;
      it.quantity = Math.max(0, it.quantity - held);

      if (!old) {
        if (it.quantity === 0) return;           // nothing to sell yet; it comes across when stock does
        const why = it.category === 'beauty' && !it.uk_rp_confirmed
          ? 'beauty products need the packet-rp-confirmed tag (you hold the UK Responsible Person role)'
          : r.needsNote ? 'say what is wrong with it with a packet-note: tag, or tick it off here' : null;
        it.status = why ? 'draft' : 'submitted';
        if (why) plan.warnings.push(it.title + (it.size ? ' (' + it.size + ')' : '') + ' is waiting for you: ' + why + '.');
        plan.inserts.push(it);
        return;
      }

      const patch = {};
      if (old.quantity !== it.quantity) patch.quantity = it.quantity;
      if (old.rrp_minor !== it.rrp_minor) patch.rrp_minor = it.rrp_minor;
      if (old.condition !== it.condition) patch.condition = it.condition;
      if ((old.condition_note || null) !== (it.condition_note || null) && it.condition_note) patch.condition_note = it.condition_note;
      if (it.uk_rp_confirmed && !old.uk_rp_confirmed) patch.uk_rp_confirmed = true;
      if (old.brand_sku !== it.brand_sku && it.brand_sku) patch.brand_sku = it.brand_sku;
      if (old.floor_minor !== it.floor_minor) {
        if (old.sale_minor && it.floor_minor > old.sale_minor) {
          plan.warnings.push(old.title + (old.size ? ' (' + old.size + ')' : '') + ': your lowest price is now above the price it is on sale for, so it has been left as it was. Ask Packet to change the price.');
        } else patch.floor_minor = it.floor_minor;
      }
      if (Object.keys(patch).length) plan.updates.push({ id: old.id, patch: patch });
    });
  });

  // Untagged, archived or deleted in their shop: nothing left to sell.
  (existing || []).forEach(function (e) {
    if (e.source_ref && !seenRefs[e.source_ref] && e.quantity !== 0) plan.updates.push({ id: e.id, patch: { quantity: 0 } });
  });
  return plan;
}

// ── Taking a Packet sale off the brand's own stock ────────────────
// The location to take it from: the one holding most of it.
function pickLocation(levels) {
  let best = null;
  (levels || []).forEach(function (l) {
    const q = ((l.quantities || [])[0] || {}).quantity;
    const n = typeof q === 'number' ? q : -Infinity;
    if (!best || n > best.n) best = { id: l.location && l.location.id, n: n };
  });
  return best && best.id ? best.id : null;
}

// ── WooCommerce ────────────────────────────────────────────────
// The same tags, the same rules: a WooCommerce product is turned into
// the shape Shopify gives us, so itemFromVariant and planSync work on
// both without knowing the difference.
//
// Refs: 'woo:p:<product>' for a simple product, 'woo:v:<product>:<variation>'
// for one size/colour of a variable one. Stock refs drop the 'woo:'.

// "brand.com", "https://www.brand.com/shop/" -> "https://www.brand.com/shop"
// WordPress can live in a folder, so the path is kept. https only:
// WooCommerce will not hand keys to a site without it.
function normaliseSite(input) {
  let s = String(input || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:') return null;
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname)) return null;
    const path = u.pathname.replace(/\/(wp-admin|wp-json|shop)(\/.*)?$/i, '').replace(/\/+$/, '');
    return 'https://' + u.hostname.toLowerCase() + (u.port ? ':' + u.port : '') + path;
  } catch (e) { return null; }
}

// WooCommerce's own "approve this app" screen. It posts the keys to
// callbackUrl and sends the brand back to returnUrl.
function wooAuthUrl(site, state, returnUrl, callbackUrl) {
  return site + '/wc-auth/v1/authorize?' + new URLSearchParams({
    app_name: 'Packet Outlet', scope: 'read_write', user_id: state,
    return_url: returnUrl, callback_url: callbackUrl
  }).toString();
}

function tagSlug(tag) { return String(tag || DEFAULT_TAG).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

function wooVariant(p, v, parentStock) {
  const isVar = !!v;
  const src = v || p;
  const onSale = src.sale_price !== undefined && src.sale_price !== null && String(src.sale_price) !== '';
  const ms = src.manage_stock;
  let invRef = null, tracked = true, qty = null;
  if (ms === true) { invRef = isVar ? 'v:' + p.id + ':' + v.id : 'p:' + p.id; qty = src.stock_quantity; }
  else if (ms === 'parent' && isVar) { invRef = 'p:' + p.id; qty = parentStock; }
  else tracked = false;
  return {
    id: isVar ? 'woo:v:' + p.id + ':' + v.id : 'woo:p:' + p.id,
    sku: src.sku || (isVar ? p.sku : null) || null,
    price: src.price !== undefined && src.price !== '' ? src.price : src.regular_price,
    compareAtPrice: onSale ? src.regular_price : null,
    inventoryQuantity: qty === null || qty === undefined ? 0 : qty,
    selectedOptions: isVar ? (v.attributes || []).map(function (a) { return { name: a.name, value: a.option }; }) : [],
    inventoryItem: { id: invRef, tracked: tracked }
  };
}

// products: WooCommerce products (already filtered to the tag)
// variations: { productId: [variation, ...] } for the variable ones
function wooToProducts(products, variations) {
  return (products || []).filter(function (p) { return p.status === undefined || p.status === 'publish'; }).map(function (p) {
    const imgs = (p.images || []).map(function (i) { return { url: i.src }; });
    const nodes = p.type === 'variable'
      ? ((variations && variations[p.id]) || [])
          .filter(function (v) { return v.status === undefined || v.status === 'publish'; })
          .map(function (v) { return wooVariant(p, v, p.manage_stock === true ? p.stock_quantity : null); })
      : [wooVariant(p, null)];
    return {
      id: 'woo:' + p.id,
      title: p.name,
      productType: (p.categories || []).map(function (c) { return c.name; }).join(' '),
      tags: (p.tags || []).map(function (t) { return t.name; }),
      descriptionHtml: p.description || p.short_description || '',
      images: { nodes: imgs },
      variants: { nodes: nodes }
    };
  });
}

// 'p:12' -> { product: 12 }   'v:12:34' -> { product: 12, variation: 34 }
function wooRef(ref) {
  const m = String(ref || '').match(/^(?:woo:)?([pv]):(\d+)(?::(\d+))?$/);
  if (!m) return null;
  return m[1] === 'v' ? { product: +m[2], variation: +m[3] } : { product: +m[2] };
}

module.exports = {
  CONDITIONS, CATEGORIES, normaliseSite, wooAuthUrl, tagSlug, wooToProducts, wooRef,
  DEFAULT_TAG, SCOPES, normaliseShop, verifyQueryHmac, installUrl, newState,
  tagValue, hasTag, conditionFrom, categoryFrom, pence, textFromHtml,
  itemFromVariant, planSync, pickLocation
};
