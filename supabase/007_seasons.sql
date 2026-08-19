-- ============================================================
-- Packet — Migration 007: Seasonal calendar
-- Built from the AXRIK starter kit under licence. Kit v1.1.0.
-- ============================================================
-- Adds a calendar to the sourcing tool so seasonal ranges get
-- decided in time to sell them, rather than noticed in the week
-- they are already too late for.
--
-- It works exactly the way the weekly scan already works — read
-- what competitors are selling, look for gaps, check what our
-- suppliers can supply, price it with the same margin engine.
-- The only new thing is a deadline attached to each row.
--
-- Run order: 001 -> ... -> 006 -> 007. Depends on 005 for
-- suppliers, competitors and opportunities, and on 002 for
-- current_user_role().
--
-- ── What is seeded and what is not ──────────────────────────
-- The DATES are seeded, because they are facts. Halloween is on
-- 31 October whoever you ask, and Mothering Sunday is three
-- Sundays before Easter whoever you ask.
--
-- The LEAD TIMES are not seeded, and that is the same rule that
-- governs every number in this tool. How many weeks a supplier
-- needs, and how early people start buying, are commercial
-- judgements. Left blank the calendar says plainly that it is
-- waiting on you. Filled with a plausible guess it would quietly
-- produce an order-by date that somebody later repeats in a
-- meeting as though it had been checked.
-- ============================================================


