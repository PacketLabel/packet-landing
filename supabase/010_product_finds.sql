-- ============================================================
-- Packet — Migration 010: Product finds
-- Built from the AXRIK starter kit under licence. Kit v1.1.0.
-- ============================================================
-- Written 4 September 2026. This exists because of one argument.
--
-- Supplier 007 was built around a single microfibre cloth — the
-- only verified cost price in the whole project — and Phil pushed
-- back: Packet will sell hundreds of items, and no method that has
-- to be repeated per product is going to work. He is right. The
-- open question is not "which cloth" but whether hundreds of
-- UK-stocked, dropship-able products exist at all, because
-- Catalogue Search 006 searched three platforms for four products
-- and came back with one hit.
--
-- So this table is a shelf-filling exercise, not a sourcing
-- pipeline. Two people, one week, fifty products. Anything either
-- of them sees anywhere — a catalogue, a competitor's shop, a
-- shelf in Home Bargains — goes in with three facts: what it is,
-- what it costs, and where it was seen.
--
-- ── Why this is NOT opportunities ───────────────────────────
-- 005_sourcing.sql already has `opportunities`, and that table is
-- the output of the margin engine: a scored recommendation with a
-- compliance status and an approval gate. Nothing here has been
-- costed, matched, verified or approved, and forcing raw finds
-- into that table would put unpriced guesses next to engine
-- output and make the shortlist untrustworthy. A find is a lead.
-- It becomes an opportunity later, by hand, or it does not.
--
-- ── The three lessons that are baked into the columns ───────
--   1. CURRENCY, from 009. Syncee and AppScenic quote in US
--      dollars. A price with no currency is a trap, so currency is
--      NOT NULL with no default that could be wrong by a quarter.
--
--   2. VAT BASIS, from Supplier 007. The Quotes sheet in the reply
--      tracker ended up mixing ex-VAT trade prices with inc-VAT
--      shelf prices in one column, which makes every margin in it
--      wrong by 20% in an unknown direction. A price on this table
--      must say which it is, and 'unknown' is an allowed and
--      honest answer — it shows as a gap rather than silently
--      calculating.
--
--   3. THE LINK IS THE EVIDENCE. A price with no URL cannot be
--      re-checked, and these prices change without notice. url is
--      NOT NULL for that reason.
--
-- Run order: ... -> 008 -> 009 -> 010.
-- ============================================================


