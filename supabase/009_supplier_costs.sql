-- ============================================================
-- Packet — Migration 009: Supplier cost prices, provenance and
--                         the returns position
-- Built from the AXRIK starter kit under licence. Kit v1.1.0.
-- ============================================================
-- Written 2 September 2026, straight after the first real search
-- of the Avasam, Syncee and AppScenic catalogues. Everything here
-- exists because that search found something the schema could not
-- record.
--
-- NO NEW TABLES. 005_sourcing.sql already built `suppliers` and
-- `supplier_products` properly, and they cover most of this. This
-- migration adds the four things they do not cover:
--
--   1. WHERE a supplier came from. Packet reaches suppliers through
--      a platform, and the platform is not the supplier. Without
--      this column "GB010107" is a code with no meaning in six
--      months, and there is no way to answer "can we go direct?".
--
--   2. WHETHER THEY TAKE A NON-FAULTY RETURN. This is the single
--      most important fact about any supplier Packet uses, and it
--      was not recordable. Avasam supplier GB010107's own terms,
--      read on 2 September 2026, say: "this supplier does not
--      accept non-faulty returns... please do not return the goods
--      to Avasam or the Supplier as you will not receive a refund
--      or credit." Packet must still refund the customer in full
--      under the Consumer Contracts Regulations. So a change-of-
--      mind return on that supplier is a 100% loss of goods cost,
--      not a 20% one. The whole business is gated on return rate
--      and the schema could not hold this. Now it can.
--
--   3. CURRENCY. Avasam quotes in £. Syncee and AppScenic both
--      quote in US dollars. cost_price_pence silently assumed GBP,
--      so a dollar price entered into it would have overstated
--      margin by roughly a quarter and nothing would have flagged
--      it. See the note on cost_price_pence below — it is now
--      nullable on purpose.
--
--   4. PRICE VOLATILITY. GB010107's terms also say price changes
--      "pull in real-time... they do not conform to Avasam's
--      standard 3-day price change notification period". A cost
--      price from that supplier is a snapshot, not an agreement.
--
-- Run order: ... -> 008 -> 009.
-- ============================================================


-- ── suppliers: provenance, returns, and how firm the price is ──
ALTER TABLE suppliers
  -- Which catalogue Packet found them through. 'direct' means a
  -- relationship Packet owns, which is the goal for anything that
  -- becomes a real line — a platform sees Packet's volumes and
  -- sells the same goods to every other retailer on it.
  ADD COLUMN IF NOT EXISTS sourcing_platform text
      CHECK (sourcing_platform IN ('avasam','syncee','appscenic','bigbuy',
                                   'cjdropshipping','direct','other')),

  -- Their reference INSIDE that platform, e.g. Avasam's 'GB010107'
  -- or AppScenic's 'GB-2022-977'. Not a company name and not proof
  -- of one — see legal_entity_name.
  ADD COLUMN IF NOT EXISTS platform_supplier_ref text,

  -- The real registered business behind the code, once known.
  -- Deliberately separate: a platform code is not a counterparty.
  ADD COLUMN IF NOT EXISTS legal_entity_name text,
  ADD COLUMN IF NOT EXISTS companies_house_number text,

  -- THE GATE. NULL means nobody has asked yet, which is different
  -- from FALSE. Do not default this to true to make a line look
  -- workable.
  ADD COLUMN IF NOT EXISTS accepts_non_faulty_returns boolean,

  -- Who actually pays to get a returned parcel back. AppScenic's
  -- "Free Returns" filter, per its own tooltip read on 2 September
  -- 2026, means "Supplier will handle the shipping costs for
  -- returns (will provide label or refund costs)" — which is
  -- return SHIPPING, not the goods. Those are different promises
  -- and this column keeps them apart.
  ADD COLUMN IF NOT EXISTS return_shipping_paid_by text
      CHECK (return_shipping_paid_by IN ('supplier','packet','customer','unknown')),

  -- Evidence, verbatim where possible. If a supplier's returns
  -- position ever matters in a dispute, a paraphrase is worthless.
  ADD COLUMN IF NOT EXISTS returns_terms_quote text,
  ADD COLUMN IF NOT EXISTS returns_terms_read_at date,

  -- Days of warning before a cost price moves. 0 = no warning at
  -- all, prices change under you in real time. That is a reason to
  -- set automated pricing rules, not a reason to walk away, but it
  -- must be visible.
  ADD COLUMN IF NOT EXISTS price_change_notice_days int,

  -- How long Packet has to cancel before the order is picked.
  ADD COLUMN IF NOT EXISTS cancellation_window_hours int,

  -- What the platform quotes this supplier's prices in.
  ADD COLUMN IF NOT EXISTS quote_currency text NOT NULL DEFAULT 'GBP'
      CHECK (quote_currency IN ('GBP','EUR','USD'));


