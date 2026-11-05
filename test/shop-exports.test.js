// Packet — reading a shop's own product export (any platform)
// Run: node test/shop-exports.test.js
var O = require('../admin/packet-outlet.js');
var pass = 0, fail = 0;
function check(n, a, e) { var ok = JSON.stringify(a) === JSON.stringify(e); ok ? pass++ : fail++; console.log((ok ? '  PASS  ' : '  FAIL  ') + n + (ok ? '' : '\n        expected ' + JSON.stringify(e) + '\n        got      ' + JSON.stringify(a))); }
var opts = { default_condition: 'returned_as_new', lowest_pct: 50, default_category: 'clothing' };
function brief(res) { return res.items.map(function (i) { return [i.title, i.size || '', i.colour || '', i.quantity, i.rrp_minor, i.floor_minor, i.brand_sku, i.category, i.photos.length]; }); }

console.log('Shopify export');
var shopify = [
  'Handle,Title,Body (HTML),Vendor,Product Category,Type,Tags,Published,Option1 Name,Option1 Value,Option2 Name,Option2 Value,Variant SKU,Variant Inventory Qty,Variant Price,Variant Compare At Price,Image Src,Status',
  'wrap-dress,Wrap dress,<p>Jersey <b>wrap</b>.</p>,Fern,Apparel,Dresses,,TRUE,Size,10,Colour,Rust,WD-10-R,3,55.00,75.00,https://cdn.shopify.com/a.jpg,active',
  'wrap-dress,,,,,,,,,12,,Rust,WD-12-R,0,55.00,75.00,https://cdn.shopify.com/b.jpg,',
  'wrap-dress,,,,,,,,,,,,,,,,https://cdn.shopify.com/c.jpg,',
  'old-coat,Old coat,,,,Coats,,FALSE,Title,Default Title,,,OC-1,1,90.00,,,archived'
].join('\n');
var r = O.rowsFromCSV(shopify, opts);
check('read as Shopify, no problems', [r.format, r.problems], ['shopify', []]);
check('one item per size, compare-at as normal price, archived left out', brief(r),
  [['Wrap dress', '10', 'Rust', 3, 7500, 3750, 'WD-10-R', 'clothing', 3], ['Wrap dress', '12', 'Rust', 0, 7500, 3750, 'WD-12-R', 'clothing', 3]]);
check('description has no HTML', r.items[0].description, 'Jersey wrap.');
check('condition from the chosen default', r.items[0].condition, 'returned_as_new');
check('without defaults, the brand is asked for them', O.rowsFromCSV(shopify).problems[0], 'There is no "lowest_price" column — the lowest price you will accept.');

console.log('WooCommerce export');
var woo = [
  'ID,Type,SKU,Name,Published,Short description,Description,In stock?,Stock,Sale price,Regular price,Categories,Tags,Images,Parent,Attribute 1 name,Attribute 1 value(s)',
  '10,simple,LS-1,Linen shirt,1,,<p>Washed linen.</p>,1,2,40,60,Shirts,,"https://shop.example/a.jpg, https://shop.example/b.jpg",,,',
  '20,variable,CT,Cord trousers,1,Needlecord.,,1,,,80,Trousers,,https://shop.example/c.jpg,,Size,"10, 12"',
  '21,variation,CT-10,Cord trousers - 10,1,,,1,1,,80,,,,CT,Size,10',
  '22,variation,CT-12,Cord trousers - 12,1,,,0,,,80,,,,id:20,Size,12'
].join('\n');
r = O.rowsFromCSV(woo, opts);
check('read as WooCommerce', [r.format, r.problems], ['woocommerce', []]);
check('simple and variations, parent details carried', brief(r),
  [['Linen shirt', '', '', 2, 6000, 3000, 'LS-1', 'clothing', 2], ['Cord trousers', '10', '', 1, 8000, 4000, 'CT-10', 'clothing', 1], ['Cord trousers', '12', '', 0, 8000, 4000, 'CT-12', 'clothing', 1]]);