-- ── seasons ─────────────────────────────────────────────────
-- One row per selling occasion.
--
-- The date is expressed as a RULE rather than a date, because
-- half of these move. Easter moves; Mothering Sunday moves with
-- it; Black Friday is pinned to an American holiday; Father's Day
-- is the third Sunday in June. A hard-coded date is correct for
-- one year and silently wrong afterwards.
--
--   fixed         event_month + event_day       (Halloween)
--   nth_weekday   month + weekday + nth         (Father's Day)
--   easter_offset days either side of Easter    (Mothering Sunday)
--
-- day_offset shifts any of the above, which is how Black Friday
-- is expressed without a special case: fourth Thursday in
-- November, plus one day.
CREATE TABLE IF NOT EXISTS seasons (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text NOT NULL UNIQUE,
  name          text NOT NULL,

  date_rule     text NOT NULL DEFAULT 'fixed'
                CHECK (date_rule IN ('fixed','nth_weekday','easter_offset')),
  event_month   int CHECK (event_month BETWEEN 1 AND 12),
  event_day     int CHECK (event_day BETWEEN 1 AND 31),
  event_weekday int CHECK (event_weekday BETWEEN 0 AND 6),   -- 0 = Sunday
  event_nth     int CHECK (event_nth BETWEEN -1 AND 5),      -- -1 = last
  day_offset    int NOT NULL DEFAULT 0,

  -- ── The two judgement calls ───────────────────────────────
  -- NULL on purpose. The engine refuses to place a season on the
  -- timeline until both are filled in, and says which is missing.
  --
  -- source_lead_weeks: from committing to an order to having it
  -- ready to ship. Ask a supplier. Do not estimate it.
  --
  -- sell_from_weeks_before: how early people actually start
  -- buying for this occasion. Christmas is months; St Patrick's
  -- Day is days. Nobody can tell you this but the market.
  source_lead_weeks       int CHECK (source_lead_weeks >= 0),
  sell_from_weeks_before  int CHECK (sell_from_weeks_before >= 0),

  -- How long a range is worth leaving up after the day itself.
  -- Zero is a real answer for most; Christmas has a January tail.
  sell_until_days_after   int NOT NULL DEFAULT 0,

  active        boolean NOT NULL DEFAULT true,
  notes         text,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_seasons_updated_at ON seasons;
CREATE TRIGGER trg_seasons_updated_at
  BEFORE UPDATE ON seasons
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON COLUMN seasons.source_lead_weeks IS
  'Blank on purpose. Ask a supplier; never estimate. The calendar refuses to give an order-by date without it.';


-- A rule has to be complete or the row is useless. Enforced here
-- rather than in the page, because the assistant in 008 can also
-- create seasons and it must hit the same wall.
ALTER TABLE seasons DROP CONSTRAINT IF EXISTS seasons_rule_complete;
ALTER TABLE seasons ADD CONSTRAINT seasons_rule_complete CHECK (
  (date_rule = 'fixed'        AND event_month IS NOT NULL AND event_day IS NOT NULL)
  OR
  (date_rule = 'nth_weekday'  AND event_month IS NOT NULL AND event_weekday IS NOT NULL
                              AND event_nth IS NOT NULL)
  OR
  (date_rule = 'easter_offset')
);


-- ── The UK calendar ─────────────────────────────────────────
-- Facts, so they are seeded. Every one of them is switched on but
-- has no lead time, which means the tool will list them and tell
-- you it is waiting on two numbers. That is the intended first
-- screen, not an unfinished one.
--
-- Add, remove or switch off any of these from the admin. This is
-- a starting calendar for a UK shop, not a fixed list.
INSERT INTO seasons (slug, name, date_rule, event_month, event_day, event_weekday, event_nth, day_offset, sell_until_days_after, notes) VALUES
  ('new-year',       'New Year',              'fixed',        1,  1,    NULL, NULL,  0,  7,
   'Resets, organisers, storage, fitness. Sells in the week after Christmas, not before it.'),
  ('valentines',     'Valentine''s Day',      'fixed',        2, 14,    NULL, NULL,  0,  0,
   'Short, sharp window. Gifting and jewellery.'),
  ('mothering-sunday','Mothering Sunday (UK)','easter_offset',NULL, NULL, NULL, NULL, -21, 0,
   'Three weeks before Easter, so it MOVES — mid-March one year, early April the next. Not the American date in May; getting these two mixed up is a classic and costly error for a UK shop.'),
  ('easter',         'Easter',                'easter_offset',NULL, NULL, NULL, NULL,  0,  1,
   'Moves every year. Anything edible brings food law with it — check before listing.'),
  ('st-patricks',    'St Patrick''s Day',     'fixed',        3, 17,    NULL, NULL,  0,  0,
   'Narrow and novelty-led. Accessories and dress-up rather than anything lasting.'),
  ('fathers-day',    'Father''s Day (UK)',    'nth_weekday',  6, NULL,  0,    3,     0,  0,
   'Third Sunday in June.'),
  ('back-to-school', 'Back to school',        'fixed',        9,  1,    NULL, NULL,  0, 14,
   'Buying starts in August. Bags, bottles, labels, organisers.'),
  ('halloween',      'Halloween',             'fixed',       10, 31,    NULL, NULL,  0,  0,
   'Heavily novelty. Watch the compliance side: face paint, nail products and anything else applied to the body are cosmetics, whatever the shop calls them.'),
  ('bonfire-night',  'Bonfire Night',         'fixed',       11,  5,    NULL, NULL,  0,  0,
   'Nothing pyrotechnic. Fireworks are licensed and are not a dropship product.'),
  ('black-friday',   'Black Friday',          'nth_weekday', 11, NULL,  4,    4,     1,  3,
   'Fourth Thursday in November plus one day, because it follows the American holiday. A discounting event rather than a product range — the margin engine will show what a discount actually leaves.'),
  ('christmas',      'Christmas',             'fixed',       12, 25,    NULL, NULL,  0,  7,
   'The one with the longest lead time and the one most often left too late. Gifting, decorations, stocking fillers, wrapping.')
ON CONFLICT (slug) DO NOTHING;

COMMENT ON TABLE seasons IS
  'Dates are seeded because they are facts. Lead times are blank because they are judgements. Do not seed them.';


-- ── How far ahead to look ───────────────────────────────────
-- Operational, not commercial, so unlike the money settings this
-- one gets an honest default: half a year. It only decides how
-- early a season appears on the screen, not what anything is
-- worth. Per the build conventions it lives in the settings table
-- rather than as a constant in the code.
ALTER TABLE sourcing_settings
  ADD COLUMN IF NOT EXISTS seasonal_horizon_weeks int NOT NULL DEFAULT 26
  CHECK (seasonal_horizon_weeks > 0);


-- ── season_terms ────────────────────────────────────────────
-- The words that make a product seasonal. Matched against product
-- titles from both sides — our suppliers' catalogues and the
-- competitors' shelves — which is what lets the gap report say
-- "four shops sell this and none of our suppliers list one".
--
-- Plain word matching on purpose. This decides what appears on a
-- shortlist for a human to read, so a wrong match costs somebody
-- ten seconds. It is not worth an AI call and it must not become
-- one.
CREATE TABLE IF NOT EXISTS season_terms (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id  uuid NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  term       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (season_id, term)
);

CREATE INDEX IF NOT EXISTS season_terms_season_idx ON season_terms (season_id);

-- A starting vocabulary. Words, not numbers, so seeding them
-- breaks no rule — and an empty box would just mean the first
-- screen does nothing. Expect to edit these once you see what the
-- competitors actually call things.
INSERT INTO season_terms (season_id, term)
SELECT s.id, t.term FROM seasons s
JOIN (VALUES
  ('halloween','halloween'),('halloween','pumpkin'),('halloween','spooky'),
  ('halloween','skeleton'),('halloween','witch'),('halloween','fancy dress'),
  ('halloween','trick or treat'),('halloween','ghost'),

  ('christmas','christmas'),('christmas','xmas'),('christmas','advent'),
  ('christmas','stocking filler'),('christmas','bauble'),('christmas','tinsel'),
  ('christmas','santa'),('christmas','festive'),('christmas','gift set'),
  ('christmas','wrapping paper'),('christmas','secret santa'),

  ('st-patricks','st patrick'),('st-patricks','shamrock'),('st-patricks','leprechaun'),
  ('st-patricks','irish'),('st-patricks','clover'),

  ('valentines','valentine'),('valentines','heart'),('valentines','romantic'),
  ('valentines','love'),

  ('mothering-sunday','mother''s day'),('mothering-sunday','mothers day'),
  ('mothering-sunday','mum'),('mothering-sunday','pamper'),

  ('fathers-day','father''s day'),('fathers-day','fathers day'),('fathers-day','dad'),

  ('easter','easter'),('easter','bunny'),('easter','egg hunt'),('easter','chick'),

  ('new-year','new year'),('new-year','organiser'),('new-year','planner'),
  ('new-year','resolution'),

  ('back-to-school','back to school'),('back-to-school','lunch box'),
  ('back-to-school','pencil case'),('back-to-school','school bag'),
  ('back-to-school','water bottle'),

  ('bonfire-night','bonfire'),('bonfire-night','glow stick'),

  ('black-friday','black friday')
) AS t(slug, term) ON t.slug = s.slug
ON CONFLICT (season_id, term) DO NOTHING;


-- ── Seasonal rows on the shortlist ──────────────────────────
-- Seasonal recommendations are ordinary opportunities with a
-- season attached. Same margin engine, same compliance gate, same
-- approve-or-reject decision, same audit of who decided what.
--
-- A parallel table would have meant a second copy of all of that,
-- and a second place for the Responsible Person rule to be
-- forgotten.
ALTER TABLE opportunities
  ADD COLUMN IF NOT EXISTS season_id uuid REFERENCES seasons(id) ON DELETE SET NULL;

ALTER TABLE opportunities
  ADD COLUMN IF NOT EXISTS order_by_date date;

ALTER TABLE opportunities
  ADD COLUMN IF NOT EXISTS season_stage text
  CHECK (season_stage IN ('early','coming_up','act_now','too_late'));

CREATE INDEX IF NOT EXISTS opportunities_season_idx
  ON opportunities (season_id, order_by_date);


-- ── season_gaps ─────────────────────────────────────────────
-- The other half of the question. The shortlist answers "what
-- could we sell for Halloween". This answers "what are four shops
-- selling for Halloween that none of our suppliers can give us" —
-- which is the more useful answer when it is early enough to go
-- and find a supplier.
--
-- Counted, never written. Every figure here comes from pages we
-- have actually read.
CREATE TABLE IF NOT EXISTS season_gaps (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id             uuid REFERENCES sourcing_runs(id) ON DELETE SET NULL,
  season_id          uuid NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,

  term               text NOT NULL,
  -- How many separate competitor shops carry something matching
  -- this term, and how many products between them.
  n_competitor_stores int NOT NULL DEFAULT 0,
  n_competitor_products int NOT NULL DEFAULT 0,
  competitor_median_pence int,
  -- How many of our suppliers' products match it. Zero is the
  -- interesting number.
  n_supplier_products int NOT NULL DEFAULT 0,

  examples           jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS season_gaps_season_idx ON season_gaps (season_id, n_competitor_stores DESC);


-- ── Matching products to seasons ────────────────────────────
-- Views rather than stored tags, so adding a term takes effect
-- immediately and there is no second copy to go stale.
--
-- security_invoker so the caller's RLS still applies. A view is
-- otherwise a way round it, and cost prices are the most
-- commercially sensitive thing Packet holds.
CREATE OR REPLACE VIEW season_supplier_products
WITH (security_invoker = true) AS
SELECT DISTINCT
  s.id  AS season_id,
  s.slug AS season_slug,
  sp.id AS supplier_product_id,
  st.term AS matched_term
FROM seasons s
JOIN season_terms st ON st.season_id = s.id
JOIN supplier_products sp
  ON position(lower(st.term) IN lower(sp.title)) > 0
 WHERE s.active;

CREATE OR REPLACE VIEW season_competitor_products
WITH (security_invoker = true) AS
SELECT DISTINCT
  s.id  AS season_id,
  s.slug AS season_slug,
  cp.id AS competitor_product_id,
  cp.competitor_id,
  cp.price_pence,
  cp.title,
  cp.product_url,
  st.term AS matched_term
FROM seasons s
JOIN season_terms st ON st.season_id = s.id
JOIN competitor_products cp
  ON position(lower(st.term) IN lower(cp.title)) > 0
 WHERE s.active;


-- ── Row level security ──────────────────────────────────────
ALTER TABLE seasons      ENABLE ROW LEVEL SECURITY;
ALTER TABLE season_terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE season_gaps  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON seasons      FROM anon;
REVOKE ALL ON season_terms FROM anon;
REVOKE ALL ON season_gaps  FROM anon;

DROP POLICY IF EXISTS "Staff manage seasons"      ON seasons;
DROP POLICY IF EXISTS "Staff manage season terms" ON season_terms;
DROP POLICY IF EXISTS "Staff read season gaps"    ON season_gaps;

CREATE POLICY "Staff manage seasons" ON seasons FOR ALL
  USING (current_user_role() IN ('owner','staff'))
  WITH CHECK (current_user_role() IN ('owner','staff'));

CREATE POLICY "Staff manage season terms" ON season_terms FOR ALL
  USING (current_user_role() IN ('owner','staff'))
  WITH CHECK (current_user_role() IN ('owner','staff'));

CREATE POLICY "Staff read season gaps" ON season_gaps FOR SELECT
  USING (current_user_role() IN ('owner','staff'));


-- ============================================================
-- After running this:
--
-- 1. Open the admin, Sourcing -> Seasonal. Every season will be
--    listed as waiting on two numbers. That is correct.
-- 2. For the seasons you care about, fill in the sourcing lead
--    time (ask a supplier — do not estimate) and how many weeks
--    before the day you would want to be selling.
-- 3. Check the words under each season against what the
--    competitors actually call things.
--
-- Nothing here writes to Shopify and nothing here approves
-- anything. It produces a dated shortlist and a gap report.
-- ============================================================
