-- ============================================================
-- Packet — Migration 013: Brands
-- Built from the AXRIK starter kit under licence. Kit v1.1.0.
-- ============================================================
-- Written 20 September 2026, out of Supplier 010.
--
-- Shopify Collective turns out to do, for nothing, the thing we
-- were about to spend four to six weeks building: product feed,
-- stock sync, order routing, fulfilment handoff and supplier
-- payout. It is live in the UK and GBP is supported.
--
-- It also changes what the work IS. A retailer can invite a brand
-- that is not on Collective yet, by email. So Packet is not
-- choosing from whoever signed up — Packet recruits. Brand
-- recruitment is now the whole job, and this table is its pipeline.
--
-- ── WHY THIS IS NOT suppliers, AND NOT product_finds ────────
-- A find (010) is a product somebody saw. A supplier is a trade
-- account that exists, with dispatch times and returns terms, and
-- per packet-do-it-dont-list-it only Phil and Scott can create one.
--
-- A brand here is neither. It is a company we would like to carry
-- and have not yet spoken to. Most rows will never become
-- suppliers. Keeping them apart means the supplier list stays a
-- list of real accounts rather than a list of hopes.
--
-- ── THE TWO GATES COLLECTIVE IMPOSES, AND WHY THEY ARE COLUMNS
--   1. The brand must run on Shopify. Collective reaches no other
--      platform. This is checkable for free and is what
--      brand_checks below is for.
--   2. Retailer and supplier must be in the SAME COUNTRY and the
--      SAME CURRENCY. A GBP Packet store reaches UK brands only.
--      Currency is detectable; country of registration is not, so
--      it is a human field that starts 'unknown' and stays there
--      until somebody looks. An unanswered question shows as a gap.
--
-- ── THE RULE, CARRIED FROM 012 ──────────────────────────────
-- Never store a number that did not come from a fetched page or a
-- brand's own written reply. There is no seeded cost price and no
-- seeded margin here. A plausible margin produces a plausible
-- business case that is fiction.
--
-- Run order: ... -> 011 -> 012 -> 013.
-- ============================================================