-- ── supplier_products: honest money ─────────────────────────
-- cost_price_pence was NOT NULL. It now has to be nullable, and
-- the reason is worth stating rather than hiding in a diff.
--
-- Syncee and AppScenic quote in dollars. Converting a dollar price
-- into pence at whatever rate happened to apply on the day you
-- looked, and then storing only the pence, destroys the evidence
-- and quietly turns an estimate into a fact. Packet's rule is that
-- a figure nobody can source is worse than a gap.
--
-- So: record what the supplier actually said (source_currency +
-- source_price_minor), and fill cost_price_pence ONLY when there
-- is a real rate, captured with a date. Until then it stays NULL
-- and the margin engine skips the line rather than flattering it.
ALTER TABLE supplier_products
  ALTER COLUMN cost_price_pence DROP NOT NULL;

ALTER TABLE supplier_products
  ADD COLUMN IF NOT EXISTS source_currency text NOT NULL DEFAULT 'GBP'
      CHECK (source_currency IN ('GBP','EUR','USD')),

  -- The quoted price in the smallest unit of source_currency:
  -- pence, cents, cents. 1228 = £12.28 or $12.28 depending on
  -- source_currency. Never mix the two.
  ADD COLUMN IF NOT EXISTS source_price_minor int
      CHECK (source_price_minor IS NULL OR source_price_minor >= 0),

  ADD COLUMN IF NOT EXISTS fx_rate_to_gbp numeric(12,6),
  ADD COLUMN IF NOT EXISTS fx_captured_at timestamptz,

  -- Per-product, because on AppScenic it is a product-level flag,
  -- not a supplier-level one.
  ADD COLUMN IF NOT EXISTS free_returns boolean,

  -- Was this price read off the supplier's own product page by a
  -- human or a browser session, or is it inferred from a listing
  -- grid? Grid prices on these platforms are sometimes the
  -- suggested retail, not the cost.
  ADD COLUMN IF NOT EXISTS price_verified_on_product_page boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS price_verified_at timestamptz,

  -- Pack size matters more than unit price for Packet: Report 007
  -- found that the way past the £20 order floor is a bigger pack,
  -- not a different product. Recording it makes per-unit
  -- comparison possible without re-reading the title every time.
  ADD COLUMN IF NOT EXISTS pack_quantity int
      CHECK (pack_quantity IS NULL OR pack_quantity > 0);