console.log('Wix export');
var wix = [
  'handleId,fieldType,name,description,productImageUrl,collection,sku,price,surcharge,visible,inventory,productOptionName1,productOptionType1,productOptionDescription1',
  'p1,Product,Silk scarf,<p>Hand-rolled.</p>,https://static.wixstatic.com/s.jpg,Accessories,SC-1,45,,true,InStock,,,',
  'p2,Product,Merino jumper,,https://static.wixstatic.com/j.jpg,Knitwear,,70,,true,,Size,DROP_DOWN,S;M',
  'p2,Variant,,,,,MJ-S,,,true,4,,,S',
  'p2,Variant,,,,,MJ-M,,5,true,OutOfStock,,,M'
].join('\n');
r = O.rowsFromCSV(wix, Object.assign({ default_quantity: 1 }, opts));
check('read as Wix', [r.format, r.problems], ['wix', []]);
check('variants with surcharge; a plain product is one item', brief(r),
  [['Silk scarf', '', '', 1, 4500, 2250, 'SC-1', 'accessories', 1], ['Merino jumper', 'S', '', 4, 7000, 3500, 'MJ-S', 'clothing', 1], ['Merino jumper', 'M', '', 0, 7500, 3750, 'MJ-M', 'clothing', 1]]);

console.log('Squarespace export');
var sq = [
  'Product ID [Non Editable],Variant ID [Non Editable],Product Type [Non Editable],Product Page,Product URL,Title,Description,SKU,Option Name 1,Option Value 1,Price,Sale Price,On Sale,Stock,Categories,Tags,Visible,Hosted Image URLs',
  'a1,v1,PHYSICAL,shop,linen-dress,Linen dress,Breezy.,LD-S,Size,S,95,60,Yes,2,Dresses,,Yes,https://images.squarespace-cdn.com/1.jpg https://images.squarespace-cdn.com/2.jpg',
  'a1,v2,,,,,,LD-M,,M,95,60,Yes,Unlimited,,,,'
].join('\n');
r = O.rowsFromCSV(sq, opts);
check('read as Squarespace', [r.format, r.problems], ['squarespace', []]);
check('options per row, unlimited stock becomes the default', brief(r),
  [['Linen dress', 'S', '', 2, 9500, 4750, 'LD-S', 'clothing', 2], ['Linen dress', 'M', '', 1, 9500, 4750, 'LD-M', 'clothing', 2]]);

console.log('Etsy export');
var etsy = 'TITLE,DESCRIPTION,PRICE,CURRENCY_CODE,QUANTITY,TAGS,IMAGE1,IMAGE2,VARIATION 1 TYPE,SKU\n' +
  'Silver ring,Hammered.,32.00,GBP,5,"ring,silver",https://i.etsystatic.com/1.jpg,,,SR-1\n';
r = O.rowsFromCSV(etsy, opts);
check('read as Etsy', [r.format, brief(r)], ['etsy', [['Silver ring', '', '', 5, 3200, 1600, 'SR-1', 'jewellery', 1]]]);
r = O.rowsFromCSV(etsy.replace('GBP', 'USD'), opts);
check('a shop priced in another currency is refused', [r.items.length, /priced in USD/.test(r.problems[0])], [0, true]);

console.log('BigCommerce export');
var bc = 'Item Type,Product ID,Product Name,Product Type,Product Code/SKU,Product Description,Price,Retail Price,Sale Price,Current Stock Level,Category,Product Image URL - 1\n' +
  'Product,5,Canvas tote,P,CT-1,<p>Heavy canvas.</p>,25,30,,8,Bags,https://cdn11.bigcommerce.com/t.jpg\n' +
  'SKU,,[S]Colour=Black,,CT-1-B,,,,,4,,\n';
r = O.rowsFromCSV(bc, opts);
check('read as BigCommerce, product rows', [r.format, brief(r)], ['bigcommerce', [['Canvas tote', '', '', 8, 3000, 1500, 'CT-1', 'accessories', 1]]]);

console.log('Tab-separated, and Packet\'s own sheet still works');
check('tabs', O.parseCSV('a\tb\n1\t2\n'), [['a', 'b'], ['1', '2']]);
check('Packet template unchanged', [O.rowsFromCSV(O.csvTemplate()).format, O.rowsFromCSV(O.csvTemplate()).items.length], [null, 1]);
check('a loose sheet with defaults needs no condition column',
  O.rowsFromCSV('Name,RRP,Qty\nBoots,80,2\n', { default_condition: 'new_with_tags', lowest_pct: 60 }).items.map(function (i) { return [i.condition, i.floor_minor]; }), [['new_with_tags', 4800]]);

console.log('Re-uploading the same export updates, never duplicates');
var first = O.rowsFromCSV(shopify, opts).items;
var have = first.map(function (i, n) { return Object.assign({ id: 'x' + n, status: 'submitted' }, i); });
var plan = O.planUpload(O.rowsFromCSV(shopify, opts).items, have, true);
check('no new items second time', [plan.adds.length, plan.updates.length], [0, 2]);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
