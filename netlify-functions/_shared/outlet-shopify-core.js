// ============================================================
// Packet — Outlet ↔ Shopify: the plain parts
// Built from the AXRIK starter kit under licence. Kit v1.1.0.
// ============================================================
// Everything here is ordinary code with no network calls, so it can
// be checked by test/shopify.test.js without a shop or a database.
// The two functions that use it are outlet-shopify.js (stock out to
// the shop) and shopify-webhook.js (orders back in).
// ============================================================

const crypto = require('crypto');

// Every Outlet item carries this in its Shopify SKU, followed by its id
// in our database. It is how an order line is matched back to the
// brand's stock, and it never clashes with AW Dropship's own SKUs.
const SKU_PREFIX = 'PKO-';

const CONDITION_LABELS = {
  new_with_tags: 'New, with tags',
  new_no_tags: 'New, tags removed',
  returned_as_new: 'Returned, as new',
  returned_worn: 'Returned, tried on or worn',
  box_damaged: 'Packaging damaged',
  minor_fault: 'Small fault'
};

const CATEGORY_LABELS = {
  clothing: 'Clothing', footwear: 'Footwear', accessories: 'Accessories',
  jewellery: 'Jewellery', beauty: 'Beauty', home: 'Home', kids: 'Kids',
  pets: 'Pets', other: 'Other'
};

function skuFor(itemId) { return SKU_PREFIX + itemId; }