-- ── product_finds ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS product_finds (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  title             text NOT NULL,

  -- Reuses category_settings rather than inventing a second list
  -- of categories. That is deliberate: category_settings carries
  -- requires_uk_rp, so the moment somebody files a find under a
  -- cosmetics category the page can say, on the row, that it needs
  -- a UK Responsible Person. A separate free-text category would
  -- have lost that entirely.
  category          text REFERENCES category_settings(category),

  -- Money in minor units, integer, per the margin engine's rule.
  -- NULLable: "seen it, have not got a price yet" is a real state
  -- and is more useful recorded than left out.
  cost_minor        int CHECK (cost_minor >= 0),
  cost_currency     text NOT NULL DEFAULT 'GBP'
                      CHECK (cost_currency IN ('GBP','USD','EUR')),

  -- See lesson 2 above. No default to 'ex_vat' — assuming is how
  -- the tracker's benchmark column went wrong.
  cost_basis        text NOT NULL DEFAULT 'unknown'
                      CHECK (cost_basis IN ('ex_vat','inc_vat','unknown')),

  -- How many units in the pack the price refers to. Report 007's
  -- pack-size finding: the route past a £20 order is pack size,
  -- not a different product, so a price without a pack quantity
  -- cannot be compared to anything.
  pack_quantity     int CHECK (pack_quantity > 0),

  url               text NOT NULL,

  -- Where it was spotted. Not the supplier — the supplier is
  -- established later, and conflating the two is the mistake
  -- Actions 002 spent a section on.
  seen_at           text
                      CHECK (seen_at IN ('avasam','syncee','appscenic','amazon','ebay',
                                         'competitor','high-street','search','other')),

  notes             text,

  -- Who spotted it. Both are recorded: the id for integrity, the
  -- email because a user row may be tidied up later and "who found
  -- this" should survive that.
  found_by          uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  found_by_email    text,

  -- Triage only. Nothing here approves anything.
  status            text NOT NULL DEFAULT 'new'
                      CHECK (status IN ('new','shortlisted','rejected')),

  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS product_finds_category_idx ON product_finds (category);
CREATE INDEX IF NOT EXISTS product_finds_created_idx  ON product_finds (created_at DESC);

-- The same product found twice from the same page is a duplicate,
-- not two leads. Two people are filling this in independently and
-- will collide.
CREATE UNIQUE INDEX IF NOT EXISTS product_finds_url_idx ON product_finds (lower(url));


-- ── A view that does the counting ───────────────────────────
-- The target is fifty by Friday 11 September 2026 and the page
-- should not have to work that out in JavaScript.
CREATE OR REPLACE VIEW product_find_counts AS
SELECT
  f.category,
  COALESCE(c.label, '(no category)')            AS label,
  COALESCE(c.requires_uk_rp, false)             AS requires_uk_rp,
  count(*)                                      AS n_total,
  count(*) FILTER (WHERE f.status <> 'rejected') AS n_live,
  count(*) FILTER (WHERE f.cost_minor IS NULL)   AS n_no_price
FROM product_finds f
LEFT JOIN category_settings c ON c.category = f.category
GROUP BY f.category, c.label, c.requires_uk_rp;


-- ── Row level security ──────────────────────────────────────
ALTER TABLE product_finds ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON product_finds FROM anon;

DROP POLICY IF EXISTS "Staff manage finds" ON product_finds;
CREATE POLICY "Staff manage finds" ON product_finds FOR ALL
  USING (current_user_role() IN ('owner','staff'))
  WITH CHECK (current_user_role() IN ('owner','staff'));


-- ── Letting staff ADD a category, but not rewrite one ───────
-- 005 made category_settings owner-only, because requires_uk_rp is
-- a compliance control and not a preference. That is right and it
-- stays right for UPDATE and DELETE: nobody should be able to
-- quietly flip an existing cosmetics category to "no Responsible
-- Person needed".
--
-- But this exercise has two people adding lines all week, and if
-- only one of them can create a category the other will file
-- everything under the nearest wrong one, which is worse for
-- compliance than letting them both create categories properly.
--
-- So INSERT opens to staff. The form that calls it forces the
-- body-applied question to be answered before it will save, and
-- shows the Responsible Person consequence on screen at the time.
DROP POLICY IF EXISTS "Staff add categories" ON category_settings;
CREATE POLICY "Staff add categories" ON category_settings FOR INSERT
  WITH CHECK (current_user_role() IN ('owner','staff'));


-- ── Seed: categories for a general household shop ───────────
-- Only added where 005 has no equivalent. These are shelves to
-- fill, not a decision about what Packet sells, and every one of
-- them is requires_uk_rp = false because nothing here is applied
-- to the body. Anything that IS goes under the existing
-- 'beauty-cosmetics' / 'hair-care' categories, which are already
-- flagged true in 005.
INSERT INTO category_settings (category, label, requires_uk_rp, compliance_regime, compliance_note) VALUES
  ('cleaning',    'Cleaning and laundry', false, 'General product safety',
   'Cloths, brushes, refills. Textiles carry fibre composition labelling duties. Anything chemical is a different regime entirely — check before listing.'),
  ('kitchen',     'Kitchen and dining', false, 'General product safety',
   'Food-contact materials have their own rules. Anything mains-powered adds UKCA marking and electrical safety duties.'),
  ('storage',     'Storage and organisation', false, 'General product safety',
   'Low regulatory load. Watch weight and delivery cost on bulky items.'),
  ('stationery',  'Stationery and desk', false, 'General product safety',
   'Low regulatory load.'),
  ('garden',      'Garden and outdoor', false, 'General product safety',
   'Seasonal. Watch delivery cost on anything bulky.'),
  ('laundry-care','Laundry care and airing', false, 'General product safety',
   'Airers, covers, storage. Low regulatory load.')
ON CONFLICT (category) DO NOTHING;