-- ── brands ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS brands (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  name              text NOT NULL,

  -- The shop's own front page. NOT NULL because every check in
  -- this file starts from it, and a brand with no website cannot
  -- be on Shopify and therefore cannot be on Collective.
  website           text NOT NULL,

  -- Reuses category_settings, exactly as 010 does, so that a brand
  -- filed under a body-applied category carries requires_uk_rp on
  -- the row instead of losing it to free text.
  category          text REFERENCES category_settings(category),

  instagram_handle  text,

  -- ── The pipeline ──────────────────────────────────────────
  -- Deliberately longer than the finds triage, because the whole
  -- point is to see where recruitment stalls. If twenty brands sit
  -- at 'contacted' and none reach 'replied', the email is wrong,
  -- not the idea.
  --
  -- 'soft_yes' is its own state and matters more than it looks:
  -- sending a real Collective invitation needs a live Shopify
  -- store, which needs the company and the bank account. Having
  -- the conversation does not. Soft yeses are what de-risk the
  -- company formation, so they are counted separately.
  status            text NOT NULL DEFAULT 'candidate'
                      CHECK (status IN ('candidate','contacted','replied',
                                        'soft_yes','invited','connected',
                                        'declined','rejected')),

  -- ── The three human questions the machine cannot answer ────
  -- All three start 'unknown'. None of them defaults to the
  -- convenient answer.

  -- Same-country rule. Registered in the UK and shipping from GB?
  uk_based          text NOT NULL DEFAULT 'unknown'
                      CHECK (uk_based IN ('yes','no','unknown')),

  -- For anything applied to the body: does the brand hold the UK
  -- Responsible Person role for its own goods? Buying from a GB
  -- brand who already holds it is the version that works; own-brand
  -- puts the whole burden on Packet. 'n_a' is for categories where
  -- nothing is applied to the body.
  uk_rp             text NOT NULL DEFAULT 'unknown'
                      CHECK (uk_rp IN ('yes','no','n_a','unknown')),

  -- Is this brand already all over the aggregator catalogues we
  -- have checked? The Kono lesson: margin is not a property of the
  -- product, it is a property of who else is selling it.
  already_resold    text NOT NULL DEFAULT 'unknown'
                      CHECK (already_resold IN ('yes','no','unknown')),

  -- ── What the brand actually offered, if anything ──────────
  -- NULL until a brand states a number in writing. There is no
  -- default and no benchmark. If this is empty the page shows it
  -- empty.
  offered_margin_pct    numeric CHECK (offered_margin_pct >= 0 AND offered_margin_pct <= 100),
  margin_quoted_at      date,
  margin_source         text,   -- 'email from <name>, 4 Oct 2026' — the evidence, in words

  contact_name      text,
  contact_email     text,

  -- How we came across them. 'discovery' is Collective's own
  -- directory, which only lists brands already signed up; every
  -- other route finds the ones it cannot show us, and those are
  -- the ones nobody else is competing for.
  found_via         text
                      CHECK (found_via IN ('discovery','instagram','search','competitor',
                                           'high-street','faire','personal','other')),

  notes             text,

  added_by          uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  added_by_email    text,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS brands_status_idx   ON brands (status);
CREATE INDEX IF NOT EXISTS brands_category_idx ON brands (category);
CREATE INDEX IF NOT EXISTS brands_created_idx  ON brands (created_at DESC);

-- Two people adding brands independently will collide on the
-- obvious names. Same rule as product_finds.
CREATE UNIQUE INDEX IF NOT EXISTS brands_website_idx ON brands (lower(website));


-- ── brand_checks ────────────────────────────────────────────
-- The mechanical half, mirroring price_checks from 012. One
-- request to a shop's own public endpoints answers the question
-- that decides whether a brand is reachable at all.
CREATE TABLE IF NOT EXISTS brand_checks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  brand_id        uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  checked_at      timestamptz NOT NULL DEFAULT now(),

  -- What the shop turned out to be running on.
  --   'shopify'      — /products.json answered. Collective can reach them.
  --   'not_shopify'  — the site answered but is not Shopify. Collective cannot.
  --   'unreachable'  — the site did not answer. Says nothing either way.
  platform        text NOT NULL
                    CHECK (platform IN ('shopify','not_shopify','unreachable')),

  -- Published products at the time of the check. Shopify's public
  -- endpoint pages at 250, so this is "at least this many" on a
  -- big catalogue, and the flag says which.
  product_count   int CHECK (product_count >= 0),
  count_capped    boolean NOT NULL DEFAULT false,

  -- The brand's own retail prices, in minor units. This is what
  -- decides whether a brand is worth approaching at all: Report
  -- 007's arithmetic kills a £22 order, and the last six reports
  -- got stuck on a sub-£8 shelf. A brand whose median product is
  -- £45 is a different proposition.
  --
  -- Median, not mean. One £900 outlier should not make a £12 brand
  -- look like a premium one.
  price_min_minor     int CHECK (price_min_minor >= 0),
  price_median_minor  int CHECK (price_median_minor >= 0),
  price_max_minor     int CHECK (price_max_minor >= 0),

  -- NOT defaulted to GBP — the lesson from 010 is that a price with
  -- an assumed currency is a trap, and here it is worse than a trap
  -- because currency is one of the two things Collective hard-gates
  -- on.
  currency        text CHECK (currency IN ('GBP','USD','EUR','AUD','CAD','other')),

  -- WHICH currency this is, and it is not a detail. Shopify shows a
  -- visitor prices in their own PRESENTMENT currency, which is a
  -- conversion of the shop's real one. A check running from a
  -- Netlify machine in Virginia can therefore be shown dollars by a
  -- Manchester shop.
  --
  -- Collective gates on the SHOP's currency, so only 'shop' is worth
  -- anything here. A theme publishes Shopify.currency = {"active":
  -- "GBP","rate":"1.0"}, and a rate of exactly 1 means no conversion
  -- happened — active IS the shop's own currency. Anything else is
  -- 'presentment' and settles nothing.
  currency_basis  text CHECK (currency_basis IN ('shop','presentment')),

  instagram_found text,

  -- Whether Collective could reach this brand, on this evidence
  -- alone. Deliberately narrow: it means "runs on Shopify and its
  -- OWN currency is GBP", NOT "will say yes" and NOT "is a UK
  -- company", which no endpoint can tell us. A presentment currency
  -- never earns 'reachable' — it is not evidence of the shop's.
  verdict         text NOT NULL DEFAULT 'unknown'
                    CHECK (verdict IN ('reachable','wrong_currency','not_reachable','unknown')),

  -- Every check carries what it read, so it can be re-run and
  -- argued with. Same rule as 012.
  sources         jsonb NOT NULL DEFAULT '[]'::jsonb,
  note            text
);

