-- ============================================================
-- Packet — Migration 012: Price checks
-- Built from the AXRIK starter kit under licence. Kit v1.1.0.
-- ============================================================
-- Written 7 September 2026, out of Supplier 008.
--
-- Four AppScenic suppliers were checked by hand that day. Three
-- were dead: the platform's cost price sat at or above what the
-- goods already sell for in UK shops. Prowise wanted £15.48 for
-- Irish Sea Moss that the brand's own shop sells at £7.99.
--
-- The check that found this is mechanical and takes two minutes:
-- what does this already sell for in the UK, and is our cost
-- comfortably below it? Doing it by hand does not scale to fifty
-- finds a week, and a check nobody runs is a check that does not
-- exist. So it moves into the database.
--
-- ── WHAT THIS IS NOT ────────────────────────────────────────
-- This is NOT the margin engine and must never be read as one.
-- `gross_pence` here is the crudest possible number: the cheapest
-- UK price found, minus what the platform charges us. It ignores
-- delivery, payment fees, VAT, returns and the cost of buying the
-- customer — which is the number that actually kills dropship
-- lines (see assumed_cpa_pence in sourcing_settings).
--
-- It is a SCREEN, not a verdict. Its whole job is to throw out the
-- obvious losers early so the real engine only ever sees products
-- that could plausibly work. A verdict of 'ok' means "survived the
-- first filter", nothing more.
--
-- ── THE ONE RULE ────────────────────────────────────────────
-- Never store a price that did not come from a fetched page.
-- Every row carries its sources. A check that found nothing is
-- recorded as 'not_found' — an honest gap, which is useful. A
-- guessed price is worse than no price, because it looks like
-- evidence.
--
-- Run order: ... -> 010 -> 011 -> 012.
-- ============================================================


CREATE TABLE IF NOT EXISTS price_checks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  find_id         uuid NOT NULL REFERENCES product_finds(id) ON DELETE CASCADE,
  checked_at      timestamptz NOT NULL DEFAULT now(),

  -- How the price was obtained. 'shopify' is the free, exact route:
  -- a Shopify store publishes /products.json and that is a public
  -- endpoint meant to be read. 'ai' is the fallback web search, and
  -- costs money per check. 'manual' is somebody typing what they saw.
  method          text NOT NULL CHECK (method IN ('shopify','ai','manual')),

  -- The cheapest UK price found, in pence. NULL means nothing was
  -- found, which is recorded rather than hidden.
  uk_lowest_pence int  CHECK (uk_lowest_pence >= 0),
  uk_seller       text,
  uk_url          text,

  -- Our cost restated in GBP. Stored rather than computed on read,
  -- because the exchange rate moves and a margin that silently
  -- changes months later is worse than useless. The rate and its
  -- date are kept alongside for the same reason.
  cost_pence      int CHECK (cost_pence >= 0),
  fx_rate         numeric(12,6),
  fx_as_of        date,

  -- Headline arithmetic only. See the warning above.
  gross_pence     int,
  gross_pct       numeric(6,2),

  --   not_found     nothing to compare against
  --   loss          our cost is at or above the cheapest UK price
  --   below_target  positive, but under sourcing_settings.target_contribution_pct
  --   ok            survived this screen. Not an approval.
  --   unknown       no target set, so no judgement can be made
  verdict         text NOT NULL DEFAULT 'unknown'
                    CHECK (verdict IN ('not_found','loss','below_target','ok','unknown')),

  -- Every seller and price the check actually saw, as
  -- [{ seller, url, price_pence }]. This is the evidence.
  sources         jsonb NOT NULL DEFAULT '[]'::jsonb,

  note            text
);

CREATE INDEX IF NOT EXISTS price_checks_find_idx
  ON price_checks (find_id, checked_at DESC);


-- ── The latest check per find ───────────────────────────────
-- The page wants one row per find, not a history. The history is
-- kept because these prices move and a line that was dead in
-- September may not be in March.
CREATE OR REPLACE VIEW product_find_latest_check AS
SELECT DISTINCT ON (find_id)
  find_id, id AS check_id, checked_at, method,
  uk_lowest_pence, uk_seller, uk_url,
  cost_pence, fx_rate, fx_as_of,
  gross_pence, gross_pct, verdict, sources, note
FROM price_checks
ORDER BY find_id, checked_at DESC;


-- ── Row level security ──────────────────────────────────────
ALTER TABLE price_checks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON price_checks FROM anon;

DROP POLICY IF EXISTS "Staff read price checks" ON price_checks;
CREATE POLICY "Staff read price checks" ON price_checks FOR SELECT
  USING (current_user_role() IN ('owner','staff'));

-- Writes come from the price-check function on the service key,
-- which bypasses RLS. A person typing one in by hand goes through
-- the same path, so there is no INSERT policy here on purpose.

COMMENT ON TABLE price_checks IS
  'A screen, not a margin. gross_pence ignores delivery, fees, VAT, returns and customer acquisition cost. Never store a price that did not come from a fetched page.';
