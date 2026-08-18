-- ============================================================
-- Packet — Migration 005: Sourcing engine
-- Built from the AXRIK starter kit under licence. Kit v1.1.0.
-- ============================================================
-- Watches a list of competitors and a list of suppliers, finds
-- products the competitors sell that our suppliers can actually
-- supply, and ranks them by what Packet would genuinely make.
--
-- It recommends. It never decides and it never publishes. Every
-- row ends up in front of a human who approves or rejects it.
--
-- Run order: 001 -> 002 -> 003 -> 004 -> 005. Depends on
-- set_updated_at() from 001 and current_user_role() from 002.
--
-- ── No invented numbers ─────────────────────────────────────
-- Every commercial rate below starts NULL on purpose: fees,
-- return rates, advertising cost. The engine refuses to score
-- anything until real ones are entered. A plausible-looking
-- default is worse than a blank, because a blank gets filled in
-- and a default gets quoted back as fact in a decision meeting.
--
-- ── A note on where settings live ───────────────────────────
-- The kit convention is app_settings, key/value text. That is
-- right for a promise like discount_terms. It is wrong for
-- arithmetic: money needs typed columns, CHECK constraints and
-- NOT NULL, or a typo becomes a margin. Hence a typed table.
-- ============================================================


-- pg_trgm powers the fuzzy title matching. Exact matching on a
-- barcode is always preferred; this is the fallback for the
-- unbranded goods where no barcode exists.
CREATE EXTENSION IF NOT EXISTS pg_trgm;


