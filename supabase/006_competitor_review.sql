-- ============================================================
-- Packet — Migration 006: Competitor review
-- Built from the AXRIK starter kit under licence. Kit v1.1.0.
-- ============================================================
-- Looks at how each competitor actually operates — range, prices,
-- delivery terms, returns promise, how fast they add products,
-- what keeps selling out — and writes it up so both owners can
-- read the same picture in the admin.
--
-- Run order: 001 -> 002 -> 003 -> 004 -> 005 -> 006.
-- Depends on 005 for competitors and competitor_products.
--
-- ── The split that matters ──────────────────────────────────
-- Everything in the fact columns is COUNTED, in ordinary code,
-- from pages we have actually read. Only `summary` is written by
-- AI, and only about those facts.
--
-- Strategy writing is the easiest place in this whole system for
-- an AI to produce confident nonsense — "focus on customer
-- experience" reads like insight and means nothing. Keeping the
-- numbers out of its hands means a wrong write-up is visibly
-- wrong, because the facts are sitting next to it.
--
-- If the AI is unavailable the facts still appear. ai_used says
-- which you are looking at.
-- ============================================================


-- ── competitor_profiles ─────────────────────────────────────
-- One row per competitor per review. Kept rather than replaced,
-- so "they have added 60 products since September" is answerable.
CREATE TABLE IF NOT EXISTS competitor_profiles (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competitor_id         uuid NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
  reviewed_at           timestamptz NOT NULL DEFAULT now(),

  -- Range
  product_count         int,
  new_products_30d      int,
  gone_products_30d     int,     -- delisted: they stopped selling it
  out_of_stock_count    int,

  -- Prices, in pence, from what they actually charge
  price_min_pence       int,
  price_median_pence    int,
  price_max_pence       int,
  price_bands           jsonb,   -- how many products in each band

  -- Discounting
  discounted_count      int,
  median_discount_pct   numeric(5,2),

  -- What they sell, their own naming
  categories            jsonb,

  -- Terms, read off their policy pages
  delivery_cost_pence   int,
  delivery_free_over_pence int,
  delivery_note         text,
  returns_days          int,
  returns_note          text,
  pages_read            jsonb,

  -- The written interpretation. AI, and only about the above.
  summary               text,
  ai_used               boolean NOT NULL DEFAULT false,

  facts                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS competitor_profiles_latest_idx
  ON competitor_profiles (competitor_id, reviewed_at DESC);

COMMENT ON COLUMN competitor_profiles.summary IS
  'AI-written, about the counted facts in this row only. Never a source of numbers.';


-- ── market_reviews ──────────────────────────────────────────
-- The across-everybody view: where they all cluster, and what
-- none of them is doing. The gap list is the point of this table.
CREATE TABLE IF NOT EXISTS market_reviews (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reviewed_at        timestamptz NOT NULL DEFAULT now(),
  competitors_count  int,

  -- Counted
  price_bands        jsonb,   -- combined, so an empty band is visible
  category_coverage  jsonb,   -- how many of them cover each category
  delivery_summary   jsonb,   -- what each charges and their free-delivery level
  returns_summary    jsonb,

  -- Written
  summary            text,
  gaps               text[],  -- what none of them does
  ai_used            boolean NOT NULL DEFAULT false,

  facts              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS market_reviews_latest_idx ON market_reviews (reviewed_at DESC);


-- ── Row level security ──────────────────────────────────────
ALTER TABLE competitor_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE market_reviews      ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON competitor_profiles FROM anon;
REVOKE ALL ON market_reviews      FROM anon;

DROP POLICY IF EXISTS "Staff read competitor profiles" ON competitor_profiles;
DROP POLICY IF EXISTS "Staff read market reviews"      ON market_reviews;

CREATE POLICY "Staff read competitor profiles" ON competitor_profiles FOR SELECT
  USING (current_user_role() IN ('owner','staff'));

CREATE POLICY "Staff read market reviews" ON market_reviews FOR SELECT
  USING (current_user_role() IN ('owner','staff'));


-- ── latest_competitor_review ────────────────────────────────
-- The most recent profile per competitor, with the previous one's
-- range size alongside so the admin can show movement without
-- doing sums in the page.
CREATE OR REPLACE VIEW latest_competitor_review
WITH (security_invoker = true) AS
SELECT DISTINCT ON (p.competitor_id)
  p.*,
  c.name    AS competitor_name,
  c.website AS competitor_website,
  c.platform,
  LAG(p.product_count) OVER (PARTITION BY p.competitor_id ORDER BY p.reviewed_at) AS previous_product_count
FROM competitor_profiles p
JOIN competitors c ON c.id = p.competitor_id
ORDER BY p.competitor_id, p.reviewed_at DESC;


-- ============================================================
-- After running this, the Competitor review section appears
-- under Sourcing. It fills in on the next weekly run, or press
-- "Review them now".
--
-- What it cannot see: their sales, profit, advertising spend,
-- visitor numbers or who supplies them. All private. It reports
-- what they DO, never how well they are doing.
-- ============================================================