CREATE INDEX IF NOT EXISTS brand_checks_brand_idx ON brand_checks (brand_id, checked_at DESC);


-- ── The latest check per brand ──────────────────────────────
-- The page wants one row per brand showing its most recent check.
-- Doing this in SQL keeps it out of JavaScript, as with
-- product_find_counts in 010.
CREATE OR REPLACE VIEW brand_latest_check AS
SELECT DISTINCT ON (brand_id)
  brand_id, checked_at, platform, product_count, count_capped,
  price_min_minor, price_median_minor, price_max_minor,
  currency, currency_basis, instagram_found, verdict, note
FROM brand_checks
ORDER BY brand_id, checked_at DESC;


-- ── Pipeline counts ─────────────────────────────────────────
-- What the Brands page shows across the top. The number that
-- matters is soft_yes: ten of those is the evidence that the
-- company formation is worth paying for.
CREATE OR REPLACE VIEW brand_pipeline_counts AS
SELECT
  count(*)                                              AS n_total,
  count(*) FILTER (WHERE status = 'candidate')          AS n_candidate,
  count(*) FILTER (WHERE status = 'contacted')          AS n_contacted,
  count(*) FILTER (WHERE status = 'replied')            AS n_replied,
  count(*) FILTER (WHERE status = 'soft_yes')           AS n_soft_yes,
  count(*) FILTER (WHERE status = 'invited')            AS n_invited,
  count(*) FILTER (WHERE status = 'connected')          AS n_connected,
  count(*) FILTER (WHERE status = 'declined')           AS n_declined,
  count(*) FILTER (WHERE status NOT IN ('rejected','declined')) AS n_live
FROM brands;


-- ── Row level security ──────────────────────────────────────
ALTER TABLE brands       ENABLE ROW LEVEL SECURITY;
ALTER TABLE brand_checks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON brands       FROM anon;
REVOKE ALL ON brand_checks FROM anon;

DROP POLICY IF EXISTS "Staff manage brands" ON brands;
CREATE POLICY "Staff manage brands" ON brands FOR ALL
  USING (current_user_role() IN ('owner','staff'))
  WITH CHECK (current_user_role() IN ('owner','staff'));

-- Checks are written by the function using the service role, which
-- bypasses RLS. Staff read them; nobody edits them by hand, because
-- an edited check is no longer evidence.
DROP POLICY IF EXISTS "Staff read brand checks" ON brand_checks;
CREATE POLICY "Staff read brand checks" ON brand_checks FOR SELECT
  USING (current_user_role() IN ('owner','staff'));


-- ── updated_at ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION brands_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS brands_touch_trg ON brands;
CREATE TRIGGER brands_touch_trg BEFORE UPDATE ON brands
  FOR EACH ROW EXECUTE FUNCTION brands_touch();