-- ── landed cost, computed, never typed ──────────────────────
-- The number the margin engine wants: what one order actually
-- costs Packet, in pence, ex VAT. NULL whenever any input is
-- missing or the price is in a foreign currency with no captured
-- rate — deliberately, so a gap shows as a gap.
CREATE OR REPLACE VIEW supplier_product_costs AS
SELECT
  sp.id,
  sp.supplier_id,
  s.name                      AS supplier_name,
  s.sourcing_platform,
  s.platform_supplier_ref,
  s.ships_from_country,
  s.accepts_non_faulty_returns,
  s.return_shipping_paid_by,
  sp.sku,
  sp.title,
  sp.category,
  sp.pack_quantity,
  sp.source_currency,
  sp.source_price_minor,
  sp.cost_price_pence,
  sp.delivery_cost_pence,
  sp.free_returns,
  sp.price_verified_on_product_page,

  -- Landed cost for one order of one pack.
  CASE
    WHEN sp.cost_price_pence IS NULL THEN NULL
    WHEN sp.delivery_cost_pence IS NULL THEN NULL
    ELSE sp.cost_price_pence + sp.delivery_cost_pence
  END AS landed_cost_pence,

  -- Per-unit inside the pack, for comparing a 50-pack against a
  -- 10-pack without doing it in your head.
  CASE
    WHEN sp.cost_price_pence IS NULL
      OR sp.delivery_cost_pence IS NULL
      OR sp.pack_quantity IS NULL
      OR sp.pack_quantity = 0 THEN NULL
    ELSE round((sp.cost_price_pence + sp.delivery_cost_pence)::numeric
               / sp.pack_quantity, 2)
  END AS landed_cost_per_unit_pence,

  -- Why a line cannot be costed yet. Shown in the admin so the
  -- answer to "why is this blank" is on the screen.
  CASE
    WHEN sp.cost_price_pence IS NOT NULL
     AND sp.delivery_cost_pence IS NOT NULL          THEN NULL
    WHEN sp.source_currency <> 'GBP'
     AND sp.fx_rate_to_gbp IS NULL                   THEN
         'Quoted in ' || sp.source_currency || ' — no exchange rate captured'
    WHEN sp.cost_price_pence IS NULL                 THEN 'No cost price yet'
    WHEN sp.delivery_cost_pence IS NULL              THEN 'No delivery cost yet'
    ELSE NULL
  END AS blocked_reason
FROM supplier_products sp
JOIN suppliers s ON s.id = sp.supplier_id;


-- ── RLS ─────────────────────────────────────────────────────
-- suppliers and supplier_products already have policies from 005.
-- The view inherits the underlying tables' RLS, so nothing new is
-- needed here — noted explicitly so the next person does not go
-- looking for a missing policy.


-- ── what the 2 September 2026 search actually found ─────────
-- Seeded because it is evidence, not illustration. Every figure
-- below was read from the platform on that date. Where a price
-- could not be verified on the product page itself, cost is left
-- NULL rather than guessed.

INSERT INTO suppliers
  (name, website, sourcing_platform, platform_supplier_ref, ships_from_country,
   data_source, dispatch_days_min, dispatch_days_max, quote_currency,
   accepts_non_faulty_returns, return_shipping_paid_by,
   price_change_notice_days, cancellation_window_hours,
   returns_terms_read_at, returns_terms_quote, status, notes)
VALUES
  ('Avasam GB010107', 'https://app.avasam.com', 'avasam', 'GB010107', 'GB',
   'manual', 3, 4, 'GBP',
   false, 'packet',
   0, 2,
   DATE '2026-09-02',
   'This supplier does not accept non-faulty returns, so please do not return the goods to Avasam or the Supplier as you will not receive a refund or credit. You may request that the customer returns the goods to you to resell or dispose of them as you see fit.',
   'prospect',
   'Found 2 Sep 2026. Only Avasam UK-stocked supplier carrying anything on the shortlist. '
   'Tracked 3-5 day UK shipping only, no international. Restricted UK postcodes apply. '
   'Prices change in real time with no notice period — automated pricing rules are not '
   'optional with this supplier. Legal entity not yet established.'),

  ('Avasam GB010109', 'https://app.avasam.com', 'avasam', 'GB010109', 'GB',
   'manual', 3, 4, 'GBP',
   NULL, 'unknown',
   NULL, NULL,
   NULL, NULL,
   'prospect',
   'Found 2 Sep 2026. Carries a 3-piece nail clipper / tweezer / eyelash curler set at '
   'GBP 4.49 with free UK shipping. Adjacent to the tweezers line but a multi-tool set, '
   'not slant-tip brow tweezers. Returns position not yet read.'),

  ('IGAD', NULL, 'syncee', NULL, 'GB',
   'manual', NULL, NULL, 'USD',
   NULL, 'unknown',
   NULL, NULL,
   NULL, NULL,
   'prospect',
   'Found 2 Sep 2026 on Syncee, UK supplier location. Microfiber cloth sets and window '
   'cleaning kits. Syncee quotes in US dollars. Real UK supplier worth approaching directly.'),

  ('Jungle Culture', NULL, 'syncee', NULL, 'GB',
   'manual', NULL, NULL, 'USD',
   NULL, 'unknown',
   NULL, NULL,
   NULL, NULL,
   'prospect',
   'Found 2 Sep 2026 on Syncee, UK supplier location. All-purpose natural kitchen dish '
   'cloths. Quoted in US dollars.'),

  ('Tormino', NULL, 'syncee', NULL, NULL,
   'manual', NULL, NULL, 'USD',
   NULL, 'unknown',
   NULL, NULL,
   NULL, NULL,
   'rejected',
   'Found 2 Sep 2026. Carries the genuine BRITA Maxtra Pro range — the rank-2 shortlist '
   'line — including 6 and 12 packs, plus compatibles. REJECTED for now on one ground: '
   'filtering Syncee to UK supplier location removes every Tormino product, so Tormino is '
   'not UK-based. That puts Packet back into the cross-border customs position that ruled '
   'out BigBuy. Revisit only if Tormino confirms UK stock or DDP delivery in writing.')