-- ── sourcing_settings ───────────────────────────────────────
-- One row. Holds what it costs Packet to sell a thing.
CREATE TABLE IF NOT EXISTS sourcing_settings (
  id                      int PRIMARY KEY DEFAULT 1 CHECK (id = 1),

  -- Whether Packet is VAT registered is a question for the
  -- accountant, not an assumption. NULL means "not yet decided"
  -- and the engine will say so rather than guessing.
  vat_registered          boolean,
  vat_rate                numeric(6,4) CHECK (vat_rate >= 0 AND vat_rate <= 1),

  -- From the actual Shopify plan and payment provider contract.
  payment_fee_pct         numeric(6,4) CHECK (payment_fee_pct >= 0 AND payment_fee_pct <= 1),
  payment_fee_fixed_pence int          CHECK (payment_fee_fixed_pence >= 0),
  platform_fee_pct        numeric(6,4) CHECK (platform_fee_pct >= 0 AND platform_fee_pct <= 1),
  pick_pack_pence         int          CHECK (pick_pack_pence >= 0),

  -- What Packet is willing to accept before a line is worth doing.
  target_contribution_pct numeric(5,2),
  min_contribution_pence  int,

  -- The number that kills most dropship lines. Left NULL the
  -- engine still runs, but reports contribution BEFORE advertising
  -- and marks every row unproven — which is the honest answer.
  assumed_cpa_pence       int CHECK (assumed_cpa_pence >= 0),

  -- Where we sit against the competitor median.
  price_position          text NOT NULL DEFAULT 'match'
                          CHECK (price_position IN ('undercut','match','premium')),
  price_position_pct      numeric(5,2) NOT NULL DEFAULT 0,

  max_candidates_per_category int NOT NULL DEFAULT 5,
  updated_at              timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_sourcing_settings_updated_at ON sourcing_settings;
CREATE TRIGGER trg_sourcing_settings_updated_at
  BEFORE UPDATE ON sourcing_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO sourcing_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;


-- ── category_settings ───────────────────────────────────────
-- Per-category assumptions, and the compliance regime that
-- applies to the category. The compliance columns are the
-- important part: they are what stops the tool shortlisting
-- something Packet cannot lawfully sell.
CREATE TABLE IF NOT EXISTS category_settings (
  category                   text PRIMARY KEY,
  label                      text NOT NULL,

  -- Measured, never guessed. NULL until there is real evidence,
  -- whether from our own orders or from a supplier who will tell
  -- us their rate in writing.
  return_rate                numeric(6,4) CHECK (return_rate >= 0 AND return_rate <= 1),
  return_handling_cost_pence int CHECK (return_handling_cost_pence >= 0),

  -- Cosmetics gate. TRUE means nothing in this category can be
  -- shortlisted unless the supplier already holds the UK
  -- Responsible Person role for it.
  requires_uk_rp             boolean NOT NULL DEFAULT false,
  compliance_regime          text,
  compliance_note            text,

  active                     boolean NOT NULL DEFAULT true
);

-- The low-return shortlist, split so the compliance gate lands on
-- the right things. "Hair" and "beauty" are not single categories:
-- a straightener is an electrical product, a shampoo is a cosmetic,
-- and the two carry completely different obligations. Lumping them
-- together is how a business ends up selling something it has no
-- Responsible Person for.
INSERT INTO category_settings (category, label, requires_uk_rp, compliance_regime, compliance_note) VALUES
  ('pet-accessories',  'Pet — accessories', false, 'General product safety',
   'Leads, bowls, grooming tools. Low regulatory load.'),
  ('pet-consumables',  'Pet — food and treats', false, 'Animal feed',
   'Pet food and treats fall under animal feed rules, which carry their own registration duties. Check with a solicitor before listing.'),
  ('home',             'Home and household', false, 'General product safety',
   'Watch for anything mains-powered, which adds UKCA marking and electrical safety duties.'),
  ('hair-tools',       'Hair — tools and brushes', false, 'General product safety',
   'Brushes and combs are low load. Anything mains-powered adds UKCA marking and electrical safety duties.'),
  ('hair-care',        'Hair — shampoos and treatments', true, 'UK Cosmetics Regulation',
   'Applied to the body. Needs a UK Responsible Person, a safety assessment and product notification. Viable only through a UK supplier who already holds RP; own-brand puts the whole burden on Packet.'),
  ('beauty-tools',     'Beauty — tools', false, 'General product safety',
   'Tweezers, brushes, applicators. Not cosmetics, so no Responsible Person duty.'),
  ('beauty-cosmetics', 'Beauty — cosmetics and skincare', true, 'UK Cosmetics Regulation',
   'Applied to the body. Needs a UK Responsible Person, a safety assessment and product notification. Viable only through a UK supplier who already holds RP; own-brand puts the whole burden on Packet.'),
  ('kids',             'Kids', false, 'Toy safety',
   'Toy safety rules and the highest recall exposure of anything on this list. A considered decision every time, never an automatic shortlist.')
ON CONFLICT (category) DO NOTHING;

COMMENT ON TABLE category_settings IS
  'Compliance notes are input for a solicitor. They are not advice and must not be relied on as such.';


-- ── suppliers ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS suppliers (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                     text NOT NULL UNIQUE,
  website                  text,
  account_ref              text,              -- our trade account number

  -- How we get their catalogue, which decides how far this
  -- supplier can be automated at all:
  --   api    — they have a proper dropship API
  --   feed   — a scheduled CSV/XML drop we can fetch
  --   csv    — a price list we download and import by hand
  --   manual — somebody types it in
  data_source              text NOT NULL DEFAULT 'manual'
                           CHECK (data_source IN ('api','feed','csv','manual')),
  feed_url                 text,
  feed_notes               text,

  -- Fulfilment facts that decide whether they are usable at all.
  -- invoice_in_parcel TRUE means their paperwork goes in the box,
  -- which tells the customer who really shipped it.
  ships_from_country       text DEFAULT 'GB',
  dispatch_days_min        int,
  dispatch_days_max        int,
  unbranded_packaging      boolean,
  invoice_in_parcel        boolean,
  returns_window_days      int,
  returns_address_country  text,
  min_order_value_pence    int,
  carriage_paid_threshold_pence int,

  -- Does this supplier already hold the UK Responsible Person role
  -- for the cosmetics they sell us? Set TRUE only with something in
  -- rp_evidence that would satisfy a trading standards officer.
  is_uk_responsible_person boolean NOT NULL DEFAULT false,
  rp_evidence              text,

  -- Doubles as the sample-order tracker, so the proving work and
  -- the sourcing work live in one place instead of two.
  status                   text NOT NULL DEFAULT 'prospect'
                           CHECK (status IN ('prospect','registered','sample_ordered',
                                             'sample_passed','sample_failed','approved','rejected')),
  sample_ordered_at        date,
  sample_received_at       date,
  sample_notes             text,

  notes                    text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_suppliers_updated_at ON suppliers;
CREATE TRIGGER trg_suppliers_updated_at
  BEFORE UPDATE ON suppliers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON COLUMN suppliers.is_uk_responsible_person IS
  'Gates every cosmetic opportunity. Set TRUE only with evidence recorded in rp_evidence.';


-- ── supplier_products ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS supplier_products (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id         uuid NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,

  sku                 text NOT NULL,
  title               text NOT NULL,
  brand               text,
  mpn                 text,   -- manufacturer part number
  gtin                text,   -- EAN/UPC barcode: the only wholly reliable match key
  description         text,

  category            text REFERENCES category_settings(category),
  supplier_category   text,   -- whatever they happen to call it

  cost_price_pence    int NOT NULL CHECK (cost_price_pence >= 0),  -- trade price ex VAT
  rrp_pence           int,
  delivery_cost_pence int,    -- what they charge us to ship one to a customer
  stock_qty           int,
  in_stock            boolean,

  weight_grams        int,
  ships_from_country  text,

  image_url           text,
  product_url         text,

  first_seen_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  raw                 jsonb,

  UNIQUE (supplier_id, sku)
);

-- Normalised match keys, generated so they can never drift out of
-- step with the columns they come from.
ALTER TABLE supplier_products
  ADD COLUMN IF NOT EXISTS gtin_norm text
  GENERATED ALWAYS AS (NULLIF(regexp_replace(COALESCE(gtin,''), '[^0-9]', '', 'g'), '')) STORED;

ALTER TABLE supplier_products
  ADD COLUMN IF NOT EXISTS brand_mpn_key text
  GENERATED ALWAYS AS (
    NULLIF(lower(regexp_replace(COALESCE(brand,'') || COALESCE(mpn,''), '[^a-zA-Z0-9]', '', 'g')), '')
  ) STORED;

CREATE INDEX IF NOT EXISTS supplier_products_gtin_idx     ON supplier_products (gtin_norm);
CREATE INDEX IF NOT EXISTS supplier_products_brandmpn_idx ON supplier_products (brand_mpn_key);
CREATE INDEX IF NOT EXISTS supplier_products_category_idx ON supplier_products (category);
CREATE INDEX IF NOT EXISTS supplier_products_title_trgm
  ON supplier_products USING gin (lower(title) gin_trgm_ops);


-- ── competitors ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS competitors (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 text NOT NULL UNIQUE,
  website              text NOT NULL,

  -- Shopify stores publish a product feed at /products.json by
  -- default. It is public, it is meant to be read, and it is the
  -- reason Shopify competitors are far easier to watch than anyone
  -- else. Merchants can switch it off; where that happens the
  -- scanner records why and skips, rather than working around it.
  platform             text NOT NULL DEFAULT 'unknown'
                       CHECK (platform IN ('shopify','woocommerce','other','unknown')),
  feed_path            text DEFAULT '/products.json',

  active               boolean NOT NULL DEFAULT true,
  scan_frequency_hours int NOT NULL DEFAULT 168,   -- weekly

  last_scanned_at      timestamptz,
  last_scan_status     text,
  last_scan_error      text,
  products_seen        int NOT NULL DEFAULT 0,

  notes                text,
  created_at           timestamptz NOT NULL DEFAULT now()
);


CREATE TABLE IF NOT EXISTS competitor_products (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competitor_id    uuid NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,

  external_id      text NOT NULL,
  handle           text,
  title            text NOT NULL,
  brand            text,
  sku              text,
  gtin             text,
  product_type     text,
  tags             text[],

  price_pence      int,
  compare_at_pence int,
  available        boolean,

  image_url        text,
  product_url      text,

  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  times_seen       int NOT NULL DEFAULT 1,

  raw              jsonb,

  UNIQUE (competitor_id, external_id)
);

ALTER TABLE competitor_products
  ADD COLUMN IF NOT EXISTS gtin_norm text
  GENERATED ALWAYS AS (NULLIF(regexp_replace(COALESCE(gtin,''), '[^0-9]', '', 'g'), '')) STORED;

ALTER TABLE competitor_products
  ADD COLUMN IF NOT EXISTS brand_mpn_key text
  GENERATED ALWAYS AS (
    NULLIF(lower(regexp_replace(COALESCE(brand,'') || COALESCE(sku,''), '[^a-zA-Z0-9]', '', 'g')), '')
  ) STORED;

-- times_seen is what turns "they stock this" into "they have stocked
-- this every week since June", which is the only demand evidence
-- available. Incrementing it here rather than in the scanner means it
-- cannot be forgotten, and the scanner's upsert stays a plain upsert.
CREATE OR REPLACE FUNCTION bump_times_seen()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.last_seen_at IS DISTINCT FROM OLD.last_seen_at THEN
    NEW.times_seen := OLD.times_seen + 1;
  END IF;
  NEW.first_seen_at := OLD.first_seen_at;   -- never moves
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_competitor_products_seen ON competitor_products;
CREATE TRIGGER trg_competitor_products_seen
  BEFORE UPDATE ON competitor_products
  FOR EACH ROW EXECUTE FUNCTION bump_times_seen();

CREATE INDEX IF NOT EXISTS competitor_products_gtin_idx     ON competitor_products (gtin_norm);
CREATE INDEX IF NOT EXISTS competitor_products_brandmpn_idx ON competitor_products (brand_mpn_key);
CREATE INDEX IF NOT EXISTS competitor_products_seen_idx     ON competitor_products (last_seen_at DESC);
CREATE INDEX IF NOT EXISTS competitor_products_title_trgm
  ON competitor_products USING gin (lower(title) gin_trgm_ops);


-- ── competitor_price_observations ───────────────────────────
-- One row per product per scan. The point is not pretty graphs.
-- Packet has no sales data for anybody, so the only demand signal
-- available is behavioural: a competitor has carried this for
-- months, at a stable price, and it keeps going out of stock.
-- That is weak evidence and the admin page says so out loud.
CREATE TABLE IF NOT EXISTS competitor_price_observations (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  competitor_product_id uuid NOT NULL REFERENCES competitor_products(id) ON DELETE CASCADE,
  price_pence           int,
  available             boolean,
  observed_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cpo_product_time_idx
  ON competitor_price_observations (competitor_product_id, observed_at DESC);


-- ── product_matches ─────────────────────────────────────────
-- "This supplier product and this competitor product are the same
-- thing, or near enough to price against."
--
-- Exact methods (barcode, brand + part number) are trusted on
-- sight. Fuzzy title matches are proposals a human confirms,
-- because on unbranded goods — which is most of the low-return
-- list — a title match means "similar sort of thing", not "the
-- same item". Pricing against the wrong item is how a line ends up
-- underwater without anyone noticing.
CREATE TABLE IF NOT EXISTS product_matches (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_product_id   uuid NOT NULL REFERENCES supplier_products(id) ON DELETE CASCADE,
  competitor_product_id uuid NOT NULL REFERENCES competitor_products(id) ON DELETE CASCADE,

  method                text NOT NULL
                        CHECK (method IN ('gtin','brand_mpn','title_fuzzy','manual')),
  confidence            numeric(4,3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  similarity            numeric(4,3),

  status                text NOT NULL DEFAULT 'proposed'
                        CHECK (status IN ('proposed','confirmed','rejected')),
  reviewed_by           uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at           timestamptz,

  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (supplier_product_id, competitor_product_id)
);

CREATE INDEX IF NOT EXISTS product_matches_status_idx ON product_matches (status);


-- ── matching ────────────────────────────────────────────────
-- Done in the database rather than in the function, because this is
-- a set problem across two large tables and Postgres with a trigram
-- index will always beat looping in Node.
--
-- Three methods, in descending order of how much they can be
-- trusted:
--
--   gtin       same barcode. As certain as it gets. Auto-confirmed.
--   brand_mpn  same brand and part number. Auto-confirmed.
--   title_fuzzy  the titles look alike. A PROPOSAL, nothing more.
--
-- The third one matters most and is trusted least, because the
-- low-return list is mostly unbranded goods with no barcode. On
-- those, a title match means "the same sort of thing", not "the same
-- item", and pricing against the wrong item is how a line ends up
-- underwater with nobody noticing. Fuzzy matches are counted
-- separately so the shortlist can say how much of a recommendation
-- rests on guesswork.
CREATE OR REPLACE FUNCTION build_product_matches(min_similarity real DEFAULT 0.45)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  made integer := 0;
  n    integer;
BEGIN
  -- Same barcode.
  INSERT INTO product_matches (supplier_product_id, competitor_product_id, method, confidence, status)
  SELECT sp.id, cp.id, 'gtin', 0.99, 'confirmed'
    FROM supplier_products sp
    JOIN competitor_products cp ON cp.gtin_norm = sp.gtin_norm
   WHERE sp.gtin_norm IS NOT NULL
  ON CONFLICT (supplier_product_id, competitor_product_id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT; made := made + n;

  -- Same brand and part number.
  INSERT INTO product_matches (supplier_product_id, competitor_product_id, method, confidence, status)
  SELECT sp.id, cp.id, 'brand_mpn', 0.90, 'confirmed'
    FROM supplier_products sp
    JOIN competitor_products cp ON cp.brand_mpn_key = sp.brand_mpn_key
   WHERE sp.brand_mpn_key IS NOT NULL
     AND length(sp.brand_mpn_key) >= 6   -- 'x1' would match half the internet
  ON CONFLICT (supplier_product_id, competitor_product_id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT; made := made + n;

  -- Titles that look alike. Capped at the five closest per product so
  -- one generic word cannot drag in a hundred rows.
  PERFORM set_limit(min_similarity);

  INSERT INTO product_matches (supplier_product_id, competitor_product_id, method, confidence, similarity, status)
  SELECT sp.id, m.cid, 'title_fuzzy', round((m.sim * 0.8)::numeric, 3), round(m.sim::numeric, 3), 'proposed'
    FROM supplier_products sp
    CROSS JOIN LATERAL (
      SELECT cp.id AS cid, similarity(lower(cp.title), lower(sp.title)) AS sim
        FROM competitor_products cp
       WHERE lower(cp.title) % lower(sp.title)
       ORDER BY sim DESC
       LIMIT 5
    ) m
   WHERE m.sim >= min_similarity
  ON CONFLICT (supplier_product_id, competitor_product_id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT; made := made + n;

  RETURN made;
END;
$$;

REVOKE ALL ON FUNCTION build_product_matches(real) FROM PUBLIC, anon;


-- ── sourcing_candidates ─────────────────────────────────────
-- Everything the margin engine needs about one supplier product,
-- with its competitor comparisons gathered up. security_invoker so
-- the caller's RLS applies — a view is otherwise a way round it.
CREATE OR REPLACE VIEW sourcing_candidates
WITH (security_invoker = true) AS
SELECT
  sp.id                       AS supplier_product_id,
  sp.supplier_id,
  sp.title,
  sp.sku,
  sp.category,
  sp.cost_price_pence,
  sp.delivery_cost_pence,
  sp.in_stock,
  sp.product_url,
  sp.image_url,

  s.name                      AS supplier_name,
  s.is_uk_responsible_person,
  s.rp_evidence,
  s.ships_from_country,
  s.status                    AS supplier_status,

  cs.label                    AS category_label,
  cs.requires_uk_rp,
  cs.return_rate,
  cs.return_handling_cost_pence,

  array_agg(cp.price_pence ORDER BY cp.price_pence)
    FILTER (WHERE cp.price_pence IS NOT NULL)          AS competitor_prices,
  count(DISTINCT cp.competitor_id)                     AS n_competitor_stores,
  count(*) FILTER (WHERE pm.method = 'title_fuzzy')    AS fuzzy_matches,
  count(*)                                             AS total_matches,
  count(*) FILTER (WHERE cp.available)                 AS in_stock_elsewhere,
  round(max(extract(epoch FROM (now() - cp.first_seen_at)) / 604800)::numeric, 2) AS weeks_observed

FROM supplier_products sp
JOIN suppliers s          ON s.id = sp.supplier_id
LEFT JOIN category_settings cs ON cs.category = sp.category
JOIN product_matches pm   ON pm.supplier_product_id = sp.id AND pm.status <> 'rejected'
JOIN competitor_products cp ON cp.id = pm.competitor_product_id
GROUP BY sp.id, s.id, cs.category;


-- ── sourcing_runs ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sourcing_runs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at            timestamptz NOT NULL DEFAULT now(),
  finished_at           timestamptz,
  status                text NOT NULL DEFAULT 'running'
                        CHECK (status IN ('running','complete','failed','blocked')),
  blocked_reason        text,
  competitors_scanned   int NOT NULL DEFAULT 0,
  supplier_products     int NOT NULL DEFAULT 0,
  matches_made          int NOT NULL DEFAULT 0,
  opportunities_created int NOT NULL DEFAULT 0,
  error                 text
);


-- ── opportunities ───────────────────────────────────────────
-- The weekly shortlist. One row per recommendation.
CREATE TABLE IF NOT EXISTS opportunities (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                uuid REFERENCES sourcing_runs(id) ON DELETE SET NULL,
  supplier_product_id   uuid NOT NULL REFERENCES supplier_products(id) ON DELETE CASCADE,
  category              text REFERENCES category_settings(category),

  -- What the competitors are doing
  n_competitors           int NOT NULL DEFAULT 0,
  competitor_min_pence    int,
  competitor_median_pence int,
  competitor_max_pence    int,

  -- What we would charge, and what we would keep
  suggested_price_pence        int,
  landed_cost_pence            int,
  fees_pence                   int,
  expected_return_cost_pence   int,
  contribution_pence           int,
  contribution_pct             numeric(6,2),
  contribution_after_ads_pence int,

  -- The weak demand proxy, labelled as weak on the screen
  weeks_observed  numeric(6,2),
  demand_signal   numeric(6,2),
  score           numeric(12,2),

  compliance_status text NOT NULL DEFAULT 'ok'
                    CHECK (compliance_status IN ('ok','blocked','needs_check')),
  compliance_reason text,

  -- How much the numbers above can be trusted. 'unproven' means a
  -- required input was missing — most often the advertising cost.
  data_confidence   text NOT NULL DEFAULT 'unproven'
                    CHECK (data_confidence IN ('unproven','partial','good')),
  confidence_notes  text[],

  -- The human decision. Nothing moves without one.
  status          text NOT NULL DEFAULT 'new'
                  CHECK (status IN ('new','shortlisted','approved','rejected','listed')),
  decided_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  decided_at      timestamptz,
  decision_note   text,

  -- Every number above, itemised, so a recommendation can always be
  -- taken apart and argued with rather than taken on trust.
  breakdown       jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS opportunities_status_idx   ON opportunities (status, score DESC);
CREATE INDEX IF NOT EXISTS opportunities_run_idx      ON opportunities (run_id);
CREATE INDEX IF NOT EXISTS opportunities_category_idx ON opportunities (category);


-- A compliance-blocked opportunity can never be approved. This is
-- enforced here rather than in the page, because the page is the
-- easy thing to change in a hurry and this is the rule that most
-- needs to survive somebody being in a hurry.
CREATE OR REPLACE FUNCTION enforce_compliance_gate()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('approved','listed') AND NEW.compliance_status = 'blocked' THEN
    RAISE EXCEPTION 'Cannot approve a compliance-blocked opportunity: %',
      COALESCE(NEW.compliance_reason, 'no reason recorded');
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.decided_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_opportunities_compliance ON opportunities;
CREATE TRIGGER trg_opportunities_compliance
  BEFORE UPDATE ON opportunities
  FOR EACH ROW EXECUTE FUNCTION enforce_compliance_gate();


-- ── supplier logins ─────────────────────────────────────────
-- 002 reserved the 'supplier' role. A supplier user needs to point
-- at exactly one supplier record so the policies below can scope
-- them to their own rows.
ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS supplier_id uuid REFERENCES suppliers(id) ON DELETE SET NULL;


-- ── Row level security ──────────────────────────────────────
-- Cost prices are the most commercially sensitive data Packet
-- holds. There is deliberately NO anon policy anywhere in this
-- file, and nothing here is reachable from the public site.
ALTER TABLE sourcing_settings             ENABLE ROW LEVEL SECURITY;
ALTER TABLE category_settings             ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppliers                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_products             ENABLE ROW LEVEL SECURITY;
ALTER TABLE competitors                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE competitor_products           ENABLE ROW LEVEL SECURITY;
ALTER TABLE competitor_price_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_matches               ENABLE ROW LEVEL SECURITY;
ALTER TABLE sourcing_runs                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE opportunities                 ENABLE ROW LEVEL SECURITY;

-- Belt and braces, matching 002.
REVOKE ALL ON sourcing_settings             FROM anon;
REVOKE ALL ON category_settings             FROM anon;
REVOKE ALL ON suppliers                     FROM anon;
REVOKE ALL ON supplier_products             FROM anon;
REVOKE ALL ON competitors                   FROM anon;
REVOKE ALL ON competitor_products           FROM anon;
REVOKE ALL ON competitor_price_observations FROM anon;
REVOKE ALL ON product_matches               FROM anon;
REVOKE ALL ON sourcing_runs                 FROM anon;
REVOKE ALL ON opportunities                 FROM anon;

-- Staff run the sourcing work day to day: adding competitors,
-- importing catalogues, shortlisting and rejecting.
DROP POLICY IF EXISTS "Staff read categories"      ON category_settings;
DROP POLICY IF EXISTS "Owner write categories"     ON category_settings;
CREATE POLICY "Staff read categories" ON category_settings FOR SELECT
  USING (current_user_role() IN ('owner','staff'));
-- Owner only. requires_uk_rp is a compliance control, not a preference.
CREATE POLICY "Owner write categories" ON category_settings FOR ALL
  USING (current_user_role() = 'owner') WITH CHECK (current_user_role() = 'owner');

DROP POLICY IF EXISTS "Staff read sourcing settings"  ON sourcing_settings;
DROP POLICY IF EXISTS "Owner write sourcing settings" ON sourcing_settings;
CREATE POLICY "Staff read sourcing settings" ON sourcing_settings FOR SELECT
  USING (current_user_role() IN ('owner','staff'));
-- Owner only. These numbers decide what Packet believes it earns.
CREATE POLICY "Owner write sourcing settings" ON sourcing_settings FOR ALL
  USING (current_user_role() = 'owner') WITH CHECK (current_user_role() = 'owner');

DROP POLICY IF EXISTS "Staff manage suppliers"           ON suppliers;
DROP POLICY IF EXISTS "Staff manage supplier products"   ON supplier_products;
DROP POLICY IF EXISTS "Staff manage competitors"         ON competitors;
DROP POLICY IF EXISTS "Staff manage competitor products" ON competitor_products;
DROP POLICY IF EXISTS "Staff read observations"          ON competitor_price_observations;
DROP POLICY IF EXISTS "Staff manage matches"             ON product_matches;
DROP POLICY IF EXISTS "Staff read runs"                  ON sourcing_runs;
DROP POLICY IF EXISTS "Staff manage opportunities"       ON opportunities;

CREATE POLICY "Staff manage suppliers" ON suppliers FOR ALL
  USING (current_user_role() IN ('owner','staff'))
  WITH CHECK (current_user_role() IN ('owner','staff'));

CREATE POLICY "Staff manage supplier products" ON supplier_products FOR ALL
  USING (current_user_role() IN ('owner','staff'))
  WITH CHECK (current_user_role() IN ('owner','staff'));

CREATE POLICY "Staff manage competitors" ON competitors FOR ALL
  USING (current_user_role() IN ('owner','staff'))
  WITH CHECK (current_user_role() IN ('owner','staff'));

CREATE POLICY "Staff manage competitor products" ON competitor_products FOR ALL
  USING (current_user_role() IN ('owner','staff'))
  WITH CHECK (current_user_role() IN ('owner','staff'));

CREATE POLICY "Staff read observations" ON competitor_price_observations FOR SELECT
  USING (current_user_role() IN ('owner','staff'));

CREATE POLICY "Staff manage matches" ON product_matches FOR ALL
  USING (current_user_role() IN ('owner','staff'))
  WITH CHECK (current_user_role() IN ('owner','staff'));

CREATE POLICY "Staff read runs" ON sourcing_runs FOR SELECT
  USING (current_user_role() IN ('owner','staff'));

CREATE POLICY "Staff manage opportunities" ON opportunities FOR ALL
  USING (current_user_role() IN ('owner','staff'))
  WITH CHECK (current_user_role() IN ('owner','staff'));


-- A supplier signing in sees their own record and their own
-- catalogue, read-only. They never see competitors, matches,
-- opportunities, or what Packet makes on their goods.
DROP POLICY IF EXISTS "Supplier reads own record"    ON suppliers;
DROP POLICY IF EXISTS "Supplier reads own catalogue" ON supplier_products;

CREATE POLICY "Supplier reads own record" ON suppliers FOR SELECT
  USING (
    current_user_role() = 'supplier'
    AND id = (SELECT supplier_id FROM user_profiles WHERE id = auth.uid())
  );

CREATE POLICY "Supplier reads own catalogue" ON supplier_products FOR SELECT
  USING (
    current_user_role() = 'supplier'
    AND supplier_id = (SELECT supplier_id FROM user_profiles WHERE id = auth.uid())
  );


-- ============================================================
-- After running this:
--
-- 1. Open the admin, go to Sourcing -> Settings and fill in every
--    figure. The engine will refuse to score until you do, and
--    that refusal is deliberate.
-- 2. Add your suppliers and mark which hold UK Responsible Person
--    status, with evidence.
-- 3. Add your competitors.
-- 4. Import a supplier price list, or point at a feed.
--
-- Nothing here writes to Shopify. Listing a product stays a
-- manual act until the numbers have been proven.
-- ============================================================