function itemIdFromSku(sku) {
  if (!sku || typeof sku !== 'string' || sku.indexOf(SKU_PREFIX) !== 0) return null;
  const id = sku.slice(SKU_PREFIX.length);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id.toLowerCase() : null;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Pence to the "12.50" string Shopify wants.
function pounds(minor) { return (Math.round(minor) / 100).toFixed(2); }

// What the shop shows and sells for an item. Used once, when the item
// first goes on sale (Decision 3: after that, Shopify owns the wording).
function productInput(item, brandName, locationId) {
  const condition = CONDITION_LABELS[item.condition] || item.condition || '';
  const parts = [];
  parts.push('<p><strong>Condition:</strong> ' + esc(condition) + '</p>');
  if (item.condition_note) parts.push('<p><strong>Please note:</strong> ' + esc(item.condition_note) + '</p>');
  if (item.description) {
    String(item.description).split(/\n{2,}/).forEach(function (para) {
      if (para.trim()) parts.push('<p>' + esc(para.trim()).replace(/\n/g, '<br>') + '</p>');
    });
  }
  const facts = [];
  if (item.size) facts.push('Size: ' + esc(item.size));
  if (item.colour) facts.push('Colour: ' + esc(item.colour));
  if (facts.length) parts.push('<p>' + facts.join('<br>') + '</p>');
  parts.push('<p>An Outlet piece from ' + esc(brandName) + ', sent to you direct from ' + esc(brandName) + '.</p>');

  const optionName = item.size ? 'Size' : 'Title';
  const optionValue = item.size ? String(item.size).slice(0, 255) : 'Default Title';

  const photos = (Array.isArray(item.photos) ? item.photos : [])
    .filter(function (u) { return typeof u === 'string' && /^https:\/\//i.test(u); })
    .slice(0, 8);

  return {
    title: String(item.title).slice(0, 255),
    descriptionHtml: parts.join('\n'),
    vendor: String(brandName || 'Packet').slice(0, 255),
    productType: CATEGORY_LABELS[item.category] || 'Other',
    tags: ['outlet', 'outlet-' + (item.category || 'other'), 'condition-' + (item.condition || 'unknown')],
    status: shopStatus(item),
    productOptions: [{ name: optionName, position: 1, values: [{ name: optionValue }] }],
    files: photos.map(function (u, i) {
      return { originalSource: u, contentType: 'IMAGE', alt: String(item.title).slice(0, 200) + (i ? ' (' + (i + 1) + ')' : '') };
    }),
    variants: [{
      optionValues: [{ optionName: optionName, name: optionValue }],
      price: pounds(item.sale_minor),
      inventoryPolicy: 'DENY',
      inventoryItem: { sku: skuFor(item.id), tracked: true, requiresShipping: true },
      inventoryQuantities: [{ locationId: locationId, name: 'available', quantity: Math.max(0, item.quantity | 0) }]
    }]
  };
}

// Showing in the shop only while it is on sale and there is some left.
// A sold-out one-off is hidden rather than left up saying "sold out".
function shopStatus(item) {
  return item.status === 'live' && item.quantity > 0 && item.sale_minor ? 'ACTIVE' : 'DRAFT';
}

// Does this item need sending to Shopify?
function needsSync(item) {
  const onShop = !!item.shopify_product_id;
  if (!onShop && item.status !== 'live') return false;          // never listed, nothing to take down
  if (!item.shopify_synced_at) return true;
  return new Date(item.updated_at).getTime() > new Date(item.shopify_synced_at).getTime();
}

// Shopify signs every notification with the app's secret. Anything
// that does not carry a matching signature is thrown away unread.
function verifyHmac(rawBody, headerValue, secret) {
  if (!headerValue || !secret) return false;
  const digest = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
  const a = Buffer.from(digest);
  const b = Buffer.from(String(headerValue));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Turns one paid Shopify order into rows for outlet_orders: one row per
// Outlet line. Lines that are not Outlet items (AW gift sets) are
// ignored — they are AW's job, not a brand's.
function orderRows(order, itemsById) {
  const rows = [];
  const problems = [];
  const ship = order.shipping_address || null;
  (order.line_items || []).forEach(function (li) {
    const itemId = itemIdFromSku(li.sku);
    if (!itemId) return;
    const item = itemsById[itemId];
    if (!item) { problems.push('Order ' + order.name + ': no Outlet item for SKU ' + li.sku); return; }
    if (!ship) { problems.push('Order ' + order.name + ': no delivery address'); return; }

    const qty = Math.max(1, li.quantity | 0);
    const gross = Math.round(parseFloat(li.price || '0') * 100) * qty;
    let discount = 0;
    if (Array.isArray(li.discount_allocations) && li.discount_allocations.length) {
      li.discount_allocations.forEach(function (d) { discount += Math.round(parseFloat(d.amount || '0') * 100); });
    } else if (li.total_discount) {
      discount = Math.round(parseFloat(li.total_discount) * 100);
    }
    const each = Math.max(1, Math.round((gross - discount) / qty));

    const name = [ship.first_name, ship.last_name].filter(Boolean).join(' ') || ship.name || 'Customer';
    rows.push({
      item_id: itemId,
      brand_id: item.brand_id,
      item_title: li.title || item.title,
      order_ref: order.name || ('#' + order.order_number),
      quantity: qty,
      sale_minor: each,
      customer_name: name.slice(0, 200),
      ship_line1: ship.address1 || '',
      ship_line2: ship.address2 || null,
      ship_town: ship.city || '',
      ship_county: ship.province || null,
      ship_postcode: ship.zip || '',
      ship_country: ship.country_code || 'GB',
      customer_phone: ship.phone || order.phone || null,
      is_test: !!order.test,
      shopify_order_id: String(order.id),
      shopify_line_item_id: String(li.id)
    });
  });
  return { rows: rows, problems: problems };
}

function gid(type, id) {
  if (!id) return null;
  return String(id).indexOf('gid://') === 0 ? String(id) : 'gid://shopify/' + type + '/' + id;
}

// "Fern & Thread" -> "fern-and-thread"
function slug(name) {
  return String(name || 'brand').toLowerCase().replace(/&/g, ' and ').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'brand';
}
function brandCollectionInput(brandName, handle) {
  return {
    title: brandName + ' Outlet', handle: handle,
    descriptionHtml: '<p>Returns, end-of-season and sample stock from ' + esc(brandName) + ', at outlet prices. Sent to you direct from ' + esc(brandName) + '.</p>',
    ruleSet: { appliedDisjunctively: false, rules: [
      { column: 'VENDOR', relation: 'EQUALS', condition: String(brandName).slice(0, 255) },
      { column: 'TAG', relation: 'EQUALS', condition: 'outlet' }
    ] }
  };
}

module.exports = {
  slug, brandCollectionInput,
  SKU_PREFIX, skuFor, itemIdFromSku, productInput, shopStatus, needsSync,
  verifyHmac, orderRows, pounds, gid, CONDITION_LABELS
};