ON CONFLICT (name) DO NOTHING;


-- The one product whose cost was verified on the product page
-- itself rather than read off a results grid.
INSERT INTO supplier_products
  (supplier_id, sku, title, mpn, category, supplier_category,
   source_currency, source_price_minor, cost_price_pence, delivery_cost_pence,
   pack_quantity, stock_qty, in_stock, ships_from_country,
   free_returns, price_verified_on_product_page, price_verified_at,
   product_url, raw)
SELECT
  s.id,
  'S0672144346',
  '50X Large Microfibre Cleaning Cloths 30x30cm',
  'C2604290017',
  NULL,
  'Cleaning',
  'GBP',
  1228,                    -- GBP 12.28 as quoted
  1228,                    -- same figure: already sterling, ex VAT
  0,                       -- free UK delivery, stated on the product page
  50,
  40,
  true,
  'GB',
  false,                   -- supplier refuses non-faulty returns
  true,
  TIMESTAMPTZ '2026-09-02 21:00:00+01',
  'https://app.avasam.com/seller/products/S0672144346',
  jsonb_build_object(
    'read_on', '2026-09-02',
    'composition', '80% polyester / 20% polyamide',
    'size_cm', '30x30',
    'dispatch', '3-4 days, tracked, free',
    'platform_note', 'not permitted on Amazon, see Product PDF',
    'uk_retail_benchmark',
      'Dunelm pack of 10 at GBP 5.00 verified 25 Aug 2026 = 50p per cloth. '
      'This pack is 24.56p per cloth landed. Benchmark is inc VAT, cost is ex VAT — '
      'do not treat the gap as margin until that is reconciled.'
  )
FROM suppliers s
WHERE s.name = 'Avasam GB010107'
ON CONFLICT (supplier_id, sku) DO NOTHING;


-- ── settings ────────────────────────────────────────────────
-- Operational values belong here, not in a constant in a page.
INSERT INTO app_settings (key, value, note, is_public) VALUES
  ('cost_price_max_age_days', '30',
   'A supplier cost price older than this is shown as stale in the admin. Avasam supplier '
   'GB010107 changes prices in real time with no notice, so an old figure is not a price.',
   false),
  ('fx_rate_required', 'true',
   'When true, a product quoted in a non-GBP currency cannot produce a margin verdict until '
   'an exchange rate has been captured against it. Stops a dollar price being read as sterling.',
   false)
ON CONFLICT (key) DO NOTHING;


-- ============================================================
-- After running this, expect:
--   • 5 rows in suppliers (4 prospects, 1 rejected)
--   • 1 row in supplier_products, fully costed
--   • supplier_product_costs returning that row with
--     landed_cost_pence = 1228 and landed_cost_per_unit_pence = 24.56
--
-- What is deliberately NOT here: any figure from Syncee or
-- AppScenic. Both quote in US dollars and no exchange rate has
-- been captured, so entering them would mean inventing a rate.
-- The columns to hold them exist; the numbers wait for a rate.
-- ============================================================
